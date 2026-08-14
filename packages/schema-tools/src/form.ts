/**
 * Annotations de formulário no schema.ts (PoC §7.2, risco §12.3).
 *
 * Convenção do projeto: cada schema exporta um mapa `annotations` com
 * metadata por tabela/coluna — ex.:
 *
 *   export const annotations = {
 *     componentes: { nome: { label: "Nome", fullWidth: true } },
 *   } satisfies FormAnnotationsPorTabela
 *
 * (Um WeakMap no column-builder não funciona: o drizzle constrói instâncias
 * de Column distintas a partir dos builders, e a identidade se perderia.)
 */

/** Subconjunto serializável de DynamicFieldConfig controlável no schema. */
export interface FormAnnotation {
  /** Rótulo exibido; padrão = nome da coluna humanizado. */
  label?: string
  /** Força obrigatório/opcional (padrão deriva de notNull/default). */
  required?: boolean
  fullWidth?: boolean
  placeholder?: string
  helperText?: string
  /** Sobrescreve o tipo derivado da coluna (text, money, select...). */
  type?:
    | "text"
    | "email"
    | "number"
    | "date"
    | "textarea"
    | "select"
    | "switch"
    | "boolean"
    | "multipleChoice"
    | "photo"
    | "money"
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  currency?: string
  mask?: "cnpj"
  validator?: "cnpj"
  disabled?: boolean
}

/** Metadata por tabela → coluna. */
export type FormAnnotationsPorTabela = Record<
  string,
  Record<string, FormAnnotation>
>

/** Humaniza nome de coluna: created_at → "Created at". */
export function humanizarNome(nome: string): string {
  const limpo = nome.replace(/_/g, " ").trim()
  if (limpo.length === 0) return nome
  return limpo.charAt(0).toUpperCase() + limpo.slice(1).toLowerCase()
}
