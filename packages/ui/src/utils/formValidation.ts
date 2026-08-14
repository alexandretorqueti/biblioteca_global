import type {
  DynamicField,
  DynamicFormValues,
} from "../types"
import { isValidCnpj } from "./masks"

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

    if (
      field.validator === "cnpj" &&
      typeof value === "string" &&
      !isValidCnpj(value)
    ) {
      errors[field.name] = "Informe um CNPJ válido."
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
