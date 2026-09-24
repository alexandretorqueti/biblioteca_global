import type {
  DynamicField,
  DynamicFormValues,
} from "../types"
import {
  isValidCnpj,
  isValidCpf,
  isValidRg,
  isValidCep,
  isValidNomeCompleto,
  onlyDigits,
} from "./masks"

export type FormErrors = Record<string, string>

const isEmpty = (value: DynamicFormValues[string] | undefined): boolean =>
  value === "" || value === null || value === undefined

export const validateDynamicForm = (
  fields: DynamicField[],
  values: DynamicFormValues,
): FormErrors =>
  fields.reduce<FormErrors>((errors, field) => {
    const value = values[field.name]

    if (field.required && isEmpty(value)) {
      errors[field.name] = `${field.label} é obrigatório.`
      return errors
    }

    if (isEmpty(value)) {
      return errors
    }

    if (
      typeof value === "string" &&
      field.minLength !== undefined &&
      value.length < field.minLength
    ) {
      errors[field.name] =
        `${field.label} deve ter pelo menos ${field.minLength} caracteres.`
      return errors
    }

    if (
      typeof value === "string" &&
      field.maxLength !== undefined &&
      value.length > field.maxLength
    ) {
      errors[field.name] =
        `${field.label} deve ter no máximo ${field.maxLength} caracteres.`
      return errors
    }

    if (
      field.type === "email" &&
      typeof value === "string" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      errors[field.name] = "Informe um e-mail válido."
      return errors
    }

    if (field.type === "json" && typeof value === "string") {
      try {
        JSON.parse(value)
      } catch {
        errors[field.name] = "Informe um JSON válido."
      }
      return errors
    }

    if (
      field.validator === "cnpj" &&
      typeof value === "string" &&
      !isValidCnpj(value)
    ) {
      errors[field.name] = "Informe um CNPJ válido."
      return errors
    }

    if (
      field.validator === "cpf" &&
      typeof value === "string" &&
      !isValidCpf(value)
    ) {
      errors[field.name] = "Informe um CPF válido."
      return errors
    }

    if (
      field.validator === "rg" &&
      typeof value === "string" &&
      !isValidRg(value)
    ) {
      errors[field.name] = "Informe um RG válido."
      return errors
    }

    if (
      field.validator === "cep" &&
      typeof value === "string" &&
      !isValidCep(value)
    ) {
      errors[field.name] = "Informe um CEP válido."
      return errors
    }

    if (
      field.validator === "telefone" &&
      typeof value === "string"
    ) {
      // Remove o 55 inicial se presente para validar
      let digits = onlyDigits(value)
      if (digits.startsWith("55") && digits.length > 10) {
        digits = digits.slice(2)
      }
      if (digits.length < 10) {
        errors[field.name] = "Informe um telefone válido."
        return errors
      }
    }

    if (
      field.validator === "nomeCompleto" &&
      typeof value === "string" &&
      !isValidNomeCompleto(value)
    ) {
      errors[field.name] = "Informe o nome completo (pelo menos dois nomes)."
      return errors
    }

    if (
      typeof value === "number" &&
      field.min !== undefined &&
      value < field.min
    ) {
      errors[field.name] =
        `${field.label} deve ser maior ou igual a ${field.min}.`
      return errors
    }

    if (
      typeof value === "number" &&
      field.max !== undefined &&
      value > field.max
    ) {
      errors[field.name] =
        `${field.label} deve ser menor ou igual a ${field.max}.`
    }

    return errors
  }, {})
