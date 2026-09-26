import { FormEvent, useEffect, useMemo, useState } from "react"
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import Field from "./fields/Field"
import {
  validateDynamicForm,
  type FormErrors,
} from "../utils/formValidation"
import type {
  DynamicField,
  DynamicFormValues,
} from "../types"

export type {
  DynamicField,
  DynamicFieldOption,
  DynamicFieldType,
  DynamicFormValues,
} from "../types"

export interface DynamicFormProps {
  fields: DynamicField[]
  title?: string
  submitLabel?: string
  cancelLabel?: string
  columns?: 1 | 2 | 3
  initialValues?: DynamicFormValues
  loading?: boolean
  successMessage?: string
  /** Identificador de ação atual (create/update/delete) para rótulo dinâmico. */
  actionState?: "create" | "update" | "delete" | null
  onSubmit: (values: DynamicFormValues) => void | Promise<void>
  onCancel?: () => void
}

/** Labels usadas no botão de submit durante cada estado de ação. */
const SUBMIT_LABELS_LOADING: Record<string, string> = {
  create: "Cadastrando...",
  update: "Salvando...",
  delete: "Excluindo...",
}

export default function DynamicForm({
  fields,
  title,
  submitLabel = "Enviar",
  cancelLabel = "Cancelar",
  columns = 2,
  initialValues,
  loading = false,
  successMessage,
  actionState = null,
  onSubmit,
  onCancel,
}: DynamicFormProps) {
  const displaySubmitLabel =
    loading && actionState !== null
      ? SUBMIT_LABELS_LOADING[actionState] ?? "Executando..."
      : submitLabel;
  const defaultValues = useMemo(
    () =>
      fields.reduce<DynamicFormValues>((values, field) => {
        values[field.name] =
          field.defaultValue ??
          (field.type === "switch" || field.type === "boolean" ? false : "")
        return values
      }, {}),
    [fields],
  )

  const [values, setValues] = useState<DynamicFormValues>({
    ...defaultValues,
    ...initialValues,
  })
  const [errors, setErrors] = useState<FormErrors>({})

  useEffect(() => {
    setValues({
      ...defaultValues,
      ...initialValues,
    })
    setErrors({})
  }, [defaultValues, initialValues])

  const updateValue = (
    name: string,
    value: string | number | boolean,
  ) => {
    setValues((current) => ({ ...current, [name]: value }))
    setErrors((current) => {
      if (!current[name]) {
        return current
      }

      const next = { ...current }
      delete next[name]
      return next
    })
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    const validationErrors = validateDynamicForm(fields, values)
    setErrors(validationErrors)

    if (Object.keys(validationErrors).length > 0) {
      return
    }

    await onSubmit(values)
  }

  return (
    <Paper
      component="form"
      onSubmit={handleSubmit}
      noValidate
      elevation={0}
      sx={{
        p: { xs: 2, md: 3 },
        border: "1px solid",
        borderColor: "divider",
      }}
    >
      <Stack spacing={3}>
        {title && (
          <Typography variant="h6" fontWeight={800}>
            {title}
          </Typography>
        )}

        {successMessage && (
          <Alert severity="success">{successMessage}</Alert>
        )}

        {Object.keys(errors).length > 0 && (
          <Alert severity="error">
            Revise os campos destacados antes de continuar.
          </Alert>
        )}

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: `repeat(${columns}, minmax(0, 1fr))`,
            },
            gap: 2,
          }}
        >
          {fields.map((field) => (
            <Box
              key={field.name}
              sx={{
                gridColumn: field.fullWidth ? "1 / -1" : "auto",
              }}
            >
              <Field
                field={field}
                value={values[field.name] ?? ""}
                error={errors[field.name]}
                loading={loading}
                onChange={updateValue}
              />
            </Box>
          ))}
        </Box>

        <Stack direction="row" spacing={2}>
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={loading}
            startIcon={
              loading ? (
                <CircularProgress size={20} color="inherit" />
              ) : undefined
            }
          >
            {displaySubmitLabel}
          </Button>

          {onCancel && (
            <Button
              type="button"
              variant="outlined"
              size="large"
              disabled={loading}
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}
