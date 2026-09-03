/**
 * NovaTarefaScreen — cria uma tarefa no projeto gerenteagentes.
 *
 * Usa fetch direto para o endpoint interno da plataforma.
 *
 * Agente e ambiente de execução (repoPath/buildCommand/unitTestCommand)
 * vivem em projetos_captados (migration 0003) — a tarefa herda do projeto.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Box,
  Button,
  Stack,
  Typography,
  Alert,
  CircularProgress,
  Paper,
  TextField,
  MenuItem,
} from "@mui/material"
import { AddTaskRounded } from "@mui/icons-material"

interface Projeto {
  id: number
  nome: string
}

export default function NovaTarefaScreen(): ReactNode {
  const [projetos, setProjetos] = useState<Projeto[]>([])
  const [projetoId, setProjetoId] = useState("")
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")

  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const carregarOpcoes = useCallback(async () => {
    const token = localStorage.getItem("access_token")
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
    try {
      const projsRes = await fetch("/api/gerenteagentes/projetos_captados", { headers })
      if (projsRes.ok) {
        const data = await projsRes.json()
        setProjetos((data.items ?? data).filter((p: Projeto & { ativo?: boolean }) => p.ativo !== false))
      }
    } catch {
      // silencioso — combos ficam vazios
    }
  }, [])

  useEffect(() => {
    carregarOpcoes()
  }, [carregarOpcoes])

  const errosCampos = useMemo(() => {
    const e: string[] = []
    if (!projetoId.trim()) e.push("Projeto é obrigatório")
    if (!titulo.trim()) e.push("Título é obrigatório")
    return e
  }, [projetoId, titulo])

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

      const response = await fetch("/api/gerenteagentes/tarefas", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projetoId: Number(projetoId),
          titulo: titulo.trim(),
          descricao: descricao.trim() || null,
          status: "draft",
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || "Erro ao criar tarefa")
      }

      setSucesso(true)
      setProjetoId("")
      setTitulo("")
      setDescricao("")
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao criar tarefa")
    } finally {
      setEnviando(false)
    }
  }, [projetoId, titulo, descricao])

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
              select
              label="Projeto"
              value={projetoId}
              onChange={(e) => setProjetoId(e.target.value)}
              required
              fullWidth
              inputProps={{ "data-testid": "input-projeto-id" }}
            >
              <MenuItem value="" disabled>Selecione um projeto</MenuItem>
              {projetos.map((p) => (
                <MenuItem key={p.id} value={String(p.id)}>{p.nome}</MenuItem>
              ))}
            </TextField>
          </Stack>

          <TextField
            label="Título"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            required
            fullWidth
            error={!titulo.trim() && titulo.length > 0}
            inputProps={{ "data-testid": "input-titulo" }}
          />

          <TextField
            label="Descrição"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            multiline
            rows={3}
            fullWidth
            inputProps={{ "data-testid": "input-descricao" }}
          />

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
