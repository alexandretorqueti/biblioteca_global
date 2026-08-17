import { useCallback, useEffect, useState } from "react"
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"
import { AddRounded, PersonRounded } from "@mui/icons-material"
import type {
  CadastroDataSource,
  CustomAction,
  EntityRecord,
  FieldValues,
} from "../types"
import DynamicForm, {
  type DynamicField,
  type DynamicFormValues,
} from "./DynamicForm"
import JsonGrid, {
  type JsonGridColumnConfig,
  type JsonRecord,
} from "./JsonGrid"

interface CadastroProps<T extends EntityRecord> {
  dataSource: CadastroDataSource<T>
  title: string
  fields: DynamicField[]
  columnLabels?: Record<string, string>
  gridColumns?: Record<string, JsonGridColumnConfig>
  hiddenColumns?: string[]
  columns?: 1 | 2 | 3
  newLabel?: string
  description?: string
  /** Filhos master-detail. */
  children?: Array<{
    childResource: string
    fkField: string
    label: string
    dataSource: CadastroDataSource<EntityRecord>
  }>
  /** Ações customizadas (botões com estado executando/sucesso/erro). */
  actions?: CustomAction[]
  /** Executa uma ação customizada (injetado pelo runtime; UI não fala HTTP). */
  executeAction?: (action: CustomAction) => Promise<{ message: string }>
}

