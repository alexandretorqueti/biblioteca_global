import { FocusEvent, useEffect, useMemo, useState } from "react"
import { InputAdornment, TextField } from "@mui/material"

interface FieldMoneyProps {
  name: string
  label: string
  value: string | number
  required?: boolean
  helperText?: string
  disabled?: boolean
  currency?: string
  locale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  min?: number
  max?: number
  onChange: (name: string, value: string | number) => void
}

const parseMoney = (input: string): number | null => {
  const clean = input.replace(/[^0-9,.-]/g, "")
  const negative = clean.startsWith("-")
  const unsigned = clean.replace(/-/g, "")
  const decimalPosition = Math.max(
    unsigned.lastIndexOf(","),
    unsigned.lastIndexOf("."),
  )

  const integerPart =
    decimalPosition >= 0
      ? unsigned.slice(0, decimalPosition).replace(/\D/g, "")
      : unsigned.replace(/\D/g, "")

  const fractionPart =
    decimalPosition >= 0
      ? unsigned.slice(decimalPosition + 1).replace(/\D/g, "")
      : ""

  if (!integerPart && !fractionPart) {
    return null
  }

  const normalized = `${negative ? "-" : ""}${integerPart || "0"}${
    fractionPart ? `.${fractionPart}` : ""
  }`

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export default function FieldMoney({
  name,
  label,
  value,
  required = false,
  helperText,
  disabled = false,
  currency = "BRL",
  locale = "pt-BR",
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  min,
  max,
  onChange,
}: FieldMoneyProps) {
  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits,
        maximumFractionDigits,
      }),
    [
      currency,
      locale,
      maximumFractionDigits,
      minimumFractionDigits,
    ],
  )

  const currencySymbol =
    formatter
      .formatToParts(0)
      .find((part) => part.type === "currency")
      ?.value ?? currency

  const formatValue = (currentValue: string | number) => {
    if (currentValue === "") {
      return ""
    }

    const numericValue = Number(currentValue)
    return Number.isFinite(numericValue)
      ? formatter.format(numericValue)
      : ""
  }

  const [displayValue, setDisplayValue] = useState(() =>
    formatValue(value),
  )
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) {
      setDisplayValue(formatValue(value))
    }
  }, [value, focused, formatter])

  const handleFocus = () => {
    setFocused(true)
    setDisplayValue(value === "" ? "" : String(value).replace(".", ","))
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    setFocused(false)
    const parsed = parseMoney(event.target.value)
    setDisplayValue(parsed === null ? "" : formatter.format(parsed))
  }

  return (
    <TextField
      fullWidth
      name={name}
      label={label}
      value={displayValue}
      required={required}
      disabled={disabled}
      helperText={helperText}
      inputProps={{
        inputMode: "decimal",
        min,
        max,
      }}
      InputProps={{
        startAdornment: focused ? (
          <InputAdornment position="start">
            {currencySymbol}
          </InputAdornment>
        ) : undefined,
      }}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={(event) => {
        const nextDisplayValue = event.target.value
        const parsed = parseMoney(nextDisplayValue)

        setDisplayValue(nextDisplayValue)
        onChange(name, parsed ?? "")
      }}
    />
  )
}
