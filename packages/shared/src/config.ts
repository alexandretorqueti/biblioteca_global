/**
 * Config serializável do GeradorSistema (PoC §7).
 *
 * O que era função/JSX na v1 virou dado:
 * - dataSource (função)      → resource (string) — api-client monta o CRUD
 * - logo/icon (ReactNode)    → string (nome do ícone) — mapa no front
 * - tela custom (JSX)        → componentId (string) — registry no front
 *
 * Nomes mantidos da v1 (GeradorSistemaAppConfig/Route/Group/Config) por
 * consistência com a API pública antiga.
 */
import { z } from "zod"
import { dynamicFieldConfigSchema } from "./field.js"

export const geradorSistemaAppConfigSchema = z
  .object({
    name: z.string().min(1),
    /** Nome do ícone/logo — resolvido por mapa no front. */
    logo: z.string().min(1).optional(),
  })
  .strict()

export type GeradorSistemaAppConfig = z.infer<
  typeof geradorSistemaAppConfigSchema
>

/**
 * Overrides de apresentação de uma tela cadastro — só o que difere do
 * gerado pelo schema do projeto. Nunca inventar campo inexistente
 * (validado contra o schema no salvamento — PoC §7.4).
 */
export const cadastroOverridesConfigSchema = z
  .object({
    fields: z.array(dynamicFieldConfigSchema).optional(),
    hiddenColumns: z.array(z.string().min(1)).optional(),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    newLabel: z.string().min(1).optional(),
  })
  .strict()

export type CadastroOverridesConfig = z.infer<
  typeof cadastroOverridesConfigSchema
>

/**
 * Tela de CRUD gerada: `resource` = nome de tabela no schema.ts do projeto
 * (whitelist no back — PoC §6.2). `fields` carrega a base gerada do schema;
 * `overrides` ajusta apenas apresentação.
 */
export const cadastroScreenConfigSchema = z
  .object({
    kind: z.literal("cadastro"),
    resource: z.string().regex(/^[a-z][a-z0-9_]*$/),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    fields: z.array(dynamicFieldConfigSchema).optional(),
    overrides: cadastroOverridesConfigSchema.optional(),
  })
  .strict()

export type CadastroScreenConfig = z.infer<typeof cadastroScreenConfigSchema>

/**
 * Tela custom: `componentId` resolve no registry de telas do front
 * (telas da pasta projects/<slug>/screens/).
 */
export const customScreenConfigSchema = z
  .object({
    kind: z.literal("custom"),
    componentId: z.string().min(1),
  })
  .strict()

export type CustomScreenConfig = z.infer<typeof customScreenConfigSchema>

export const screenConfigSchema = z.discriminatedUnion("kind", [
  cadastroScreenConfigSchema,
  customScreenConfigSchema,
])

export type ScreenConfig = z.infer<typeof screenConfigSchema>

/** Item de menu (nome da v1: GeradorSistemaRoute). */
export const geradorSistemaRouteSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    path: z.string().min(1),
    description: z.string().optional(),
    /** Nome do ícone — resolvido por mapa no front. */
    icon: z.string().min(1).optional(),
    screen: screenConfigSchema,
  })
  .strict()

export type GeradorSistemaRoute = z.infer<typeof geradorSistemaRouteSchema>

export const geradorSistemaGroupSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    // items pode ficar vazio: projeto novo nasce sem telas de negócio;
    // a tela Usuários é injetada automaticamente pela plataforma (PoC §8).
    items: z.array(geradorSistemaRouteSchema),
  })
  .strict()

export type GeradorSistemaGroup = z.infer<typeof geradorSistemaGroupSchema>

export const geradorSistemaConfigSchema = z
  .object({
    app: geradorSistemaAppConfigSchema,
    drawerWidth: z.number().int().positive().optional(),
    groups: z.array(geradorSistemaGroupSchema),
  })
  .strict()

export type GeradorSistemaConfig = z.infer<typeof geradorSistemaConfigSchema>
