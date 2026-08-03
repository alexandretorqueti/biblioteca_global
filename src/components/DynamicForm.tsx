import { FormEvent, useEffect, useMemo, useState } from "react"
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import Field from "./fields/Field"
import type { MultipleChoiceConfig } from "./fields/FieldMultipleChoice"

export type DynamicFieldType =
  | "text"
  | "email"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "switch"
  | "boolean"
  | "multipleChoice"

export interface DynamicFieldOption {
  label: string
  value: string | number
}

export interface DynamicField {
  name: string
  label: string
  type: DynamicFieldType
  required?: boolean
  placeholder?: string
  helperText?: string
  defaultValue?: string | number | boolean
  options?: DynamicFieldOption[]
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  minDate?: string
  maxDate?: string
  booleanStyle?: "checkbox" | "radio" | "select"
  trueLabel?: string
  falseLabel?: string
  multipleChoice?: MultipleChoiceConfig
  fullWidth?: boolean
  disabled?: boolean
}

export type DynamicFormValues = Record<string, string | number | boolean>

interface DynamicFormProps {
  fields: DynamicField[]
  title?: string
  submitLabel?: string
  cancelLabel?: string
  columns?: 1 | 2 | 3
  initialValues?: DynamicFormValues
  loading?: boolean
  successMessage?: string
  onSubmit: (values: DynamicFormValues) => void | Promise<void>
  onCancel?: () => void
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
  onSubmit,
  onCancel,
}: DynamicFormProps) {
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

  useEffect(() => {
    setValues({
      ...defaultValues,
      ...initialValues,
    })
  }, [defaultValues, initialValues])

  const updateValue = (
    name: string,
    value: string | number | boolean,
  ) => {
    setValues((current) => ({ ...current, [name]: value }))
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    await onSubmit(values)
  }

  return (
    <Paper
      component="form"
      onSubmit={handleSubmit}
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
          >
            {submitLabel}
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
