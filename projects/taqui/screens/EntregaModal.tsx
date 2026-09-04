/**
 * EntregaModal — modal de entrega com validação de estado e confirmação contextual.
 *
 * Ao abrir:
 * - Busca detalhe completo da encomenda (foto, destino, transportadora).
 * - Valida status:
 *   - confirmada: exibe formulário de entrega (funcionário, evidência).
 *   - pendente: bloqueia entrega, exibe mensagem clara e opção de reenviar aviso.
 *   - cancelada: bloqueia entrega, exibe motivo do cancelamento.
 *   - entregue: exibe dados da entrega já realizada.
 *
 * Para encomendas confirmadas:
 * - Exibe foto da encomenda e destino (unidade + moradores).
 * - Formulário com: funcionário (select), nome de quem retirou, documento,
 *   vínculo, foto de comprovante, observações.
 * - Confirmação contextual específica para entrega (não modal genérico).
 * - Após entrega: chama onSuccess para atualizar painel sem recarga.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import {
  CloseRounded,
  Inventory2Rounded,
  CheckCircleRounded,
  WarningAmberRounded,
  BlockRounded,
  LocalShippingRounded,
  PersonRounded,
  BadgeRounded,
  PhotoCameraRounded,
  SendRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

// ============================================================================
// TIPOS
// ============================================================================

type StatusEncomenda = "pendente" | "confirmada" | "entregue" | "cancelada"

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

interface EncomendaDetalhe {
  id: number
  status: StatusEncomenda
  fotoUrl: string | null
  codigoRastreamento: string | null
  observacoes: string | null
  chegadaEm: string
  unidade: {
    id: number
    label: string | null
    tipo: "apartamento" | "casa"
    rua: string | null
    bloco: string | null
    andar: number | null
    numero: string | null
    quadra: string | null
    lote: string | null
  }
  moradores: Array<{
    id: number
    nome: string
    telefone: string | null
    email: string | null
  }>
  transportadora: {
    id: number
    nome: string
    cnpj: string | null
    telefone: string | null
  } | null
  registradoPor: {
    id: number
    nome: string
  }
  confirmadoPor: {
    id: number
    nome: string
  } | null
  confirmadoEm: string | null
  entrega: {
    id: number
    funcionarioId: number
    funcionarioNome: string
    dataHoraEntrega: string
    evidenciaQuemRetirou: string | null
  } | null
  motivoCancelamento?: string | null
}

interface EntregaModalProps {
  open: boolean
  onClose: () => void
  encomendaId: number
  status: StatusEncomenda
  onSuccess: () => void
}

// ============================================================================
// HELPERS
// ============================================================================

function vinculoLabel(v: RecebedorVinculo | null | undefined): string {
  const map: Record<RecebedorVinculo, string> = {
    proprio_morador: "Próprio morador",
    familiar: "Familiar",
    empregado: "Empregado doméstico",
    terceiro: "Terceiro",
  }
  return v ? map[v] : "Não informado"
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
// COMPONENTE: Bloco de bloqueio (pendente/cancelada)
// ============================================================================

function BlocoEntrega({
  status,
  motivoCancelamento,
  onReenviarAviso,
  reenviando,
  avisoEnviado,
}: {
  status: StatusEncomenda
  motivoCancelamento?: string | null
  onReenviarAviso: () => void
  reenviando: boolean
  avisoEnviado: boolean
}): ReactNode {
  if (status === "pendente") {
    return (
      <Alert
        severity="warning"
        icon={<WarningAmberRounded />}
        data-testid="bloco-entrega-pendente"
      >
        <Typography variant="subtitle2" fontWeight={600} gutterBottom>
          Entrega bloqueada — aguardando confirmação do morador
        </Typography>
        <Typography variant="body2">
          Esta encomenda ainda não foi confirmada pelo morador. A entrega física
          só pode ser realizada após a confirmação de recebimento.
        </Typography>
        <Box mt={2}>
          <Button
            variant="outlined"
            size="small"
            startIcon={reenviando ? <CircularProgress size={16} /> : <SendRounded />}
            onClick={onReenviarAviso}
            disabled={reenviando || avisoEnviado}
            data-testid="botao-reenviar-aviso-pendente"
          >
            {avisoEnviado ? "Aviso reenviado" : "Reenviar aviso ao morador"}
          </Button>
        </Box>
      </Alert>
    )
  }

  if (status === "cancelada") {
    return (
      <Alert
        severity="error"
        icon={<BlockRounded />}
        data-testid="bloco-entrega-cancelada"
      >
        <Typography variant="subtitle2" fontWeight={600} gutterBottom>
          Entrega bloqueada — encomenda cancelada
        </Typography>
        <Typography variant="body2">
          Esta encomenda foi cancelada e não pode mais ser entregue.
          {motivoCancelamento && (
            <>
              <br />
              <strong>Motivo:</strong> {motivoCancelamento}
            </>
          )}
        </Typography>
      </Alert>
    )
  }

  return null
}

// ============================================================================
// COMPONENTE: Entrega já realizada
// ============================================================================

function EntregaRealizada({ entrega }: { entrega: EncomendaDetalhe["entrega"] }): ReactNode {
  if (!entrega) return null

  let evidencia: Record<string, unknown> | null = null
  if (entrega.evidenciaQuemRetirou) {
    try {
      evidencia = JSON.parse(entrega.evidenciaQuemRetirou)
    } catch {
      // JSON inválido — ignora
    }
  }

  return (
    <Alert
      severity="info"
      icon={<CheckCircleRounded />}
      data-testid="bloco-entrega-realizada"
    >
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Encomenda já entregue
      </Typography>
      <Stack spacing={0.5}>
        <Typography variant="body2">
          <strong>Entregue por:</strong> {entrega.funcionarioNome}
        </Typography>
        <Typography variant="body2">
          <strong>Data/hora:</strong> {formatarDataHora(entrega.dataHoraEntrega)}
        </Typography>
        {evidencia && (
          <>
            <Typography variant="body2">
              <strong>Retirado por:</strong>{" "}
              {(evidencia.recebedorNome as string) ?? "Não informado"}
            </Typography>
            {evidencia.recebedorDocumento && (
              <Typography variant="body2">
                <strong>Documento:</strong>{" "}
                {evidencia.recebedorDocumento as string}
              </Typography>
            )}
            {evidencia.recebedorVinculo && (
              <Typography variant="body2">
                <strong>Vínculo:</strong>{" "}
                {vinculoLabel(evidencia.recebedorVinculo as RecebedorVinculo)}
              </Typography>
            )}
          </>
        )}
      </Stack>
    </Alert>
  )
}

// ============================================================================
// COMPONENTE: Confirmação contextual de entrega
// ============================================================================

function ConfirmacaoEntrega({
  onConfirmar,
  onCancelar,
  confirmando,
  recebedorNome,
}: {
  onConfirmar: () => void
  onCancelar: () => void
  confirmando: boolean
  recebedorNome: string
}): ReactNode {
  return (
    <Paper variant="outlined" sx={{ p: 2, bgcolor: "warning.light" }} data-testid="confirmacao-entrega">
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <WarningAmberRounded color="warning" sx={{ mt: 0.5 }} />
        <Box flex={1}>
          <Typography variant="subtitle2" fontWeight={600} gutterBottom>
            Confirmar entrega da encomenda
          </Typography>
          <Typography variant="body2" gutterBottom>
            Você está registrando a entrega física desta encomenda para:
          </Typography>
          <Typography variant="body2" fontWeight={600}>
            <PersonRounded sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }} />
            {recebedorNome}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" mt={1}>
            Esta ação é irreversível e registrará trilha auditável completa com
            data, hora, funcionário responsável e evidência de quem retirou.
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end" mt={2}>
        <Button size="small" onClick={onCancelar} disabled={confirmando}>
          Cancelar
        </Button>
        <Button
          variant="contained"
          color="success"
          size="small"
          onClick={onConfirmar}
          disabled={confirmando}
          startIcon={confirmando ? <CircularProgress size={16} /> : <CheckCircleRounded />}
          data-testid="botao-confirmar-entrega"
        >
          {confirmando ? "Registrando..." : "Confirmar entrega"}
        </Button>
      </Stack>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE PRINCIPAL: EntregaModal
// ============================================================================

export function EntregaModal({
  open,
  onClose,
  encomendaId,
  onSuccess,
}: EntregaModalProps): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()

  // Estado do detalhe
  const [detalhe, setDetalhe] = useState<EncomendaDetalhe | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  // Funcionários do condomínio
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([])

  // Formulário de entrega
  const [funcionarioId, setFuncionarioId] = useState<number | "">("")
  const [recebedorNome, setRecebedorNome] = useState("")
  const [recebedorDocumento, setRecebedorDocumento] = useState("")
  const [recebedorVinculo, setRecebedorVinculo] = useState<RecebedorVinculo | "">("")
  const [fotoComprovanteUrl, setFotoComprovanteUrl] = useState("")
  const [observacoesEntrega, setObservacoesEntrega] = useState("")

  // Estados de ação
  const [confirmandoEntrega, setConfirmandoEntrega] = useState(false)
  const [mostrarConfirmacao, setMostrarConfirmacao] = useState(false)
  const [reenviandoAviso, setReenviandoAviso] = useState(false)
  const [avisoEnviado, setAvisoEnviado] = useState(false)
  const [erroEntrega, setErroEntrega] = useState<string | null>(null)

  // =========================================================================
  // CARREGAR DETALHE
  // =========================================================================

  const carregarDetalhe = useCallback(async () => {
    if (!bundle || !projeto) return
    setCarregando(true)
    setErro(null)

    try {
      const result = await bundle.http.request<EncomendaDetalhe>(
        "GET",
        `/${projeto.slug}/painel-portaria/encomendas/${encomendaId}`,
        { auth: "access" },
      )
      setDetalhe(result)
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os detalhes da encomenda.",
      )
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto, encomendaId])

  // =========================================================================
  // CARREGAR FUNCIONÁRIOS
  // =========================================================================

  const carregarFuncionarios = useCallback(async () => {
    if (!bundle || !projeto) return
    try {
      const result = await bundle.http.request<{ items: Funcionario[] }>(
        "GET",
        `/${projeto.slug}/funcionarios`,
        { query: { pageSize: 200 }, auth: "access" },
      )
      // Filtra apenas funcionários com funcao portaria ou ambos
      const elegiveis = (result.items ?? []).filter(
        (f) => f.funcao === "portaria" || f.funcao === "ambos",
      )
      setFuncionarios(elegiveis)
    } catch {
      // Silencioso
    }
  }, [bundle, projeto])

  // =========================================================================
  // EFFECTS
  // =========================================================================

  useEffect(() => {
    if (open) {
      void carregarDetalhe()
      void carregarFuncionarios()
      // Reset estados
      setMostrarConfirmacao(false)
      setConfirmandoEntrega(false)
      setErroEntrega(null)
      setAvisoEnviado(false)
      setFuncionarioId("")
      setRecebedorNome("")
      setRecebedorDocumento("")
      setRecebedorVinculo("")
      setFotoComprovanteUrl("")
      setObservacoesEntrega("")
    }
  }, [open, carregarDetalhe, carregarFuncionarios])

  // =========================================================================
  // HANDLERS
  // =========================================================================

  const handleReenviarAviso = useCallback(async () => {
    if (!bundle || !projeto) return
    setReenviandoAviso(true)
    try {
      await bundle.http.request(
        "POST",
        `/${projeto.slug}/painel-portaria/encomendas/${encomendaId}/reenviar-aviso`,
        { body: {}, auth: "access" },
      )
      setAvisoEnviado(true)
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível reenviar o aviso.",
      )
    } finally {
      setReenviandoAviso(false)
    }
  }, [bundle, projeto, encomendaId])

  const handleRegistrarEntrega = useCallback(async () => {
    if (!bundle || !projeto || !detalhe) return
    if (funcionarioId === "" || !recebedorNome.trim()) return

    setConfirmandoEntrega(true)
    setErroEntrega(null)

    try {
      const body = {
        funcionarioId: Number(funcionarioId),
        recebedorNome: recebedorNome.trim(),
        recebedorDocumento: recebedorDocumento.trim() || undefined,
        recebedorVinculo: recebedorVinculo || undefined,
        fotoComprovanteUrl: fotoComprovanteUrl.trim() || undefined,
        observacoesEntrega: observacoesEntrega.trim() || undefined,
      }

      await bundle.http.request(
        "POST",
        `/${projeto.slug}/painel-portaria/encomendas/${encomendaId}/entregar`,
        { body, auth: "access" },
      )

      // Sucesso — atualiza painel e fecha modal
      onSuccess()
      onClose()
    } catch (error) {
      setErroEntrega(
        error instanceof Error
          ? error.message
          : "Não foi possível registrar a entrega. Verifique os dados e tente novamente.",
      )
    } finally {
      setConfirmandoEntrega(false)
    }
  }, [
    bundle,
    projeto,
    detalhe,
    funcionarioId,
    recebedorNome,
    recebedorDocumento,
    recebedorVinculo,
    fotoComprovanteUrl,
    observacoesEntrega,
    encomendaId,
    onSuccess,
    onClose,
  ])

  const handleSubmitEntrega = useCallback(() => {
    if (funcionarioId === "" || !recebedorNome.trim()) return
    setMostrarConfirmacao(true)
  }, [funcionarioId, recebedorNome])

  const handleCancelarConfirmacao = useCallback(() => {
    setMostrarConfirmacao(false)
  }, [])

  // =========================================================================
  // RENDER
  // =========================================================================

  const podeEntregar = detalhe?.status === "confirmada"
  const formularioValido = funcionarioId !== "" && recebedorNome.trim().length >= 3

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      data-testid="modal-entrega"
    >
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Inventory2Rounded color="primary" />
          <Typography variant="h6" fontWeight={600}>
            Detalhe da Encomenda #{encomendaId}
          </Typography>
          {detalhe && (
            <Chip
              label={
                detalhe.status === "pendente"
                  ? "Aguardando confirmação"
                  : detalhe.status === "confirmada"
                    ? "Pronta para retirada"
                    : detalhe.status === "entregue"
                      ? "Entregue"
                      : "Cancelada"
              }
              color={
                detalhe.status === "pendente"
                  ? "warning"
                  : detalhe.status === "confirmada"
                    ? "success"
                    : detalhe.status === "entregue"
                      ? "default"
                      : "error"
              }
              size="small"
            />
          )}
        </Stack>
        <IconButton
          aria-label="fechar"
          onClick={onClose}
          sx={{ position: "absolute", right: 8, top: 8 }}
        >
          <CloseRounded />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {carregando ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        ) : erro ? (
          <Alert severity="error">{erro}</Alert>
        ) : !detalhe ? (
          <Alert severity="warning">Encomenda não encontrada.</Alert>
        ) : (
          <Stack spacing={3}>
            {/* Foto e dados básicos */}
            <Stack direction="row" spacing={3}>
              <Avatar
                variant="rounded"
                src={detalhe.fotoUrl ?? undefined}
                sx={{ width: 120, height: 120, bgcolor: "grey.200" }}
              >
                {!detalhe.fotoUrl && (
                  <Inventory2Rounded sx={{ fontSize: 48 }} color="disabled" />
                )}
              </Avatar>
              <Box flex={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  Destino
                </Typography>
                <Typography variant="h6" fontWeight={600}>
                  {detalhe.unidade.label ?? "Unidade não identificada"}
                </Typography>
                {detalhe.transportadora && (
                  <Typography variant="body2" color="text.secondary">
                    <LocalShippingRounded
                      sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }}
                    />
                    {detalhe.transportadora.nome}
                  </Typography>
                )}
                {detalhe.codigoRastreamento && (
                  <Typography variant="body2" color="text.secondary">
                    Rastreamento: {detalhe.codigoRastreamento}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  Registrado por {detalhe.registradoPor.nome} em{" "}
                  {formatarDataHora(detalhe.chegadaEm)}
                </Typography>
              </Box>
            </Stack>

            {/* Moradores da unidade */}
            {detalhe.moradores.length > 0 && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Moradores da unidade
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {detalhe.moradores.map((m) => (
                    <Chip
                      key={m.id}
                      label={m.nome}
                      icon={<PersonRounded />}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Stack>
              </Box>
            )}

            {/* Confirmação do morador */}
            {detalhe.confirmadoPor && (
              <Alert severity="success" icon={<CheckCircleRounded />}>
                Confirmado por <strong>{detalhe.confirmadoPor.nome}</strong> em{" "}
                {formatarDataHora(detalhe.confirmadoEm ?? "")}
              </Alert>
            )}

            {/* Observações */}
            {detalhe.observacoes && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Observações
                </Typography>
                <Typography variant="body2">{detalhe.observacoes}</Typography>
              </Box>
            )}

            <Divider />

            {/* Bloco de bloqueio para pendente/cancelada */}
            {(detalhe.status === "pendente" || detalhe.status === "cancelada") && (
              <BlocoEntrega
                status={detalhe.status}
                motivoCancelamento={detalhe.motivoCancelamento}
                onReenviarAviso={handleReenviarAviso}
                reenviando={reenviandoAviso}
                avisoEnviado={avisoEnviado}
              />
            )}

            {/* Entrega já realizada */}
            {detalhe.status === "entregue" && detalhe.entrega && (
              <EntregaRealizada entrega={detalhe.entrega} />
            )}

            {/* Formulário de entrega (somente para confirmada) */}
            {podeEntregar && !mostrarConfirmacao && (
              <Box>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>
                  Registrar entrega
                </Typography>
                <Stack spacing={2}>
                  <FormControl fullWidth required>
                    <InputLabel>Funcionário que está entregando</InputLabel>
                    <Select
                      value={funcionarioId}
                      label="Funcionário que está entregando"
                      onChange={(e) => setFuncionarioId(e.target.value as number)}
                      data-testid="select-funcionario"
                    >
                      {funcionarios.map((f) => (
                        <MenuItem key={f.id} value={f.id}>
                          <BadgeRounded sx={{ fontSize: 16, mr: 1 }} />
                          {f.nome}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  <TextField
                    label="Nome de quem retirou"
                    value={recebedorNome}
                    onChange={(e) => setRecebedorNome(e.target.value)}
                    required
                    fullWidth
                    slotProps={{ htmlInput: { minLength: 3, maxLength: 200 } }}
                    data-testid="campo-recebedor-nome"
                  />

                  <TextField
                    label="Documento de identificação (opcional)"
                    value={recebedorDocumento}
                    onChange={(e) => setRecebedorDocumento(e.target.value)}
                    fullWidth
                    slotProps={{ htmlInput: { maxLength: 30 } }}
                    data-testid="campo-recebedor-documento"
                  />

                  <FormControl fullWidth>
                    <InputLabel>Vínculo com o morador</InputLabel>
                    <Select
                      value={recebedorVinculo}
                      label="Vínculo com o morador"
                      onChange={(e) =>
                        setRecebedorVinculo(e.target.value as RecebedorVinculo)
                      }
                      data-testid="select-vinculo"
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

                  <TextField
                    label="URL da foto do comprovante (opcional)"
                    value={fotoComprovanteUrl}
                    onChange={(e) => setFotoComprovanteUrl(e.target.value)}
                    fullWidth
                    slotProps={{
                      input: {
                        startAdornment: <PhotoCameraRounded sx={{ mr: 1, color: "text.disabled" }} />,
                      },
                      htmlInput: { maxLength: 1000 },
                    }}
                    data-testid="campo-foto-comprovante"
                  />

                  <TextField
                    label="Observações da entrega (opcional)"
                    value={observacoesEntrega}
                    onChange={(e) => setObservacoesEntrega(e.target.value)}
                    fullWidth
                    multiline
                    rows={2}
                    slotProps={{ htmlInput: { maxLength: 1000 } }}
                    data-testid="campo-observacoes-entrega"
                  />

                  {erroEntrega && (
                    <Alert severity="error">{erroEntrega}</Alert>
                  )}

                  <Button
                    variant="contained"
                    color="success"
                    onClick={handleSubmitEntrega}
                    disabled={!formularioValido}
                    startIcon={<CheckCircleRounded />}
                    data-testid="botao-registrar-entrega"
                  >
                    Registrar entrega
                  </Button>
                </Stack>
              </Box>
            )}

            {/* Confirmação contextual */}
            {podeEntregar && mostrarConfirmacao && (
              <ConfirmacaoEntrega
                onConfirmar={handleRegistrarEntrega}
                onCancelar={handleCancelarConfirmacao}
                confirmando={confirmandoEntrega}
                recebedorNome={recebedorNome}
              />
            )}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Fechar</Button>
      </DialogActions>
    </Dialog>
  )
}
