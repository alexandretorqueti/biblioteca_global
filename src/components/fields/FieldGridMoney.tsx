interface FieldGridMoneyProps {
  value: unknown
  currency?: string
  locale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  emptyValue?: string
}

export default function FieldGridMoney({
  value,
  currency = "BRL",
  locale = "pt-BR",
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  emptyValue = "",
}: FieldGridMoneyProps) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return <>{emptyValue}</>
  }

  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return <>{String(value)}</>
  }

  return (
    <>
      {new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits,
        maximumFractionDigits,
      }).format(numericValue)}
    </>
  )
}
