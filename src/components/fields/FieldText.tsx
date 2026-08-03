import { TextField } from "@mui/material"

interface FieldTextProps {
  name: string
  label: string
  value: string | number
  required?: boolean
  placeholder?: string
  helperText?: string
  disabled?: boolean
  minLength?: number
  maxLength?: number
  onChange: (name: string, value: string) => void
}

export default function FieldText({
  name,
  label,
  value,
  required = false,
  placeholder,
  helperText,
  disabled = false,
  minLength,
  maxLength,
  onChange,
}: FieldTextProps) {
  const length = String(value ?? "").length
  const showCounter = typeof maxLength === "number"

  return (
    <TextField
      name={name}
      label={label}
      value={value ?? ""}
      required={required}
      placeholder={placeholder}
      disabled={disabled}
      helperText={
        showCounter
          ? `${helperText ? `${helperText} · ` : ""}${length}/${maxLength}`
          : helperText
      }
      inputProps={{
        minLength,
        maxLength,
      }}
      onChange={(event) => onChange(name, event.target.value)}
    />
  )
}
