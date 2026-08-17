/**
 * NovaTarefaScreen — cria um rascunho de tarefa no motor de execução.
 *
 * Endpoint: POST /api/task (sem path params)
 * Payload: { agenteId, titulo, descricao }
 *
 * Tratamento de erro:
 * - 404 → aviso claro que o motor parece antigo/sinopse (endpoint inexistente)
 * - outros erros HTTP → exibidos no Alert sem crash
 */
import { useCallback, useMemo, useState, type ReactNode } from "react"
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  OutlinedInput,
  Stack,
  Typography,
  Alert,
  CircularProgress,
  Paper,
} from "@mui/material"
import { AddTaskRounded } from "@mui/icons-material"
import { ExternalApiClient } from "@biblioteca-global/api-client"

/* ------------------------------------------------------------------ */
/*  Constantes                                                         */
/* ------------------------------------------------------------------ */

const BASE_URL = "http://api.tarefas.localhost"

/* ------------------------------------------------------------------ */
/*  Tela principal                                                     */
/* ------------------------------------------------------------------ */

export default function NovaTarefaScreen(): ReactNode {
  const [agenteId, setAgenteId] = useState("")
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [erroForm, setErroForm] = useState<string | null>(null)

  // Estados de envio
  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [erroAPI, setErroAPI] = useState<string | null>(null)

  // Validação local (em tempo real)
  const errosCampos = useMemo(() => {
    const e: string[] = []
    if (!agenteId.trim()) e.push("Agente é obrigatório")
    if (!titulo.trim()) e.push("Título é obrigatório")
    return e
  }, [agenteId, titulo])

  const podeEnviar = errosCampos.length === 0 && !enviando

  /* -- envio -- */
  const enviar = useCallback(async () => {
    setErroForm(null)
    setSucesso(false)
    setErroAPI(null)

    // Validação final antes de enviar
    if (!agenteId.trim() || !titulo.trim()) {
      setErroForm(errosCampos.join(". "))
      return
    }

    setEnviando(true)

    const ext = new ExternalApiClient({ baseUrl: BASE_URL })

    try {
      // POST /api/task — sem path params, body com dados do form
      await ext.post(
        "/api/task",
        {},  // path params (nenhum para este endpoint)
        {
          agenteId: Number(agenteId),
          titulo: titulo.trim(),
          descricao: descricao.trim() || undefined,
        }
      )

      setSucesso(true)
      // Limpar formulário após sucesso
      setAgenteId("")
      setTitulo("")
      setDescricao("")
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 404) {
        setErroAPI(
          "O endpoint /api/task não foi encontrado. O motor de execução pode estar desatualizado ou configurado para outro caminho. Consulte o administrador."
        )
      } else if (e instanceof Error && "code" in e) {
        setErroAPI(`Erro do motor (${String((e as { code: string }).code)}): ${e.message}`)
      } else {
        const msg = e instanceof Error ? e.message : "Erro desconhecido ao criar rascunho"
        setErroAPI(msg)
      }
    } finally {
      setEnviando(false)
    }
  }, [agenteId, titulo, descricao, errosCampos])

  /* -- render -- */
  return (
    <Stack spacing={3} data-testid="nova-tarefa-screen">
      {/* Cabeçalho */}
      <Box>
        <Typography variant="h4" component="h1" fontWeight={900}>
          Nova Tarefa
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Crie um rascunho de tarefa para envio ao motor de execução
        </Typography>
      </Box>

      {/* Formulário */}
      <Paper variant="outlined" data-testid="form-card">
        <Stack spacing={3} sx={{ p: 3 }}>
          {/* Agente ID */}
          <FormControl fullWidth required>
            <InputLabel htmlFor="agenteId-input">Agente (ID)</InputLabel>
            <OutlinedInput
              id="agenteId-input"
              value={agenteId}
              onChange={(e) => setAgenteId(e.target.value)}
              label="Agente (ID)"
              type="number"
              data-testid="input-agente-id"
            />
          </FormControl>

          {/* Título */}
          <FormControl fullWidth required>
            <InputLabel htmlFor="titulo-input">Título</InputLabel>
            <OutlinedInput
              id="titulo-input"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              label="Título"
              data-testid="input-titulo"
            />
          </FormControl>

          {/* Descrição */}
          <FormControl fullWidth>
            <InputLabel htmlFor="descricao-input">Descrição</InputLabel>
            <OutlinedInput
              id="descricao-input"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              label="Descrição"
              multiline
              rows={4}
              data-testid="input-descricao"
            />
          </FormControl>

          {/* Erro de validação local */}
          {erroForm && (
            <Alert severity="error" data-testid="form-error">
              {erroForm}
            </Alert>
          )}

          {/* Erro da API / 404 do motor */}
          {erroAPI && (
            <Alert severity="error" data-testid="api-error">
              {erroAPI}
            </Alert>
          )}

          {/* Sucesso */}
          {sucesso && (
            <Alert severity="success" data-testid="success-alert">
              Rascunho de tarefa criado com sucesso!
            </Alert>
          )}

          {/* Botão enviar */}
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="contained"
              size="large"
              onClick={enviar}
              disabled={!podeEnviar}
              data-testid="btn-enviar"
              startIcon={enviando ? <CircularProgress size={18} /> : <AddTaskRounded />}
            >
              {enviando ? "Enviando..." : "Criar rascunho"}
            </Button>
          </Box>
        </Stack>
      </Paper>
    </Stack>
  )
}
