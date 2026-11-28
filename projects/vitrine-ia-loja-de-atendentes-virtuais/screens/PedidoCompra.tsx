/**
 * PedidoCompra — formulário público de autoatendimento da Vitrine IA
 * (macro #10, posição 3/11 — subtarefa 2; REQ-F-004/REQ-F-015).
 *
 * Regras da subtarefa:
 * - UI não fala HTTP: todo transporte via `VitrinePublicaClient`
 *   (packages/api-client) — planos vêm de `GET /vitrine/conteudo`
 *   (seleção POR NOME, apenas planos ativos) e a criação vai em
 *   `POST /vitrine/pedidos` multipart montado pelo cliente;
 * - máscara de telefone da plataforma (`formatTelefone` de
 *   `@biblioteca-global/ui`) e validação de cliente pelo MESMO contrato
 *   Zod server-side (`vitrinePedidoDadosSchema`: e-mail, telefone via
 *   `isValidBrPhone`, maxLengths, ciclo, consentimento literal) — a
 *   autoridade é o backend: erros 400 chegam como `ApiClientError` com a
 *   mensagem clara do servidor e são exibidos como estado global;
 * - envio bloqueado sem consentimento LGPD marcado (checkbox obrigatório);
 * - arquivos restringidos a .pdf/.docx/.txt: `accept` no input + rejeição
 *   ANTES do envio com mensagem por arquivo (extensão, vazio, limite de
 *   bytes e máximo de arquivos — limites espelhados do service para
 *   comunicação na UI; a validação canônica continua server-side);
 * - texto livre vira campo `textoLivre` do multipart (documento
 *   `texto_livre` no backend), com o mesmo teto de caracteres do contrato;
 * - sucesso → confirmação com o token de acompanhamento retornado pelo
 *   backend e link para `/vitrine-ia/pedido/:token` (nunca um id interno).
 *
 * Nenhum copy comercial ou telefone é hardcoded aqui: rótulos são
 * funcionais (campos/ações) e os planos/texto vêm do conteúdo publicado.
 */
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Container,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import CloseIcon from "@mui/icons-material/Close"
import { ApiClientError, VitrinePublicaClient } from "@biblioteca-global/api-client"
import {
  VITRINE_TEXTO_LIVRE_MAX_CHARS,
  vitrinePedidoDadosSchema,
  type VitrinePedidoCiclo,
  type VitrinePedidoCriacaoResposta,
  type VitrinePublicaPlano,
} from "@biblioteca-global/shared"
import { formatTelefone } from "@biblioteca-global/ui"
import { useApi } from "../../../apps/web/src/hooks/useApi"

/**
 * Limites ESPELHADOS do backend para comunicação e pré-checagem na UI
 * (`vitrine-pedidos.constantes.ts` + env `VITRINE_UPLOAD_MAX_BYTES`,
 * default 10 MB). A autoridade é server-side: se o env divergir, o 400 do
 * service (com o limite real) é exibido como mensagem global.
 */
export const LIMITE_ARQUIVO_BYTES_UI = 10 * 1024 * 1024
export const MAX_ARQUIVOS_UI = 10
const EXTENSOES_ACEITAS = ["pdf", "docx", "txt"] as const

/** Extensão em minúsculas do nome do arquivo ("" quando não há extensão). */
export function extensaoArquivo(nome: string): string {
  const ponto = nome.lastIndexOf(".")
  return ponto > 0 ? nome.slice(ponto + 1).toLowerCase() : ""
}

/** Remove o prefixo país do campo mascarado — o contrato aceita DDD+número. */
export function telefoneParaEnvio(valorMascarado: string): string {
  const valor = valorMascarado.trim()
  return valor.startsWith("+55") ? valor.slice(3).trim() : valor
}

/** Tamanho humanizado pt-BR (KB/MB) para a lista de arquivos. */
export function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
}

/**
 * Pré-checagem client-side da whitelist (extensão, vazio, tamanho) e do
 * máximo de arquivos. Devolve os aceitos e a mensagem clara por rejeitado
 * — o backend revalida tudo (fonte única).
 */
