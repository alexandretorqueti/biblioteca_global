/**
 * Tipos serializáveis de campos de formulário (DynamicForm).
 *
 * Derivados do DynamicField da v1 (biblioteca_old), sem funções:
 * `upload` (função) virou `uploadResource` (string — o api-client resolve),
 * `loadOptions` (função) virou `resource` (string — o api-client busca).
 * Fonte única: schema.ts do projeto gera estes campos na Etapa 6.
 */
import { z } from "zod"

export const dynamicFieldTypeSchema = z.enum([
  "text",
  "email",
  "number",
  "date",
  "textarea",
  "select",
  "switch",
  "boolean",
  "multipleChoice",
  "photo",
  "money",
])

export type DynamicFieldType = z.infer<typeof dynamicFieldTypeSchema>

export const dynamicFieldOptionSchema = z
  .object({
    label: z.string().min(1),
    value: z.union([z.string(), z.number()]),
  })
  .strict()

export type DynamicFieldOption = z.infer<typeof dynamicFieldOptionSchema>

/**
 * Config serializável do campo multipleChoice.
 * `resource` aponta para a tabela de onde o api-client carrega as opções.
 */
export const multipleChoiceFieldConfigSchema = z
  .object({
    resource: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    idField: z.string().min(1),
    displayField: z.string().min(1),
    minimumSearchLength: z.number().int().nonnegative().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    noOptionsText: z.string().optional(),
  })
  .strict()

export type MultipleChoiceFieldConfig = z.infer<
  typeof multipleChoiceFieldConfigSchema
>

/**
 * Campo de formulário serializável (config JSON nunca contém funções).
 */
export const dynamicFieldConfigSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: dynamicFieldTypeSchema,
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
    helperText: z.string().optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(dynamicFieldOptionSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    minDate: z.string().optional(),
    maxDate: z.string().optional(),
    booleanStyle: z.enum(["checkbox", "radio", "select"]).optional(),
    trueLabel: z.string().optional(),
    falseLabel: z.string().optional(),
    multipleChoice: multipleChoiceFieldConfigSchema.optional(),
    accept: z.string().optional(),
    maxFileSizeMb: z.number().positive().optional(),
    /** Nome do resource de upload — o api-client envia e devolve a URL. */
    uploadResource: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    currency: z.string().optional(),
    currencyLocale: z.string().optional(),
    minimumFractionDigits: z.number().int().min(0).max(20).optional(),
    maximumFractionDigits: z.number().int().min(0).max(20).optional(),
    mask: z.enum(["cnpj"]).optional(),
    validator: z.enum(["cnpj"]).optional(),
    fullWidth: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()

export type DynamicFieldConfig = z.infer<typeof dynamicFieldConfigSchema>
