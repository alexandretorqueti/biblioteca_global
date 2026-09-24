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
          total + Number(digit) * (weights[index] ?? 0),
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

/**
 * Formata CPF progressivamente: 000.000.000-00
 */
export const formatCpf = (value: string): string => {
  const digits = onlyDigits(value).slice(0, 11)

  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4")
}

/**
 * Valida CPF usando algoritmo de dígitos verificadores.
 */
export const isValidCpf = (value: string): boolean => {
  const digits = onlyDigits(value)

  if (digits.length !== 11 || /^(\d)\1+$/.test(digits)) {
    return false
  }

  const calculateDigit = (base: string, weights: number[]): number => {
    const sum = base
      .split("")
      .reduce(
        (total, digit, index) =>
          total + Number(digit) * (weights[index] ?? 0),
        0,
      )

    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }

  const firstDigit = calculateDigit(
    digits.slice(0, 9),
    [10, 9, 8, 7, 6, 5, 4, 3, 2],
  )
  const secondDigit = calculateDigit(
    digits.slice(0, 9) + firstDigit,
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
  )

  return digits.endsWith(`${firstDigit}${secondDigit}`)
}

/**
 * Formata telefone brasileiro progressivamente: +55 (21) 99999-9999
 * Aceita 10 dígitos (fixo) ou 11 dígitos (celular).
 * Sempre inclui o prefixo +55 (código do Brasil).
 */
export const formatTelefone = (value: string): string => {
  const digits = onlyDigits(value).slice(0, 13)

  // Remove o 55 inicial se presente para normalizar
  let normalized = digits
  if (normalized.startsWith("55") && normalized.length > 10) {
    normalized = normalized.slice(2)
  }
  normalized = normalized.slice(0, 11)

  // Sem DDD: (XX) XXXX-XXXX ou (XX) XXXXX-XXXX
  if (normalized.length <= 10) {
    const formatted = normalized
      .replace(/^(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d)/, "$1-$2")
    return normalized.length > 0 ? `+55 ${formatted}` : "+55"
  }

  // 11 dígitos (celular): (XX) XXXXX-XXXX
  const formatted = normalized
    .replace(/^(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2")
  return `+55 ${formatted}`
}

/**
 * Formata CEP: 00000-000
 */
export const formatCep = (value: string): string => {
  const digits = onlyDigits(value).slice(0, 8)

  return digits.replace(/^(\d{5})(\d)/, "$1-$2")
}

/**
 * Valida CEP: 8 dígitos.
 */
export const isValidCep = (value: string): boolean => {
  const digits = onlyDigits(value)
  return digits.length === 8
}

/**
 * Validação básica de RG: mínimo 5 dígitos após remoção de caracteres especiais.
 */
export const isValidRg = (value: string): boolean => {
  const digits = onlyDigits(value)
  return digits.length >= 5
}

/**
 * Valida nome completo: pelo menos dois nomes separados por espaço,
 * cada um com mínimo 2 caracteres.
 */
export const isValidNomeCompleto = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed) return false

  const parts = trimmed.split(/\s+/).filter((p) => p.length >= 2)
  return parts.length >= 2
}