export function revisarArquivos(
  atuais: readonly File[],
  novas: readonly File[],
): { aceitos: File[]; rejeicoes: string[]; estourouLimite: boolean } {
  const aceitos: File[] = [...atuais]
  const rejeicoes: string[] = []
  let estourouLimite = false
  for (const arquivo of novas) {
    const nome = arquivo.name || "arquivo sem nome"
    const extensao = extensaoArquivo(arquivo.name ?? "")
    if (!EXTENSOES_ACEITAS.includes(extensao as (typeof EXTENSOES_ACEITAS)[number])) {
      rejeicoes.push(`"${nome}": tipo não aceito. Envie apenas PDF, DOCX ou TXT.`)
      continue
    }
    if (arquivo.size === 0) {
      rejeicoes.push(`"${nome}" está vazio — remova-o antes de enviar.`)
      continue
    }
    if (arquivo.size > LIMITE_ARQUIVO_BYTES_UI) {
      rejeicoes.push(
        `"${nome}" tem ${formatarTamanho(arquivo.size)} — o limite é ${formatarTamanho(LIMITE_ARQUIVO_BYTES_UI)} por arquivo.`,
      )
      continue
    }
    if (aceitos.length >= MAX_ARQUIVOS_UI) {
      rejeicoes.push(`Máximo de ${MAX_ARQUIVOS_UI} arquivos por pedido — "${nome}" não foi adicionado.`)
      estourouLimite = true
      continue
    }
    aceitos.push(arquivo)
  }
  return { aceitos, rejeicoes, estourouLimite }
}

type ErrosCampo = Partial<Record<"nomeNegocio" | "nomeContato" | "email" | "telefone" | "plano" | "ciclo" | "consentimentoLgpd", string>>

type EstadoCarregamento = "carregando" | "pronto" | "erro"

const ROTULO_CICLO: Record<VitrinePedidoCiclo, string> = {
  mensal: "Mensal",
  anual: "Anual",
}

