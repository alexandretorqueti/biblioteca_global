/**
 * NovaTarefaScreen — cria uma tarefa no projeto gerenteagentes.
 *
 * Usa fetch direto para o endpoint interno da plataforma.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react"
import {
  Box,
  Button,
  Stack,
  Typography,
  Alert,
  CircularProgress,
  Paper,
  TextField,
} from "@mui/material"
import { AddTaskRounded } from "@mui/icons-material"

export default function NovaTarefaScreen(): ReactNode {
  const [projetoId, setProjetoId] = useState("")
  const [agenteId, setAgenteId] = useState("")
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [repoPath, setRepoPath] = useState("")
  const [buildCommand, setBuildCommand] = useState("")
  const [unitTestCommand, setUnitTestCommand] = useState("")

  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const errosCampos = useMemo(() => {
    const e: string[] = []
    if (!projetoId.trim()) e.push("Projeto é obrigatório")
    if (!agenteId.trim()) e.push("Agente é obrigatório")
    if (!titulo.trim()) e.push("Título é obrigatório")
    return e
  }, [projetoId, agenteId, titulo])

  const podeEnviar = errosCampos.length === 0 && !enviando

  const enviar = useCallback(async () => {
    setErro(null)
    setSucesso(false)
    setEnviando(true)

    try {
      const token = localStorage.getItem("access_token")
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const response = await fetch("/api/tarefas", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projetoId: Number(projetoId),
          agenteId: Number(agenteId),
          titulo: titulo.trim(),
          descricao: descricao.trim() || null,
          repoPath: repoPath.trim() || null,
          buildCommand: buildCommand.trim() || null,
          unitTestCommand: unitTestCommand.trim() || null,
          status: "draft",
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || "Erro ao criar tarefa")
      }

      setSucesso(true)
      setProjetoId("")
      setAgenteId("")
      setTitulo("")
      setDescricao("")
      setRepoPath("")
      setBuildCommand("")
      setUnitTestCommand("")
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao criar tarefa")
    } finally {
      setEnviando(false)
    }
  }, [projetoId, agenteId, titulo, descricao, repoPath, buildCommand, unitTestCommand])

  return (
    <Stack spacing={3} data-testid="nova-tarefa-screen">
      <Typography variant="h4" fontWeight={600}>
        Nova Tarefa
      </Typography>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          {erro && <Alert severity="error" data-testid="api-error">{erro}</Alert>}
          {sucesso && (
            <Alert severity="success" data-testid="success-alert">
              Tarefa criada com sucesso!
            </Alert>
          )}

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Projeto (ID)"
              type="number"
              value={projetoId}
              onChange={(e) => setProjetoId(e.target.value)}
              required
              fullWidth
              error={!projetoId.trim() && projetoId.length > 0}
              slotProps={{ input: { "data-testid": "input-projeto-id" } }}
            />
            <TextField
              label="Agente (ID)"
              type="number"
              value={agenteId}
              onChange={(e) => setAgenteId(e.target.value)}
              required
              fullWidth
              error={!agenteId.trim() && agenteId.length > 0}
              slotProps={{ input: { "data-testid": "input-agente-id" } }}
            />
          </Stack>

          <TextField
            label="Título"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            required
            fullWidth
            error={!titulo.trim() && titulo.length > 0}
            slotProps={{ input: { "data-testid": "input-titulo" } }}
          />

          <TextField
            label="Descrição"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            multiline
            rows={3}
            fullWidth
            slotProps={{ input: { "data-testid": "input-descricao" } }}
          />

          <TextField
            label="Repo Path"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            fullWidth
            placeholder="/data/workspace/projects/..."
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Build Command"
              value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              fullWidth
              placeholder="npm run build"
            />
            <TextField
              label="Test Command"
              value={unitTestCommand}
              onChange={(e) => setUnitTestCommand(e.target.value)}
              fullWidth
              placeholder="npm run test"
            />
          </Stack>

          <Box>
            <Button
              variant="contained"
              startIcon={enviando ? <CircularProgress size={20} /> : <AddTaskRounded />}
              onClick={enviar}
              disabled={!podeEnviar}
              data-testid="btn-enviar"
            >
              {enviando ? "Criando..." : "Criar Tarefa"}
            </Button>
          </Box>
        </Stack>
      </Paper>
    </Stack>
  )
}
