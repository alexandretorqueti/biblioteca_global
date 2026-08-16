import { useCallback, useEffect, useState } from "react"
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
import type {
  CadastroDataSource,
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
}: CadastroProps<T>) {
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
      setRows(await dataSource.list())
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Não foi possível carregar os registros.",
      )
    } finally {
      setLoading(false)
    }
  }, [dataSource])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

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
      // Campos json chegam como string do form — converte de volta a objeto.
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
              // Não chega aqui: a validação do form bloqueia JSON inválido.
            }
          }
        }
      }

      if (selectedRow) {
        await dataSource.update(selectedRow, payload)
        setSuccessMessage("Registro atualizado com sucesso.")
      } else {
        await dataSource.create(payload)
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
      await dataSource.remove(deleteTarget)
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
        } else if (
          field.type === "json" &&
          typeof value === "object" &&
          value !== null
        ) {
          // Campo json: o form trabalha com string — serializa para edição.
          values[field.name] = JSON.stringify(value, null, 2)
        }

        return values
      }, {})
    : undefined

  // Onde o campo aparece: criação → insertable; edição → editable.
  const formFields = fields.filter((field) =>
    selectedRow ? field.editable !== false : field.insertable !== false,
  )

  // Campos com gridVisible: false não viram coluna da grid.
  const gridHiddenColumns = fields
    .filter((field) => field.gridVisible === false)
    .map((field) => field.name)

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
        hiddenColumns={[...hiddenColumns, ...gridHiddenColumns]}
        columnLabels={columnLabels}
        columns={gridColumns}
        getRowId={(row) =>
          dataSource.getRowId(row as unknown as T)
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
              fields={formFields}
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