export default function PedidoCompra(): ReactNode {
  const bundle = useApi()
  const cliente = useMemo(
    () => (bundle ? new VitrinePublicaClient(bundle.http) : undefined),
    [bundle],
  )
  const [searchParams] = useSearchParams()

  // ── planos (fonte: conteúdo público ativo) ─────────────────────────────
  const [estadoPlanos, setEstadoPlanos] = useState<EstadoCarregamento>("carregando")
  const [planos, setPlanos] = useState<VitrinePublicaPlano[]>([])

  const carregarPlanos = useCallback(() => {
    if (!cliente) {
      setEstadoPlanos("erro")
      return
    }
    let vivo = true
    setEstadoPlanos("carregando")
    cliente
      .obterConteudo()
      .then((conteudo) => {
        if (!vivo) return
        setPlanos(conteudo.planos)
        setEstadoPlanos("pronto")
      })
      .catch(() => {
        if (!vivo) return
        setEstadoPlanos("erro")
      })
    return () => {
      vivo = false
    }
  }, [cliente])

  useEffect(() => carregarPlanos(), [carregarPlanos])

  // ── campos do formulário ────────────────────────────────────────────────
  const [nomeNegocio, setNomeNegocio] = useState("")
  const [nomeContato, setNomeContato] = useState("")
  const [email, setEmail] = useState("")
  const [telefone, setTelefone] = useState("")
  const [plano, setPlano] = useState("")
  const [ciclo, setCiclo] = useState<VitrinePedidoCiclo>("mensal")
  const [informacoesNegocio, setInformacoesNegocio] = useState("")
  const [textoLivre, setTextoLivre] = useState("")
  const [consentido, setConsentido] = useState(false)
  const [arquivos, setArquivos] = useState<File[]>([])
  const [rejeicoes, setRejeicoes] = useState<string[]>([])

  const [erros, setErros] = useState<ErrosCampo>({})
  const [erroGlobal, setErroGlobal] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [confirmacao, setConfirmacao] = useState<VitrinePedidoCriacaoResposta | null>(null)

  // Pré-seleção vinda da vitrine (?plano=<nome>) — só vale se o plano está
  // entre os planos ativos publicados; caso contrário, o usuário escolhe.
  useEffect(() => {
    if (estadoPlanos !== "pronto" || plano !== "") return
    const doLink = searchParams.get("plano")
    if (doLink && planos.some((p) => p.nome === doLink)) setPlano(doLink)
  }, [estadoPlanos, planos, searchParams, plano])

  const aoSelecionarArquivos = (evento: ChangeEvent<HTMLInputElement>) => {
    const selecionados = Array.from(evento.target.files ?? [])
    const resultado = revisarArquivos([], selecionados)
    setArquivos(resultado.aceitos)
    setRejeicoes(resultado.rejeicoes)
  }

  const removerArquivo = (indice: number) => {
    setArquivos((lista) => lista.filter((_, i) => i !== indice))
  }

  const aoEnviar = async (evento: FormEvent) => {
    evento.preventDefault()
    setErroGlobal(null)
    if (!cliente) {
      setErroGlobal("Serviço indisponível no momento. Tente novamente em instantes.")
      return
    }

    // Validação de cliente com o MESMO contrato do backend (strict): campos
    // obrigatórios, e-mail, telefone (isValidBrPhone), maxLengths, ciclo,
    // consentimento literal. A autoridade continua sendo o servidor.
    const tentativa: Record<string, unknown> = {
      nomeNegocio,
      nomeContato,
      email,
      telefone: telefoneParaEnvio(telefone),
      plano,
      ciclo,
      informacoesNegocio: informacoesNegocio.trim() === "" ? undefined : informacoesNegocio,
      consentimentoLgpd: consentido,
    }
    const resultado = vitrinePedidoDadosSchema.safeParse(tentativa)
    if (!resultado.success) {
      const novosErros: ErrosCampo = {}
      for (const issue of resultado.error.issues) {
        const campo = String(issue.path[0] ?? "payload") as keyof ErrosCampo
        if (!novosErros[campo]) novosErros[campo] = issue.message
      }
      setErros(novosErros)
      if (novosErros.consentimentoLgpd) {
        setErroGlobal(novosErros.consentimentoLgpd)
      }
      return
    }
    setErros({})

    setEnviando(true)
    try {
      const resposta = await cliente.criarPedido({
        dados: resultado.data,
        arquivos,
        textoLivre: textoLivre.trim() === "" ? undefined : textoLivre,
      })
      setConfirmacao(resposta)
    } catch (erro) {
      if (erro instanceof ApiClientError && erro.status === 400) {
        // O service devolve mensagem clara (campo: motivo / upload / plano
        // inativo) — exibida como estado global, sem inventar detalhes.
        setErroGlobal(erro.message)
      } else if (erro instanceof ApiClientError && erro.code === "INVALID_RESPONSE") {
        setErroGlobal("Resposta inesperada do servidor. Tente novamente em instantes.")
      } else {
        setErroGlobal("Não foi possível enviar o pedido agora. Verifique sua conexão e tente novamente.")
      }
    } finally {
      setEnviando(false)
    }
  }

  if (confirmacao) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Card variant="outlined" sx={{ p: 4 }} data-testid="confirmacao-sucesso">
          <Stack spacing={2.5}>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 800 }}>
              Pedido enviado!
            </Typography>
            <Alert severity="success" data-testid="confirmacao-mensagem">
              {confirmacao.mensagem}
            </Alert>
            <Typography variant="body2" color="text.secondary">
              Guarde o código de acompanhamento abaixo. Ele é a única forma de consultar o
              seu pedido:
            </Typography>
            <Box
              component="code"
              data-testid="token-acompanhamento"
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: "action.hover",
                fontFamily: "monospace",
                fontSize: 13,
                wordBreak: "break-all",
              }}
            >
              {confirmacao.tokenAcompanhamento}
            </Box>
            <Button
              component={Link}
              to={`/vitrine-ia/pedido/${confirmacao.tokenAcompanhamento}`}
              variant="contained"
              size="large"
              sx={{ alignSelf: "flex-start", borderRadius: 999, px: 3, fontWeight: 700 }}
              data-testid="link-acompanhar"
            >
              Acompanhar meu pedido
            </Button>
            <Button
              component={Link}
              to="/vitrine-ia"
              color="inherit"
              sx={{ alignSelf: "flex-start" }}
            >
              Voltar para a vitrine
            </Button>
          </Stack>
        </Card>
      </Container>
    )
  }

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3} component="form" onSubmit={aoEnviar} noValidate data-testid="pedido-form">
        <Box>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 800 }}>
            Pedido de compra
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Conte sobre o seu negócio e envie o material que a atendente virtual deve
            conhecer. Você recebe um código para acompanhar o pedido.
          </Typography>
        </Box>

        {erroGlobal !== null && (
          <Alert severity="error" data-testid="erro-global">
            {erroGlobal}
          </Alert>
        )}

        <TextField
          label="Nome do negócio"
          value={nomeNegocio}
          onChange={(e) => setNomeNegocio(e.target.value)}
          error={Boolean(erros.nomeNegocio)}
          helperText={erros.nomeNegocio ?? "Como sua empresa se chama"}
          inputProps={{ maxLength: 160 }}
          required
          fullWidth
          autoComplete="organization"
        />
        <TextField
          label="Nome do contato"
          value={nomeContato}
          onChange={(e) => setNomeContato(e.target.value)}
          error={Boolean(erros.nomeContato)}
          helperText={erros.nomeContato ?? "Quem fala com a gente sobre este pedido"}
          inputProps={{ maxLength: 160 }}
          required
          fullWidth
          autoComplete="name"
        />
        <TextField
          label="E-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={Boolean(erros.email)}
          helperText={erros.email ?? "Usado só para este pedido"}
          inputProps={{ maxLength: 160, type: "email" }}
          required
          fullWidth
          autoComplete="email"
        />
        <TextField
          label="Telefone (WhatsApp)"
          value={telefone}
          onChange={(e) => setTelefone(formatTelefone(e.target.value))}
          error={Boolean(erros.telefone)}
          helperText={erros.telefone ?? "Com DDD — máscara aplicada automaticamente"}
          inputProps={{ inputMode: "tel", maxLength: 20, "data-testid": "campo-telefone" }}
          required
          fullWidth
          autoComplete="tel"
        />

        <FormControl fullWidth required>
          <InputLabel id="plano-label">Plano</InputLabel>
          <Select
            labelId="plano-label"
            label="Plano"
            value={plano}
            onChange={(e) => setPlano(e.target.value)}
            error={Boolean(erros.plano)}
            disabled={estadoPlanos !== "pronto" || enviando}
            data-testid="campo-plano"
          >
            {planos.map((p) => (
              <MenuItem key={p.nome} value={p.nome}>
                {p.nome}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText
            sx={{
              ml: 0,
              mr: 0,
              ...(estadoPlanos === "carregando" ? { minHeight: 1, color: "text.disabled" } : {}),
            }}
          >
            {estadoPlanos === "carregando" && "Carregando planos…"}
            {estadoPlanos === "erro" && "Não foi possível carregar os planos. Tente novamente."}
            {estadoPlanos === "pronto" && planos.length === 0 && "Nenhum plano disponível no momento."}
            {estadoPlanos === "pronto" && planos.length > 0 && (erros.plano ?? "Selecione um plano ativo")}
          </FormHelperText>
        </FormControl>

        <FormControl component="fieldset" required>
          <FormLabel component="legend">Ciclo de cobrança</FormLabel>
          <RadioGroup
            row
            value={ciclo}
            onChange={(e) => setCiclo(e.target.value === "anual" ? "anual" : "mensal")}
          >
            <FormControlLabel value="mensal" control={<Radio />} label={ROTULO_CICLO.mensal} />
            <FormControlLabel value="anual" control={<Radio />} label={ROTULO_CICLO.anual} />
          </RadioGroup>
          {erros.ciclo && <FormHelperText error>{erros.ciclo}</FormHelperText>}
        </FormControl>

        <TextField
          label="Informações do negócio (opcional)"
          value={informacoesNegocio}
          onChange={(e) => setInformacoesNegocio(e.target.value)}
          multiline
          minRows={3}
          fullWidth
          helperText="Resumo do que a atendente precisa saber sobre a sua empresa"
        />

        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
            Arquivos de conhecimento
          </Typography>
          <Typography variant="body2" color="text.secondary" data-testid="limite-upload" sx={{ mb: 1 }}>
            Formatos aceitos: PDF, DOCX ou TXT · até {formatarTamanho(LIMITE_ARQUIVO_BYTES_UI)} por
            arquivo · no máximo {MAX_ARQUIVOS_UI} arquivos.
          </Typography>
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.txt"
            onChange={aoSelecionarArquivos}
            data-testid="arquivos-input"
          />
          {rejeicoes.length > 0 && (
            <Stack spacing={0.5} sx={{ mt: 1 }} data-testid="arquivo-rejeicoes">
              {rejeicoes.map((mensagem, indice) => (
                <Alert key={`${mensagem}-${indice}`} severity="warning" sx={{ py: 0 }}>
                  {mensagem}
                </Alert>
              ))}
            </Stack>
          )}
          {arquivos.length > 0 && (
            <Stack spacing={1} sx={{ mt: 1.5 }} data-testid="lista-arquivos">
              {arquivos.map((arquivo, indice) => (
                <Card key={`${arquivo.name}-${indice}`} variant="outlined" sx={{ px: 1.5, py: 0.5 }}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Chip label="anexo" size="small" variant="outlined" />
                    <Typography variant="body2" sx={{ flexGrow: 1, wordBreak: "break-all" }}>
                      {arquivo.name} ({formatarTamanho(arquivo.size)})
                    </Typography>
                    <IconButton
                      size="small"
                      aria-label={`Remover ${arquivo.name}`}
                      onClick={() => removerArquivo(indice)}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Card>
              ))}
            </Stack>
          )}
        </Box>

        <TextField
          label="Texto livre (opcional)"
          value={textoLivre}
          onChange={(e) => setTextoLivre(e.target.value)}
          multiline
          minRows={4}
          fullWidth
          inputProps={{ maxLength: VITRINE_TEXTO_LIVRE_MAX_CHARS }}
          helperText={`Descreva em texto o conhecimento da atendente (vira documento do pedido) · até ${VITRINE_TEXTO_LIVRE_MAX_CHARS.toLocaleString("pt-BR")} caracteres`}
        />

        <Box>
          <FormControlLabel
            control={
              <Checkbox
                checked={consentido}
                onChange={(e) => setConsentido(e.target.checked)}
                data-testid="checkbox-lgpd"
              />
            }
            label="Li e autorizo o tratamento dos meus dados para a elaboração deste pedido, conforme a LGPD."
          />
          {erros.consentimentoLgpd && (
            <FormHelperText error data-testid="erro-consentimento">
              {erros.consentimentoLgpd}
            </FormHelperText>
          )}
        </Box>

        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={!consentido || enviando || estadoPlanos !== "pronto" || planos.length === 0}
          sx={{ alignSelf: "flex-start", borderRadius: 999, px: 4, py: 1.25, fontWeight: 700 }}
          data-testid="botao-enviar"
        >
          {enviando ? (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={18} color="inherit" />
              <span>Enviando pedido…</span>
            </Stack>
          ) : (
            "Enviar pedido"
          )}
        </Button>
        {!consentido && (
          <Typography variant="body2" color="text.secondary" data-testid="aviso-consentimento">
            Marque o consentimento LGPD para habilitar o envio.
          </Typography>
        )}
        <Box sx={{ pt: 1 }}>
          <Button component={Link} to="/vitrine-ia" color="inherit" sx={{ alignSelf: "flex-start" }}>
            Voltar para a vitrine
          </Button>
        </Box>
      </Stack>
    </Container>
  )
}
