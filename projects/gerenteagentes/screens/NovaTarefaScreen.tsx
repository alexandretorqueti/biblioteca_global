/**
 * NovaTarefaScreen — cria uma tarefa no projeto gerenteagentes.
 *
 * Usa fetch direto para o endpoint interno da plataforma.
 *
 * Agente e ambiente de execução (repoPath/buildCommand/unitTestCommand)
 * vivem em projetos_captados (migration 0003) — a tarefa herda do projeto.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  Stack,
  Typography,
  Paper,
} from "@mui/material"
import TarefaForm, { type TarefaFormValues } from "./TarefaForm"

interface Projeto {
  id: number
  nome: string
}

export default function NovaTarefaScreen(): ReactNode {
  const [projetos, setProjetos] = useState<Projeto[]>([])
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

  const enviar = useCallback(async (values: TarefaFormValues): Promise<boolean> => {
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
          projetoId: Number(values.projetoId),
          titulo: values.titulo,
          descricao: values.descricao || null,
          tipo: values.tipo,
          status: values.status,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || "Erro ao criar tarefa")
      }

      setSucesso(true)
      return true
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao criar tarefa")
      return false
    } finally {
      setEnviando(false)
    }
  }, [])

  return (
    <Stack spacing={3} data-testid="nova-tarefa-screen">
      <Typography variant="h4" fontWeight={600}>
        Nova Tarefa
      </Typography>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          <TarefaForm projetos={projetos} loading={enviando} error={erro} success={sucesso ? "Tarefa criada com sucesso!" : null} onSubmit={enviar} />
        </Stack>
      </Paper>
    </Stack>
  )
}
