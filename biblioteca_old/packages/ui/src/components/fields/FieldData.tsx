import dayjs, { type Dayjs } from "dayjs"
import "dayjs/locale/pt-br.js"
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider"
import { DatePicker } from "@mui/x-date-pickers/DatePicker"
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs"

interface FieldDateProps {
  name: string
  label: string
  value: string
  required?: boolean
  helperText?: string
  disabled?: boolean
  minDate?: string
  maxDate?: string
  onChange: (name: string, value: string) => void
}

export default function FieldDate({
  name,
  label,
  value,
  required = false,
  helperText,
  disabled = false,
  minDate,
  maxDate,
  onChange,
}: FieldDateProps) {
  const parsedValue = value ? dayjs(value) : null

  const handleChange = (date: Dayjs | null) => {
    onChange(name, date?.isValid() ? date.format("YYYY-MM-DD") : "")
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="pt-br">
      <DatePicker
        label={label}
        value={parsedValue}
        disabled={disabled}
        minDate={minDate ? dayjs(minDate) : undefined}
        maxDate={maxDate ? dayjs(maxDate) : undefined}
        onChange={handleChange}
        slotProps={{
          textField: {
            name,
            required,
            helperText,
            fullWidth: true,
          },
        }}
      />
    </LocalizationProvider>
  )
}
