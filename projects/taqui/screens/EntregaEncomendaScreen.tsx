/**
 * EntregaEncomendaScreen — tela independente para registrar entrega de encomenda.
 *
 * Fluxo:
 * 1. Selecionar encomenda com status 'pronta_retirada' (confirmada pelo morador)
 * 2. Exibir dados da encomenda + foto
 * 3. Formulário de evidência de quem retirou:
 *    - funcionário responsável (select automático para portaria)
 *    - nome do recebedor (obrigatório, min 3 chars)
 *    - documento de identificação (opcional)
 *    - vínculo com o morador (select)
 *    - foto do comprovante (URL opcional)
 *    - observações (opcional)
 * 4. Chamada PUT /api/{slug}/encomendas/:id/entregar com evidência estruturada JSON
 * 5. Ao sucesso: voltar ao painel de listagem com feedback visual
 *
 * Regras de autorização:
 * - Visível apenas para perfil operador/portaria (config.ts roleFilter)
 * - Backend bloqueia entrega se status != 'pronta_retirada' ou condominio diferente
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import {
  CheckCircleRounded,
  Inventory2Rounded,
  LocalShippingRounded,
  WarningAmberRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

// ============================================================================
// TIPOS
// ============================================================================

type RecebedorVinculo =
  | "proprio_morador"
  | "familiar"
  | "empregado"
  | "terceiro"

interface Funcionario {
  id: number
  nome: string
  funcao: "triagem" | "portaria" | "ambos"
}

interface EncomendaSelecao {
  id: number
  status: "pendente" | "pronta_retirada" | "entregue" | "cancelada"
  codigoRastreamento: string | null
  fotoUrl: string | null
  unidadeLabel: string | null
  transportadoraNome: string | null
  chegadaEm: string
}

interface EncomendaDetalhe {
  id: number
  status: "pendente" | "pronta_retirada" | "entregue" | "cancelada"
  fotoUrl: string | null
  codigoRastreamento: string | null
  observacoes: string | null
  chegadaEm: string
  unidade: {
    label: string | null
    tipo: "apartamento" | "casa"
    rua: string | null
    bloco: string | null
    andar: number | null
    numero: string | null
  }
  moradores: Array<{
    id: number
    nome: string
    telefone: string | null
  }>
  transportadora: { nome: string } | null
  registradoPor: { nome: string }
}

// ============================================================================
// HELPERS
// ============================================================================

function statusLabel(status: EncomendaSelecao["status"]): string {
  const labels: Record<string, string> = {
    pendente: "Aguardando confirmação",
    pronta_retirada: "Pronta para retirada",
    entregue: "Entregue",
    cancelada: "Cancelada",
  }
  return labels[status] ?? status
}

function formatarDataHora(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(d)
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function EntregaEncomendaScreen(): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()

  // Listagem para seleção
  const [encomendas, setEncomendas] = useState<EncomendaSelecao[]>([])
  const [carregandoListagem, setCarregandoListagem] = useState(true)
  const [erroListagem, setErroListagem] = useState<string | null>(null)

  // Seleção
  const [encomendaSelecionada, setEncomendaSelecionada] = useState<EncomendaDetalhe | null>(null)
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false)

  // Funcionários para select
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([])

  // Formulário
  const [funcionarioId, setFuncionarioId] = useState<number | "">("")
  const [recebedorNome, setRecebedorNome] = useState("")
  const [recebedorDocumento, setRecebedorDocumento] = useState("")
  const [recebedorVinculo, setRecebedorVinculo] = useState<RecebedorVinculo | "">("")
  const [fotoComprovanteUrl, setFotoComprovanteUrl] = useState("")
  const [observacoesEntrega, setObservacoesEntrega] = useState("")

  // Estados de ação
  const [confirmando, setConfirmando] = useState(false)
  const [mostrarConfirmacao, setMostrarConfirmacao] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [erroAcao, setErroAcao] = useState<string | null>(null)

  // =========================================================================
  // CARREGAR LISTAGEM (apenas prontas para retirada)
  // =========================================================================

  useEffect(() => {
    let cancelled = false

    async function carregarListagem() {
      const currentBundle = bundle
      const currentProjeto = projeto
      if (!currentBundle || !currentProjeto) return
      setCarregandoListagem(true)
      setErroListagem(null)
      try {
        const result = await currentBundle.http.request<{ items: EncomendaSelecao[] }>(
          "GET",
          `/${currentProjeto.slug}/painel-portaria/encomendas`,
          { query: { status: "pronta_retirada" }, auth: "access" },
        )
        if (!cancelled) setEncomendas(result.items ?? [])
      } catch (err) {
        if (!cancelled) {
          setErroListagem(
            err instanceof Error ? err.message : "Não foi possível carregar as encomendas.",
          )
        }
      } finally {
        if (!cancelled) setCarregandoListagem(false)
      }
    }

    void carregarListagem()
    return () => { cancelled = true }
  }, [bundle, projeto])

  // =========================================================================
  // CARREGAR FUNCIONÁRIOS
  // =========================================================================

  useEffect(() => {
    let cancelled = false
    const currentBundle = bundle
    const currentProjeto = projeto
    if (!currentBundle || !currentProjeto) return

    async function carregarFuncionarios() {
      const b = bundle!
      const p = projeto!
      try {
        const result = await b.http.request<{ items: Funcionario[] }>(
          "GET",
          `/${p.slug}/funcionarios`,
          { query: { pageSize: 200 }, auth: "access" },
        )
        if (!cancelled) {
          setFuncionarios(
            (result.items ?? []).filter(
              (f: Funcionario) => f.funcao === "portaria" || f.funcao === "ambos",
            ),
          )
        }
      } catch {
        // Silencioso
      }
    }

    void carregarFuncionarios()
    return () => { cancelled = true }
  }, [bundle, projeto])

  // =========================================================================
  // SELECIONAR ENCOMENDA (abre detalhe)
  // =========================================================================

  const handleSelecionar = useCallback(
    async (encomenda: EncomendaSelecao) => {
      if (!bundle || !projeto) return
      setCarregandoDetalhe(true)
      setErroAcao(null)
      setSucesso(false)
      setMostrarConfirmacao(false)

      // Limpa formulário
      setFuncionarioId("")
      setRecebedorNome("")
      setRecebedorDocumento("")
      setRecebedorVinculo("")
      setFotoComprovanteUrl("")
      setObservacoesEntrega("")

      try {
        const result = await bundle.http.request<EncomendaDetalhe>(
          "GET",
          `/${projeto.slug}/painel-portaria/encomendas/${encomenda.id}`,
          { auth: "access" },
        )
        setEncomendaSelecionada(result)
      } catch (err) {
        setErroAcao(
          err instanceof Error ? err.message : "Não foi possível carregar os detalhes.",
        )
      } finally {
        setCarregandoDetalhe(false)
      }
    },
    [bundle, projeto],
  )

  // =========================================================================
  // VALIDAR EMOBARQUEDA
  // =========================================================================

  const encomendaPodeEntregar = useMemo(() => {
    if (!encomendaSelecionada) return false
    return encomendaSelecionada.status === "pronta_retirada"
  }, [encomendaSelecionada])

  const formularioValido = useMemo(
    () => funcionarioId !== "" && recebedorNome.trim().length >= 3,
    [funcionarioId, recebedorNome],
  )

  // =========================================================================
  // REGISTRAR ENTREGA
  // =========================================================================

  const handleConfirmarEntrega = useCallback(async () => {
    if (!bundle || !projeto || !encomendaSelecionada) return
    if (funcionarioId === "" || !recebedorNome.trim()) return

    setConfirmando(true)
    setErroAcao(null)

    try {
      // Construir evidência JSON estruturada
      const evidencia: Record<string, unknown> = {
        recebedorNome: recebedorNome.trim(),
        dataHora: new Date().toISOString(),
        funcionarioId: Number(funcionarioId),
      } as Record<string, unknown>

      if (recebedorDocumento.trim()) {
        evidencia.recebedorDocumento = recebedorDocumento.trim()
      }
      if (recebedorVinculo) {
        evidencia.recebedorVinculo = recebedorVinculo
      }
      if (fotoComprovanteUrl.trim()) {
        evidencia.fotoComprovanteUrl = fotoComprovanteUrl.trim()
      }

      const payload = {
        funcionarioId: Number(funcionarioId),
        recebedorNome: recebedorNome.trim(),
        recebedorDocumento: recebedorDocumento.trim() || undefined,
        recebedorVinculo: recebedorVinculo || undefined,
        fotoComprovanteUrl: fotoComprovanteUrl.trim() || undefined,
        observacoesEntrega: observacoesEntrega.trim() || undefined,
      }

      await bundle.http.request(
        "PUT",
        `/${projeto.slug}/encomendas/${encomendaSelecionada.id}/entregar`,
        { body: payload, auth: "access" },
      )

      setSucesso(true)
    } catch (err) {
      setErroAcao(
        err instanceof Error
          ? err.message
          : "Não foi possível registrar a entrega. Verifique os dados e tente novamente.",
      )
    } finally {
      setConfirmando(false)
    }
  }, [bundle, projeto, encomendaSelecionada, funcionarioId, recebedorNome, recebedorDocumento, recebedorVinculo, fotoComprovanteUrl, observacoesEntrega])

  const handleCancelar = useCallback(() => {
    setMostrarConfirmacao(false)
    setFuncionarioId("")
    setRecebedorNome("")
    setRecebedorDocumento("")
    setRecebedorVinculo("")
    setFotoComprovanteUrl("")
    setObservacoesEntrega("")
  }, [])

  const handleVoltar = useCallback(() => {
    setEncomendaSelecionada(null)
    setSucesso(false)
    setErroAcao(null)
    setMostrarConfirmacao(false)
  }, [])

  // =========================================================================
  // RENDER — ETAPA 1: Listagem de encomendas prontas para retirada
  // =========================================================================

  if (!encomendaSelecionada && !sucesso) {
    return (
      <Stack spacing={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>
          Entregar Encomenda
        </Typography>

        {erroListagem ? (
          <Alert severity="error">{erroListagem}</Alert>
        ) : carregandoListagem ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress />
          </Box>
        ) : encomendas.length === 0 ? (
          <Alert severity="info" icon={<CheckCircleRounded />}>
            Nenhuma encomenda pronta para retirada no momento.
          </Alert>
        ) : (
          <Grid container spacing={2}>
            {encomendas.map((enc) => (
              <Grid key={enc.id} size={{ xs: 12, md: 6, lg: 4 }}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    cursor: "pointer",
                    "&:hover": { bgcolor: "action.hover" },
                    border: enc.status === "pronta_retirada" ? "2px solid" : "1px solid",
                    borderColor:
                      enc.status === "pronta_retirada" ? "success.main" : "divider",
                  }}
                  onClick={() => handleSelecionar(enc)}
                  data-testid={`encomenda-item-${enc.id}`}
                >
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Avatar
                      variant="rounded"
                      src={enc.fotoUrl ?? undefined}
                      sx={{ width: 56, height: 56, bgcolor: "grey.200" }}
                    >
                      {!enc.fotoUrl && <Inventory2Rounded color="disabled" />}
                    </Avatar>
                    <Box flex={1}>
                      <Typography variant="subtitle1" fontWeight={600}>
                        Encomenda #{enc.id}
                      </Typography>
                      {enc.unidadeLabel && (
                        <Typography variant="body2" color="text.secondary">
                          {enc.unidadeLabel}
                        </Typography>
                      )}
                      {enc.transportadoraNome && (
                        <Typography variant="caption" color="text.secondary" display="flex" alignItems="center" gap={0.5}>
                          <LocalShippingRounded sx={{ fontSize: 14 }} />
                          {enc.transportadoraNome}
                        </Typography>
                      )}
                    </Box>
                    <Chip
                      label={statusLabel(enc.status)}
                      size="small"
                      color={enc.status === "pronta_retirada" ? "success" : "default"}
                    />
                  </Stack>
                </Paper>
              </Grid>
            ))}
          </Grid>
        )}
      </Stack>
    )
  }

  // =========================================================================
  // RENDER — ETAPA 2: Sucesso (encomenda entregue)
  // =========================================================================

  if (sucesso) {
    return (
      <Stack spacing={3} alignItems="center" justifyContent="center" sx={{ minHeight: 400 }}>
        <Alert
          severity="success"
          icon={<CheckCircleRounded />}
          sx={{ width: "100%" }}
          data-testid="menssagem-sucesso-entrega"
        >
          <Typography variant="subtitle2" fontWeight={600} gutterBottom>
            Entrega registrada com sucesso!
          </Typography>
          <Typography variant="body2">
            Encomenda #{encomendaSelecionada?.id} marcada como entregue.
          </Typography>
        </Alert>
        <Button variant="contained" onClick={handleVoltar}>
          Nova entrega
        </Button>
      </Stack>
    )
  }

  // =========================================================================
  // RENDER — ETAPA 3: Formulário de entrega
  // =========================================================================

  return (
    <Stack spacing={3}>
      {/* Botão voltar */}
      <Button startIcon={<Inventory2Rounded />} onClick={handleVoltar}>
        Voltar à listagem
      </Button>

      {carregandoDetalhe ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : !encomendaSelecionada ? (
        <Alert severity="warning">Encomenda não encontrada.</Alert>
      ) : (
        <>
          {/* Cabeçalho com dados da encomenda */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h6" fontWeight={600} gutterBottom>
              Encomenda #{encomendaSelecionada.id}
            </Typography>

            <Stack direction="row" spacing={3}>
              <Avatar
                variant="rounded"
                src={encomendaSelecionada.fotoUrl ?? undefined}
                sx={{ width: 100, height: 100, bgcolor: "grey.200" }}
              >
                {!encomendaSelecionada.fotoUrl && (
                  <Inventory2Rounded sx={{ fontSize: 40 }} color="disabled" />
                )}
              </Avatar>
              <Box flex={1}>
                <Typography variant="subtitle1" fontWeight={600}>
                  {encomendaSelecionada.unidade.label ?? "Unidade não identificada"}
                </Typography>
                {encomendaSelecionada.transportadora && (
                  <Typography variant="body2" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <LocalShippingRounded sx={{ fontSize: 14 }} />
                    {encomendaSelecionada.transportadora.nome}
                  </Typography>
                )}
                {encomendaSelecionada.codigoRastreamento && (
                  <Typography variant="body2" color="text.secondary">
                    Rastreamento: {encomendaSelecionada.codigoRastreamento}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  Registrado por {encomendaSelecionada.registradoPor.nome} em{" "}
                  {formatarDataHora(encomendaSelecionada.chegadaEm)}
                </Typography>

                {/* Bloqueio se não pode entregar */}
                {!encomendaPodeEntregar && encomendaSelecionada.status === "pendente" && (
                  <Alert severity="warning" icon={<WarningAmberRounded />} sx={{ mt: 2 }}>
                    Esta encomenda ainda aguarda confirmação do morador. A entrega só pode ser
                    realizada após o reconhecimento pelo destinatário.
                  </Alert>
                )}
              </Box>
            </Stack>
          </Paper>

          {/* Formulário de evidência */}
          <Paper variant="outlined" sx={{ p: 3 }}>
            {encomendaPodeEntregar ? (
              <Typography variant="subtitle1" fontWeight={600} gutterBottom color="success.main">
                Encomenda pronta para entrega — preencha a evidência de retirada
              </Typography>
            ) : (
              <Alert severity="warning" icon={<WarningAmberRounded />}>
                Entrega não disponível neste status.
              </Alert>
            )}

            <Stack spacing={2} sx={{ mt: 2 }}>
              {/* Funcionário responsável */}
              {funcionarios.length > 0 ? (
                <FormControl fullWidth>
                  <InputLabel>Funcionário responsável</InputLabel>
                  <Select
                    value={funcionarioId}
                    label="Funcionário responsável"
                    onChange={(e) => setFuncionarioId(e.target.value as number)}
                    disabled={!encomendaPodeEntregar}
                    data-testid="campo-funcionario-responsavel"
                  >
                    {funcionarios.map((f) => (
                      <MenuItem key={f.id} value={f.id}>
                        {f.nome} ({f.funcao})
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <TextField
                  label="Funcionário responsável"
                  value={String(funcionarioId)}
                  onChange={(e) => setFuncionarioId(Number(e.target.value) || "")}
                  required
                  fullWidth
                  data-testid="campo-funcionario-responsavel"
                />
              )}

              {/* Nome do recebedor */}
              <TextField
                label="Nome de quem retirou"
                value={recebedorNome}
                onChange={(e) => setRecebedorNome(e.target.value)}
                required
                fullWidth
                disabled={!encomendaPodeEntregar}
                slotProps={{ htmlInput: { minLength: 3, maxLength: 200 } }}
                data-testid="campo-recebedor-nome"
                helperText={recebedorNome.length > 0 && recebedorNome.length < 3 ? "Mínimo 3 caracteres" : ""}
              />

              {/* Documento */}
              <TextField
                label="Documento de identificação (opcional)"
                value={recebedorDocumento}
                onChange={(e) => setRecebedorDocumento(e.target.value)}
                fullWidth
                disabled={!encomendaPodeEntregar}
                slotProps={{ htmlInput: { maxLength: 30 } }}
                data-testid="campo-recebedor-documento"
              />

              {/* Vínculo */}
              <FormControl fullWidth>
                <InputLabel>Vínculo com o morador</InputLabel>
                <Select
                  value={recebedorVinculo}
                  label="Vínculo com o morador"
                  onChange={(e) => setRecebedorVinculo(e.target.value as RecebedorVinculo)}
                  disabled={!encomendaPodeEntregar}
                  data-testid="select-vinculo-entrega"
                >
                  <MenuItem value="">
                    <em>Não informado</em>
                  </MenuItem>
                  <MenuItem value="proprio_morador">Próprio morador</MenuItem>
                  <MenuItem value="familiar">Familiar</MenuItem>
                  <MenuItem value="empregado">Empregado doméstico</MenuItem>
                  <MenuItem value="terceiro">Terceiro</MenuItem>
                </Select>
              </FormControl>

              {/* Foto comprovante */}
              <TextField
                label="URL da foto do comprovante (opcional)"
                value={fotoComprovanteUrl}
                onChange={(e) => setFotoComprovanteUrl(e.target.value)}
                fullWidth
                disabled={!encomendaPodeEntregar}
                slotProps={{ htmlInput: { maxLength: 1000 } }}
                data-testid="campo-foto-comprovante-entrega"
              />

              {/* Observações */}
              <TextField
                label="Observações da entrega (opcional)"
                value={observacoesEntrega}
                onChange={(e) => setObservacoesEntrega(e.target.value)}
                fullWidth
                disabled={!encomendaPodeEntregar}
                multiline
                rows={2}
                slotProps={{ htmlInput: { maxLength: 1000 } }}
                data-testid="campo-observacoes-entrega"
              />

              {/* Erro de ação */}
              {erroAcao && (
                <Alert severity="error">{erroAcao}</Alert>
              )}

              {/* Botão registrar */}
              {encomendaPodeEntregar && (
                <Button
                  variant="contained"
                  color="success"
                  size="large"
                  onClick={() => setMostrarConfirmacao(true)}
                  disabled={!formularioValido}
                  startIcon={<CheckCircleRounded />}
                  data-testid="botao-registrar-entrega-tela"
                >
                  Registrar entrega
                </Button>
              )}
            </Stack>
          </Paper>

          {/* Confirmação contextual */}
          {mostrarConfirmacao && encomendaPodeEntregar && (
            <Paper variant="outlined" sx={{ p: 3, bgcolor: "warning.light" }}>
              <Stack direction="row" spacing={2} alignItems="flex-start">
                <WarningAmberRounded color="warning" />
                <Box flex={1}>
                  <Typography variant="subtitle2" fontWeight={600} gutterBottom>
                    Confirmar entrega para: {recebedorNome}
                  </Typography>
                  <Typography variant="body2" gutterBottom>
                    Esta ação irá registrar a evidência de retirada e marcar a encomenda como{" "}
                    <strong>entregue</strong>. A trilha auditável inclui funcionário, data/hora
                    e dados do recebedor.
                  </Typography>
                </Box>
              </Stack>
              <Stack direction="row" spacing={1} justifyContent="flex-end" mt={2}>
                <Button onClick={handleCancelar} disabled={confirmando}>
                  Cancelar
                </Button>
                <Button
                  variant="contained"
                  color="success"
                  onClick={handleConfirmarEntrega}
                  disabled={confirmando}
                  startIcon={confirmando ? <CircularProgress size={16} /> : <CheckCircleRounded />}
                  data-testid="botao-confirmar-entrega-final"
                >
                  {confirmando ? "Registrando..." : "Confirmar entrega"}
                </Button>
              </Stack>
            </Paper>
          )}
        </>
      )}
    </Stack>
  )
}
