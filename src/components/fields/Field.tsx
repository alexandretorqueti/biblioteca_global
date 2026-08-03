import {
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
} from "@mui/material"
import type {
  DynamicField,
  DynamicFormValues,
} from "../DynamicForm"
import FieldText from "./FieldText"
import FieldData from "./FieldData"

interface FieldProps {
  field: DynamicField
  value: string | number | boolean
  loading?: boolean
  onChange: (
    name: string,
    value: DynamicFormValues[string],
  ) => void
}

export default function Field({
  field,
  value,
  loading = false,
  onChange,
}: FieldProps) {
  const disabled = field.disabled || loading

  if (field.type === "text" || field.type === "email") {
    return (
      <FieldText
        name={field.name}
        label={field.label}
        value={typeof value === "boolean" ? "" : value}
        required={field.required}
        placeholder={field.placeholder}
        helperText={field.helperText}
        disabled={disabled}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={onChange}
      />
    )
  }

  if (field.type === "date") {
    return (
      <FieldData
        name={field.name}
        label={field.label}
        value={typeof value === "string" ? value : ""}
        required={field.required}
        helperText={field.helperText}
        disabled={disabled}
        minDate={field.minDate}
        maxDate={field.maxDate}
        onChange={onChange}
      />
    )
  }

  if (field.type === "switch") {
    return (
      <FormControlLabel
        control={
          <Switch
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(event) =>
              onChange(field.name, event.target.checked)
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
        required={field.required}
        disabled={disabled}
      >
        <InputLabel>{field.label}</InputLabel>
        <Select
          label={field.label}
          value={value ?? ""}
          onChange={(event) =>
            onChange(
              field.name,
              event.target.value as string | number,
            )
          }
        >
          {field.options?.map((option) => (
            <MenuItem
              key={option.value}
              value={option.value}
            >
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
      name={field.name}
      label={field.label}
      type={field.type === "textarea" ? "text" : field.type}
      value={value ?? ""}
      required={field.required}
      disabled={disabled}
      placeholder={field.placeholder}
      helperText={field.helperText}
      multiline={field.type === "textarea"}
      minRows={field.type === "textarea" ? 4 : undefined}
      inputProps={{
        min: field.min,
        max: field.max,
      }}
      onChange={(event) =>
        onChange(
          field.name,
          field.type === "number"
            ? Number(event.target.value)
            : event.target.value,
        )
      }
    />
  )
}
