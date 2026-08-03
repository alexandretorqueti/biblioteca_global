import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material"
import { AddRounded } from "@mui/icons-material"
import { createEntityController } from "../controllers/entityController"
import type { EntityRecord } from "../api/entityApi"
import DynamicForm, {
  type DynamicField,
  type DynamicFormValues,
} from "./DynamicForm"
import JsonGrid, {
  type JsonGridColumnConfig,
  type JsonRecord,
} from "./JsonGrid"

interface CadastroProps<T extends EntityRecord> {
  entity: string
  title: string
  fields: DynamicField[]
  columnLabels?: Record<string, string>
  gridColumns?: Record<string, JsonGridColumnConfig>
  hiddenColumns?: string[]
  columns?: 1 | 2 | 3
  newLabel?: string
  getRowId?: (row: T) => string | number
}

export default function Cadastro<T extends EntityRecord>({
  entity,
  title,
  fields,
  columnLabels = {},
  gridColumns = {},
  hiddenColumns = [],
  columns = 2,
  newLabel = "Novo registro",
  getRowId,
}: CadastroProps<T>) {
  const controller = useMemo(
    () => createEntityController<T>(entity),
    [entity],
  )

  const [rows, setRows] = useState<T[]>([])
  const [selectedRow, setSelectedRow] = useState<T | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [successMessage, setSuccessMessage] = useState("")

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError("")

    try {
      setRows(await controller.list())
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Não foi possível carregar os registros.",
      )
    } finally {
      setLoading(false)
    }
  }, [controller])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const resolveId = (row: T): string | number => {
    if (getRowId) {
      return getRowId(row)
    }

    const id = row[controller.primaryKey]

    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error(
        `A chave primária "${controller.primaryKey}" não é válida.`,
      )
    }

    return id
  }

  const openCreate = () => {
    setSelectedRow(null)
    setSuccessMessage("")
    setError("")
    setFormOpen(true)
  }

  const openEdit = (row: T) => {
    setSelectedRow(row)
    setSuccessMessage("")
    setError("")
    setFormOpen(true)
  }

  const closeForm = () => {
    if (!saving) {
      setFormOpen(false)
      setSelectedRow(null)
    }
  }

  const handleSubmit = async (values: DynamicFormValues) => {
    setSaving(true)
    setError("")

    try {
      if (selectedRow) {
        await controller.update(resolveId(selectedRow), values as unknown as Partial<T>)
        setSuccessMessage("Registro atualizado com sucesso.")
      } else {
        await controller.create(values)
        setSuccessMessage("Registro cadastrado com sucesso.")
      }

      setFormOpen(false)
      setSelectedRow(null)
      await loadRows()
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Não foi possível salvar o registro.",
      )
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }

    setSaving(true)
    setError("")

    try {
      await controller.remove(resolveId(deleteTarget))
      setSuccessMessage("Registro excluído com sucesso.")
      setDeleteTarget(null)
      await loadRows()
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Não foi possível excluir o registro.",
      )
    } finally {
      setSaving(false)
    }
  }

  const initialValues = selectedRow
    ? fields.reduce<DynamicFormValues>((values, field) => {
        const value = selectedRow[field.name]

        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          values[field.name] = value
        }

        return values
      }, {})
    : undefined

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
            Inclusão, edição, listagem e exclusão integradas à entidade
            configurada.
          </Typography>
        </Box>

        <Button
          variant="contained"
          size="large"
          startIcon={<AddRounded />}
          onClick={openCreate}
        >
          {newLabel}
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      {successMessage && (
        <Alert severity="success">{successMessage}</Alert>
      )}

      <JsonGrid
        title={`Lista de ${title.toLowerCase()}`}
        data={rows as unknown as JsonRecord[]}
        loading={loading}
        hiddenColumns={hiddenColumns}
        columnLabels={columnLabels}
        columns={gridColumns}
        getRowId={(row) =>
          resolveId(row as unknown as T)
        }
        onEdit={(row) => openEdit(row as unknown as T)}
        onDelete={(row) =>
          setDeleteTarget(row as unknown as T)
        }
      />

      <Dialog
        open={formOpen}
        onClose={closeForm}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {selectedRow ? "Editar registro" : newLabel}
        </DialogTitle>

        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <DynamicForm
              fields={fields}
              columns={columns}
              initialValues={initialValues}
              loading={saving}
              submitLabel={selectedRow ? "Salvar alterações" : "Cadastrar"}
              onSubmit={handleSubmit}
              onCancel={closeForm}
            />
          </Box>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => !saving && setDeleteTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Excluir registro</DialogTitle>

        <DialogContent>
          <Typography>
            Confirma a exclusão deste registro? Esta ação não poderá ser
            desfeita.
          </Typography>
        </DialogContent>

        <DialogActions>
          <Button
            disabled={saving}
            onClick={() => setDeleteTarget(null)}
          >
            Cancelar
          </Button>

          <Button
            color="error"
            variant="contained"
            disabled={saving}
            onClick={() => void confirmDelete()}
          >
            Excluir
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
