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
import FieldBoolean from "./FieldBoolean"
import FieldMultipleChoice from "./FieldMultipleChoice"
import FieldPhoto from "./FieldPhoto"
import FieldMoney from "./FieldMoney"

interface FieldProps {
  field: DynamicField
  value: string | number | boolean
  error?: string
  loading?: boolean
  onChange: (
    name: string,
    value: DynamicFormValues[string],
  ) => void
}

export default function Field({
  field,
  value,
  error,
  loading = false,
  onChange,
}: FieldProps) {
  const disabled = field.disabled || loading
  const helperText = error ?? field.helperText

  if (field.type === "text" || field.type === "email") {
    return (
      <FieldText
        name={field.name}
        label={field.label}
        value={typeof value === "boolean" ? "" : value}
        required={field.required}
        placeholder={field.placeholder}
        helperText={field.helperText}
        error={error}
        disabled={disabled}
        minLength={field.minLength}
        maxLength={field.maxLength}
        mask={field.mask}
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
        helperText={helperText}
        disabled={disabled}
        minDate={field.minDate}
        maxDate={field.maxDate}
        onChange={onChange}
      />
    )
  }

  if (field.type === "money") {
    return (
      <FieldMoney
        name={field.name}
        label={field.label}
        value={typeof value === "boolean" ? "" : value}
        required={field.required}
        helperText={helperText}
        disabled={disabled}
        currency={field.currency}
        locale={field.currencyLocale}
        minimumFractionDigits={field.minimumFractionDigits}
        maximumFractionDigits={field.maximumFractionDigits}
        min={field.min}
        max={field.max}
        onChange={onChange}
      />
    )
  }

  if (field.type === "photo") {
    return (
      <FieldPhoto
        name={field.name}
        label={field.label}
        value={typeof value === "string" ? value : ""}
        required={field.required}
        helperText={field.helperText}
        validationError={error}
        disabled={disabled}
        accept={field.accept}
        maxFileSizeMb={field.maxFileSizeMb}
        uploadUrl={field.uploadUrl}
        onChange={onChange}
      />
    )
  }

  if (field.type === "multipleChoice" && field.multipleChoice) {
    return (
      <FieldMultipleChoice
        name={field.name}
        label={field.label}
        value={typeof value === "boolean" ? "" : value}
        config={field.multipleChoice}
        required={field.required}
        helperText={helperText}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }

  if (field.type === "boolean") {
    return (
      <FieldBoolean
        name={field.name}
        label={field.label}
        value={Boolean(value)}
        style={field.booleanStyle}
        trueLabel={field.trueLabel}
        falseLabel={field.falseLabel}
        helperText={helperText}
        disabled={disabled}
        required={field.required}
        onChange={onChange}
      />
    )
  }

  if (field.type === "switch") {
    return (
      <FormControl error={Boolean(error)}>
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
        {helperText && <FormHelperText>{helperText}</FormHelperText>}
      </FormControl>
    )
  }

  if (field.type === "select") {
    return (
      <FormControl
        fullWidth
        required={field.required}
        disabled={disabled}
        error={Boolean(error)}
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
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>

        {helperText && <FormHelperText>{helperText}</FormHelperText>}
      </FormControl>
    )
  }

  return (
    <TextField
      fullWidth
      name={field.name}
      label={field.label}
      type={field.type === "textarea" ? "text" : field.type}
      value={value ?? ""}
      required={field.required}
      disabled={disabled}
      placeholder={field.placeholder}
      helperText={helperText}
      error={Boolean(error)}
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
            ? event.target.value === ""
              ? ""
              : Number(event.target.value)
            : event.target.value,
        )
      }
    />
  )
}
