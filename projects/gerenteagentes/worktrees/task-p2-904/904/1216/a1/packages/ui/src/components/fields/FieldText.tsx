import { TextField } from "@mui/material"
import {
  formatCnpj,
  formatCpf,
  formatTelefone,
  formatCep,
  onlyDigits,
} from "../../utils/masks"

interface FieldTextProps {
  name: string
  label: string
  value: string | number
  required?: boolean
  placeholder?: string
  helperText?: string
  error?: string
  disabled?: boolean
  minLength?: number
  maxLength?: number
  mask?: "cnpj" | "cpf" | "telefone" | "cep" | "rg"
  onChange: (name: string, value: string) => void
}

export default function FieldText({
  name,
  label,
  value,
  required = false,
  placeholder,
  helperText,
  error,
  disabled = false,
  minLength,
  maxLength,
  mask,
  onChange,
}: FieldTextProps) {
  const length = String(value ?? "").length
  const showCounter = typeof maxLength === "number"
  const supportingText = error ?? helperText

  return (
    <TextField
      fullWidth
      name={name}
      label={label}
      value={value ?? ""}
      required={required}
      placeholder={placeholder}
      disabled={disabled}
      error={Boolean(error)}
      helperText={
        showCounter
          ? `${supportingText ? `${supportingText} · ` : ""}${length}/${maxLength}`
          : supportingText
      }
      inputProps={{
        minLength,
        maxLength,
      }}
      onChange={(event) => {
        const raw = event.target.value
        let nextValue = raw

        if (mask === "cnpj") {
          nextValue = formatCnpj(raw)
        } else if (mask === "cpf") {
          nextValue = formatCpf(raw)
        } else if (mask === "telefone") {
          nextValue = formatTelefone(raw)
        } else if (mask === "cep") {
          nextValue = formatCep(raw)
        } else if (mask === "rg") {
          nextValue = onlyDigits(raw)
        }

        onChange(name, nextValue)
      }}
    />
  )
}
