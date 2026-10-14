import { useMemo, useState, type ReactNode } from "react"
import { AddTaskRounded } from "@mui/icons-material"
import { Alert, Box, Button, CircularProgress, MenuItem, Stack, TextField } from "@mui/material"

export interface TarefaFormProjeto {
  id: number
  nome: string
}

export interface TarefaFormValues {
  projetoId: string
  titulo: string
  descricao: string
  tipo: "desenvolvimento" | "automacao" | "verificacao"
  dependsOnTaskIds: number[]
}
export interface TarefaFormTask { id: number; titulo: string; projetoId: number }

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
  tarefas?: TarefaFormTask[]
}

/** Formulário único de criação de tarefa, usado em tela e em modais. */
export default function TarefaForm({
  projetos,
  loading = false,
  error = null,
  success = null,
  submitLabel = "Criar Tarefa",
  onSubmit,
  tarefas = [],
}: TarefaFormProps): ReactNode {
  const [projetoId, setProjetoId] = useState("")
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [tipo, setTipo] = useState<TarefaFormValues["tipo"]>("desenvolvimento")
  const [dependsOnTaskIds, setDependsOnTaskIds] = useState<number[]>([])

  const errosCampos = useMemo(() => {
    const erros: string[] = []
    if (!projetoId.trim()) erros.push("Projeto é obrigatório")
    if (!titulo.trim()) erros.push("Título é obrigatório")
    return erros
  }, [projetoId, titulo])

  const submit = async () => {
    if (errosCampos.length > 0 || loading) return
    const result = await onSubmit({ projetoId, titulo: titulo.trim(), descricao: descricao.trim(), tipo, dependsOnTaskIds })
    if (result === false) return
    setProjetoId("")
    setTitulo("")
    setDescricao("")
    setTipo("desenvolvimento")
    setDependsOnTaskIds([])
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
      <TextField select SelectProps={{ multiple: true }} label="Depende das tarefas" value={dependsOnTaskIds.map(String)} onChange={(e) => setDependsOnTaskIds((e.target.value as unknown as string[]).map(Number).filter((id) => Number.isSafeInteger(id)))} fullWidth helperText="Todas as dependências precisam estar no mesmo projeto.">
        {tarefas.filter((tarefa) => String(tarefa.projetoId) === projetoId).map((tarefa) => <MenuItem key={tarefa.id} value={String(tarefa.id)}>{tarefa.titulo} (#{tarefa.id})</MenuItem>)}
      </TextField>
      <TextField
        label="Descrição" value={descricao} onChange={(e) => setDescricao(e.target.value)}
        multiline rows={3} fullWidth inputProps={{ "data-testid": "input-descricao" }}
      />
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
