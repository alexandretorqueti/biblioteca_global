import {
  Checkbox,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
} from "@mui/material"

export type BooleanFieldStyle = "checkbox" | "radio" | "select"

interface FieldBooleanProps {
  name: string
  label: string
  value: boolean
  style?: BooleanFieldStyle
  trueLabel?: string
  falseLabel?: string
  helperText?: string
  disabled?: boolean
  required?: boolean
  onChange: (name: string, value: boolean) => void
}

export default function FieldBoolean({
  name,
  label,
  value,
  style = "checkbox",
  trueLabel = "Sim",
  falseLabel = "Não",
  helperText,
  disabled = false,
  required = false,
  onChange,
}: FieldBooleanProps) {
  if (style === "radio") {
    return (
      <FormControl required={required} disabled={disabled}>
        <RadioGroup
          row
          name={name}
          value={value ? "true" : "false"}
          onChange={(event) =>
            onChange(name, event.target.value === "true")
          }
        >
          <FormControlLabel
            value="true"
            control={<Radio />}
            label={trueLabel}
          />
          <FormControlLabel
            value="false"
            control={<Radio />}
            label={falseLabel}
          />
        </RadioGroup>

        {helperText && (
          <FormHelperText>{helperText}</FormHelperText>
        )}
      </FormControl>
    )
  }

  if (style === "select") {
    return (
      <FormControl required={required} disabled={disabled}>
        <InputLabel>{label}</InputLabel>

        <Select
          name={name}
          label={label}
          value={value ? "true" : "false"}
          onChange={(event) =>
            onChange(name, event.target.value === "true")
          }
        >
          <MenuItem value="true">{trueLabel}</MenuItem>
          <MenuItem value="false">{falseLabel}</MenuItem>
        </Select>

        {helperText && (
          <FormHelperText>{helperText}</FormHelperText>
        )}
      </FormControl>
    )
  }

  return (
    <FormControl>
      <FormControlLabel
        control={
          <Checkbox
            name={name}
            checked={value}
            required={required}
            disabled={disabled}
            onChange={(event) =>
              onChange(name, event.target.checked)
            }
          />
        }
        label={value ? trueLabel : falseLabel}
      />

      {helperText && (
        <FormHelperText>{helperText}</FormHelperText>
      )}
    </FormControl>
  )
}
