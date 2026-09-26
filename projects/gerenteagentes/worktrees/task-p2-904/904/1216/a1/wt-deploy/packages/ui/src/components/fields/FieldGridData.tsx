import dayjs from "dayjs"

export type GridDateFormat =
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "YYYY-MM-DD"
  | string

interface FieldGridDataProps {
  value: unknown
  format?: GridDateFormat
  emptyValue?: string
}

export default function FieldGridData({
  value,
  format = "DD/MM/YYYY",
  emptyValue = "",
}: FieldGridDataProps) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return <>{emptyValue}</>
  }

  const date = dayjs(String(value))

  return <>{date.isValid() ? date.format(format) : String(value)}</>
}