export default function Cadastro<T extends EntityRecord>({
  dataSource,
  title,
  fields,
  columnLabels = {},
  gridColumns = {},
  hiddenColumns = [],
  columns = 2,
  newLabel = "Novo registro",
  description = "Inclusão, edição, listagem e exclusão por funções injetadas.",
  children: childScreens = [],
  actions = [],
  executeAction,
}: CadastroProps<T>) {
  const [rows, setRows] = useState<T[]>([])
  const [selectedRow, setSelectedRow] = useState<T | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  /** Estado por tipo de ação: create/update/delete/null. null = inativo (nenhum botão desabilitado). */
  const [actionState, setActionState] = useState<
    "create" | "update" | "delete" | null
  >(null)
  /** Feedback visual: sucesso/erro. */
  const [feedback, setFeedback] = useState<{
    type?: "success" | "error"
    message: string
  } | null>(null)
  /** Ação customizada em execução (id) — desabilita todos os botões de ação. */
  const [executandoAcao, setExecutandoAcao] = useState<string | null>(null)
  /** Feedback por ação customizada (success/error). */
  const [acaoFeedback, setAcaoFeedback] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({})

  // Cache de filhos: `${rowId}_${fkField}` → EntityRecord[]
  const [filhosCache, setFilhosCache] = useState<Record<string, EntityRecord[]>>({})
  // Filhos sendo carregados (por chave) para exibir loading.
  const [carregandoFilhosChave, setCarregandoFilhosChave] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    setLoading(true)

    try {
      setRows(await dataSource.list())
    } catch (loadError) {
      setFeedback({
        type: "error",
        message:
          loadError instanceof Error
            ? loadError.message
            : "Não foi possível carregar os registros.",
      })
    } finally {
      setLoading(false)
    }
  }, [dataSource])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const openCreate = () => {
    setSelectedRow(null)
    setFeedback(null)
    setFormOpen(true)
  }

  const openEdit = (row: T) => {
    setSelectedRow(row)
    setFeedback(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    if (actionState === null) {
      setFormOpen(false)
      setSelectedRow(null)
    }
  }

  const handleSubmit = async (values: DynamicFormValues) => {
    setActionState(selectedRow ? "update" : "create")
    setFeedback(null)

    try {
      const payload: FieldValues = { ...values }
      for (const field of fields) {
        if (field.type === "json" && typeof payload[field.name] === "string") {
          const raw = payload[field.name] as string
          if (raw.trim() === "") {
            delete payload[field.name]
          } else {
            try {
              payload[field.name] = JSON.parse(raw)
            } catch {
              // Validação do form bloqueia JSON inválido.
            }
          }
        }
      }

      if (selectedRow) {
        await dataSource.update(selectedRow, payload)
        setFeedback({
          type: "success",
          message: "Registro atualizado com sucesso.",
        })
      } else {
        await dataSource.create(payload)
        setFeedback({
          type: "success",
          message: "Registro cadastrado com sucesso.",
        })
      }

      setFormOpen(false)
      setSelectedRow(null)
      await loadRows()
    } catch (saveError) {
      setFeedback({
        type: "error",
        message:
          saveError instanceof Error
            ? saveError.message
            : "Não foi possível salvar o registro.",
      })
    } finally {
      setActionState(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return

    setActionState("delete")
    setFeedback(null)

    try {
      await dataSource.remove(deleteTarget)
      setFeedback({
        type: "success",
        message: "Registro excluído com sucesso.",
      })
      setDeleteTarget(null)
      await loadRows()
    } catch (deleteError) {
      setFeedback({
        type: "error",
        message:
          deleteError instanceof Error
            ? deleteError.message
            : "Não foi possível excluir o registro.",
      })
    } finally {
      setActionState(null)
    }
  }

  // Executa uma ação customizada com feedback de estado.
  const executarAcao = async (action: CustomAction) => {
    if (!executeAction) return

    setExecutandoAcao(action.id)
    setAcaoFeedback((prev) => {
      const next = { ...prev }
      delete next[action.id]
      return next
    })

    try {
      const resultado = await executeAction(action)
      setAcaoFeedback((prev) => ({
        ...prev,
        [action.id]: {
          type: "success",
          message:
            resultado.message || `Ação "${action.label}" executada com sucesso.`,
        },
      }))
    } catch (acaoError) {
      setAcaoFeedback((prev) => ({
        ...prev,
        [action.id]: {
          type: "error",
          message:
            acaoError instanceof Error
              ? acaoError.message
              : `Não foi possível executar "${action.label}".`,
        },
      }))
    } finally {
      setExecutandoAcao(null)
    }
  }

  const initialValues = selectedRow
    ? fields.reduce<DynamicFormValues>((values, field) => {
        const value = selectedRow[field.name]
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          values[field.name] = value
        } else if (field.type === "json" && typeof value === "object" && value !== null) {
          values[field.name] = JSON.stringify(value, null, 2)
        }
        return values
      }, {})
    : undefined

  const formFields = fields.filter((field) =>
    selectedRow ? field.editable !== false : field.insertable !== false,
  )

  const gridHiddenColumns = fields
    .filter((field) => field.gridVisible === false)
    .map((field) => field.name)

  // Carregar filhos de um registro pai.
  const carregarFilhos = useCallback(
    async (row: T, cs: NonNullable<typeof childScreens>[number]) => {
      const rowId = dataSource.getRowId(row)
      const cacheKey = `${rowId}_${cs.fkField}`

      // Já em cache ou carregando — não dispara nova chamada.
      if (filhosCache[cacheKey] !== undefined || carregandoFilhosChave === cacheKey) {
        return filhosCache[cacheKey] ?? []
      }

      setCarregandoFilhosChave(cacheKey)
      try {
        const itens = await cs.dataSource.list({
          filters: { [cs.fkField]: rowId },
        })
        setFilhosCache((prev) => ({ ...prev, [cacheKey]: itens }))
        return itens
      } catch {
        return []
      } finally {
        setCarregandoFilhosChave(null)
      }
    },
    [filhosCache, carregandoFilhosChave, dataSource],
  )

  const temFilhos = childScreens.length > 0

  // Primeiro filho (sempre definido quando temFilhos).
  const primeiroFilho = temFilhos ? childScreens[0]! : undefined

  // Montar lista de filhos para o registro selecionado (efeito colateral).
  const [filhosRow, setFilhosRow] = useState<EntityRecord[]>([])
  useEffect(() => {
    if (!selectedRow || !temFilhos || !primeiroFilho) {
      setFilhosRow([])
      return
    }

    // Carregar filhos do primeiro childScreen.
    carregarFilhos(selectedRow, primeiroFilho)
      .then((result) => setFilhosRow(result))
      .catch(() => setFilhosRow([]))
  }, [selectedRow, temFilhos, carregarFilhos])

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "stretch", sm: "center" }}
        justifyContent="space-between"
        spacing={2}
      >
        <Box>
          <Typography variant="h5" fontWeight={900}>
            {title}
          </Typography>
          <Typography color="text.secondary">
            {description}
          </Typography>
        </Box>

        <Button
          variant="contained"
          size="large"
          startIcon={<AddRounded />}
          disabled={actionState !== null}
          onClick={openCreate}
        >
          {newLabel}
        </Button>
      </Stack>

      {feedback?.type === "error" && (
        <Alert severity="error">{feedback.message}</Alert>
      )}

      {feedback?.type === "success" && (
        <Alert severity="success">{feedback.message}</Alert>
      )}

      {actions.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {actions.map((action) => {
            const estado = acaoFeedback[action.id]
            const executando = executandoAcao === action.id
            return (
              <Stack key={action.id} spacing={1} alignItems="flex-start">
                <Button
                  variant="outlined"
                  disabled={executandoAcao !== null || !executeAction}
                  onClick={() => void executarAcao(action)}
                >
                  {executando ? `Executando ${action.label}...` : action.label}
                </Button>
                {estado && (
                  <Alert severity={estado.type} sx={{ py: 0 }}>
                    {estado.message}
                  </Alert>
                )}
              </Stack>
            )
          })}
        </Stack>
      )}

      <JsonGrid
        title={`Lista de ${title.toLowerCase()}`}
        data={rows as unknown as JsonRecord[]}
        loading={loading}
        hiddenColumns={[...hiddenColumns, ...gridHiddenColumns]}
        columnLabels={columnLabels}
        columns={gridColumns}
        getRowId={(row) => dataSource.getRowId(row as unknown as T)}
        onEdit={(row) => openEdit(row as unknown as T)}
        onDelete={(row) => setDeleteTarget(row as unknown as T)}
      />

      <Dialog
        open={formOpen}
        onClose={(ev, reason) => {
          if (reason === "backdropClick") return
          if (actionState !== null) return
          setFormOpen(false)
          setSelectedRow(null)
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {selectedRow ? "Editar registro" : newLabel}
        </DialogTitle>

        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Box sx={{ pt: 1 }}>
            <DynamicForm
              fields={formFields}
              columns={columns}
              initialValues={initialValues}
              loading={actionState !== null}
              actionState={
                selectedRow ? "update" : (actionState === "create" ? "create" : null)
              }
              submitLabel={selectedRow ? "Salvar alterações" : "Cadastrar"}
              onSubmit={handleSubmit}
              onCancel={closeForm}
            />
          </Box>

          {/* Lista de filhos master-detail */}
          {temFilhos && selectedRow && (
            <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, overflow: "hidden" }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, bgcolor: "action.hover" }}>
                <PersonRounded sx={{ color: "text.secondary", fontSize: 18 }} />
                <Typography variant="subtitle2">
                  {primeiroFilho!.label} ({filhosRow.length})
                </Typography>
              </Stack>
              <Divider />
              {carregandoFilhosChave && (
                <Box sx={{ p: 2, textAlign: "center", color: "text.disabled" }}>
                  Carregando...
                </Box>
              )}
              {!carregandoFilhosChave && filhosRow.length === 0 && (
                <Box sx={{ p: 2, fontStyle: "italic", color: "text.disabled" }}>
                  Nenhum registro encontrado.
                </Box>
              )}
              {!carregandoFilhosChave && filhosRow.length > 0 && (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      {filhosRow[0] ? Object.keys(filhosRow[0]).map((col) => (
                        <TableCell key={col} sx={{ fontWeight: 600, fontSize: 12, bgcolor: "action.hover", whiteSpace: "nowrap" }}>
                          {primeiroFilho!.label === col ? primeiroFilho!.label : col}
                        </TableCell>
                      )) : null}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filhosRow.map((f: EntityRecord, idx: number) => (
                      <TableRow key={idx}>
                        {Object.keys(f).map((col) => (
                          <TableCell key={col} sx={{ fontSize: 12 }}>
                            {f[col] !== null && typeof f[col] === "object"
                              ? JSON.stringify(f[col])
                              : String(f[col] ?? "")}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Paper>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => actionState !== "delete" && setDeleteTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Excluir registro</DialogTitle>

        <DialogContent>
          <Typography>
            Confirma a exclusão deste registro? Esta ação não poderá ser desfeita.
          </Typography>
        </DialogContent>

        <DialogActions>
          <Button disabled={actionState !== null} onClick={() => setDeleteTarget(null)}>
            Cancelar
          </Button>

          <Button color="error" variant="contained" disabled={actionState !== null} onClick={() => void confirmDelete()}>
            {actionState === "delete" ? "Excluindo..." : "Excluir"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
