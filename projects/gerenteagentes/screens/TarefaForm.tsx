import { useMemo, useState, type ReactNode } from "react"
import { AddTaskRounded } from "@mui/icons-material"
import { Alert, Box, Button, CircularProgress, MenuItem, Stack, TextField } from "@mui/material"
import { TASK_STATUS_OPTIONS } from "../motor-v2/src/shared/task-statuses"

export interface TarefaFormProjeto {
  id: number
  nome: string
}

export interface TarefaFormValues {
  projetoId: string
  titulo: string
  descricao: string
  tipo: "desenvolvimento" | "automacao" | "verificacao"
  status: string
}

export const TIPO_TAREFA_OPTIONS = [
  { value: "desenvolvimento", label: "Desenvolvimento" },
  { value: "automacao", label: "Automação" },
  { value: "verificacao", label: "Verificação" },
] as const

interface TarefaFormProps {
  projetos: TarefaFormProjeto[]
  loading?: boolean
  error?: string | null
  success?: string | null
  submitLabel?: string
  onSubmit: (values: TarefaFormValues) => void | boolean | Promise<void | boolean>
}

/** Formulário único de criação de tarefa, usado em tela e em modais. */
export default function TarefaForm({
  projetos,
  loading = false,
  error = null,
  success = null,
  submitLabel = "Criar Tarefa",
  onSubmit,
}: TarefaFormProps): ReactNode {
  const [projetoId, setProjetoId] = useState("")
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [tipo, setTipo] = useState<TarefaFormValues["tipo"]>("desenvolvimento")
  const [status, setStatus] = useState("draft")

  const errosCampos = useMemo(() => {
    const erros: string[] = []
    if (!projetoId.trim()) erros.push("Projeto é obrigatório")
    if (!titulo.trim()) erros.push("Título é obrigatório")
    return erros
  }, [projetoId, titulo])

  const submit = async () => {
    if (errosCampos.length > 0 || loading) return
    const result = await onSubmit({ projetoId, titulo: titulo.trim(), descricao: descricao.trim(), tipo, status })
    if (result === false) return
    setProjetoId("")
    setTitulo("")
    setDescricao("")
    setTipo("desenvolvimento")
    setStatus("draft")
  }

  return (
    <Stack spacing={2} data-testid="tarefa-form">
      {error && <Alert severity="error" data-testid="api-error">{error}</Alert>}
      {success && <Alert severity="success" data-testid="success-alert">{success}</Alert>}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField
          select label="Projeto" value={projetoId} onChange={(e) => setProjetoId(e.target.value)}
          required fullWidth inputProps={{ "data-testid": "input-projeto-id" }}
        >
          <MenuItem value="" disabled>Selecione um projeto</MenuItem>
          {projetos.map((projeto) => <MenuItem key={projeto.id} value={String(projeto.id)}>{projeto.nome}</MenuItem>)}
        </TextField>
        <TextField
          select label="Tipo de tarefa" value={tipo}
          onChange={(e) => setTipo(e.target.value as TarefaFormValues["tipo"])}
          required fullWidth inputProps={{ "data-testid": "input-tipo" }}
        >
          {TIPO_TAREFA_OPTIONS.map((opcao) => <MenuItem key={opcao.value} value={opcao.value}>{opcao.label}</MenuItem>)}
        </TextField>
      </Stack>

      <TextField
        label="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} required fullWidth
        error={!titulo.trim() && titulo.length > 0} inputProps={{ "data-testid": "input-titulo" }}
      />
      <TextField
        label="Descrição" value={descricao} onChange={(e) => setDescricao(e.target.value)}
        multiline rows={3} fullWidth inputProps={{ "data-testid": "input-descricao" }}
      />
      <TextField
        select label="Status inicial" value={status} onChange={(e) => setStatus(e.target.value)}
        required fullWidth inputProps={{ "data-testid": "input-status" }}
      >
        {TASK_STATUS_OPTIONS.map((opcao) => <MenuItem key={opcao.value} value={opcao.value}>{opcao.label}</MenuItem>)}
      </TextField>

      <Box>
        <Button
          variant="contained" startIcon={loading ? <CircularProgress size={20} /> : <AddTaskRounded />}
          onClick={submit} disabled={errosCampos.length > 0 || loading} data-testid="btn-enviar"
        >
          {loading ? "Criando..." : submitLabel}
        </Button>
      </Box>
    </Stack>
  )
}
