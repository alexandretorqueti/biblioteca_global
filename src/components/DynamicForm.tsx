import { FormEvent, useMemo, useState } from "react"
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material"

export type DynamicFieldType =
  | "text"
  | "email"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "switch"

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
  fullWidth?: boolean
}

export type DynamicFormValues = Record<string, string | number | boolean>

interface DynamicFormProps {
  fields: DynamicField[]
  title?: string
  submitLabel?: string
  columns?: 1 | 2 | 3
  onSubmit: (values: DynamicFormValues) => void
}

export default function DynamicForm({
  fields,
  title,
  submitLabel = "Enviar",
  columns = 2,
  onSubmit,
}: DynamicFormProps) {
  const initialValues = useMemo(
    () =>
      fields.reduce<DynamicFormValues>((values, field) => {
        values[field.name] =
          field.defaultValue ?? (field.type === "switch" ? false : "")
        return values
      }, {}),
    [fields],
  )

  const [values, setValues] = useState<DynamicFormValues>(initialValues)
  const [submitted, setSubmitted] = useState(false)

  const updateValue = (name: string, value: string | number | boolean) => {
    setSubmitted(false)
    setValues((current) => ({ ...current, [name]: value }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(values)
    setSubmitted(true)
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

        {submitted && (
          <Alert severity="success">
            Formulário enviado com sucesso.
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
          {fields.map((field) => {
            const commonGridSx = {
              gridColumn: field.fullWidth ? "1 / -1" : "auto",
            }

            if (field.type === "switch") {
              return (
                <FormControlLabel
                  key={field.name}
                  sx={commonGridSx}
                  control={
                    <Switch
                      checked={Boolean(values[field.name])}
                      onChange={(event) =>
                        updateValue(field.name, event.target.checked)
                      }
                    />
                  }
                  label={field.label}
                />
              )
            }

            if (field.type === "select") {
              return (
                <FormControl
                  key={field.name}
                  required={field.required}
                  sx={commonGridSx}
                >
                  <InputLabel>{field.label}</InputLabel>
                  <Select
                    label={field.label}
                    value={values[field.name]}
                    onChange={(event) =>
                      updateValue(
                        field.name,
                        event.target.value as string | number,
                      )
                    }
                  >
                    {field.options?.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </Select>
                  {field.helperText && (
                    <FormHelperText>{field.helperText}</FormHelperText>
                  )}
                </FormControl>
              )
            }

            return (
              <TextField
                key={field.name}
                label={field.label}
                type={
                  field.type === "textarea" ? "text" : field.type
                }
                value={values[field.name]}
                required={field.required}
                placeholder={field.placeholder}
                helperText={field.helperText}
                multiline={field.type === "textarea"}
                minRows={field.type === "textarea" ? 4 : undefined}
                inputProps={{
                  min: field.min,
                  max: field.max,
                }}
                onChange={(event) =>
                  updateValue(
                    field.name,
                    field.type === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                  )
                }
                sx={commonGridSx}
              />
            )
          })}
        </Box>

        <Box>
          <Button type="submit" variant="contained" size="large">
            {submitLabel}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}
