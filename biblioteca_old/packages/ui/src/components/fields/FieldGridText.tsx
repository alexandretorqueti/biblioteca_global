interface FieldGridTextProps {
  value: unknown
}

export default function FieldGridText({
  value,
}: FieldGridTextProps) {
  if (value === null || value === undefined) {
    return null
  }

  return <>{String(value)}</>
}
