export const onlyDigits = (value: string): string =>
  value.replace(/\D/g, "")

export const formatCnpj = (value: string): string => {
  const digits = onlyDigits(value).slice(0, 14)

  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2")
}

export const isValidCnpj = (value: string): boolean => {
  const digits = onlyDigits(value)

  if (digits.length !== 14 || /^(\d)\1+$/.test(digits)) {
    return false
  }

  const calculateDigit = (base: string, weights: number[]): number => {
    const sum = base
      .split("")
      .reduce(
        (total, digit, index) =>
          total + Number(digit) * weights[index],
        0,
      )

    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }

  const firstDigit = calculateDigit(
    digits.slice(0, 12),
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  )
  const secondDigit = calculateDigit(
    digits.slice(0, 12) + firstDigit,
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  )

  return digits.endsWith(`${firstDigit}${secondDigit}`)
}
