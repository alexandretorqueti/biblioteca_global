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

/** HTTP method permitido para telas externas. */
const httpMethodSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
])

export type HttpMethod = z.infer<typeof httpMethodSchema>

/** Action customizada em telas (cadastro ou external). */
export const customActionSchema = z.object({
  /** Identificador único da action dentro da tela. */
  id: z.string().min(1),
  /** Rótulo exibido na interface. */
  label: z.string().min(1),
  /** Método HTTP permitido para esta action. */
  method: httpMethodSchema,
  /** Caminho da requisição — obrigatório, sem default. */
  path: z.string().min(1),
  /** Texto de confirmação (opcional). Quando presente, o front mostra um dialog antes de executar. */
  confirm: z.string().optional(),
}).strict()

export type CustomAction = z.infer<typeof customActionSchema>

/** Tela filha (master-detail): childResource + fkField de ligação + label. */
export const childScreenSchema = z.object({
  childResource: z.string().regex(/^[a-z][a-z0-9_]*$/),
  fkField: z.string().min(1),
  label: z.string().min(1),
}).strict()

export type ChildScreen = z.infer<typeof childScreenSchema>

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
    /**
     * Telas relacionadas (master-detail): childResource deve ser tabela
     * existente no schema do projeto (validado contra whitelist no back).
     */
    relatedScreens: z
      .array(
        z.object({
          childResource: z.string().regex(/^[a-z][a-z0-9_]*$/),
          label: z.string().min(1),
        }),
      )
      .optional(),
    /**
     * Child screens (master-detail): define um resource filho com FK para este resource.
     * `fkField` no childResource referencia o id do record pai (resource atual).
     */
    children: z
      .array(childScreenSchema)
      .optional(),
    /**
     * Ações customizadas disponíveis na tela (botões, menu item etc.).
     * Cada action exige method + path; confirm é opcional.
     */
    actions: z.array(customActionSchema).optional(),
  })
  .strict()

export type CadastroScreenConfig = z.infer<typeof cadastroScreenConfigSchema>

/** Relacionamento de tela: childResource (tabela) + label de exibição. */
export const relatedScreenSchema = z.object({
  childResource: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
}).strict()

export type RelatedScreen = z.infer<typeof relatedScreenSchema>

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



/** Tela externa: conecta a um endpoint REST fora do sistema. */
export const externalScreenConfigSchema = z
  .object({
    kind: z.literal("external"),
    /** URL base do serviço externo (ex.: "https://api.exemplo.com"). */
    baseUrl: z.string().url(),
    /** Método HTTP da requisição. */
    method: httpMethodSchema,
    /** Template de caminho com placeholders :campo (ex.: "/task/:id"). */
    pathTemplate: z.string().min(1),
    /**
     * Ações customizadas adicionais à action padrão do external.
     * Cada action exige method + path; confirm é opcional.
     */
    actions: z.array(customActionSchema).optional(),
    /**
     * Caminho dentro da resposta para extrair o array de linhas.
     * Ex.: "projects" → extrai `{ projects: [...] }.projects`.
     * Quando omitido, usa a resposta diretamente (array ou envolta em array).
     */
    dataPath: z.string().min(1).optional(),
    /**
     * Query estática opcional adicionada à URL como query string codificada.
     * Ex.: `{ filtro: "ativas" }` → `?filtro=ativas`.
     * Usado por filtros como GET /api/contatos?q=... .
     */
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /**
     * Template de caminho para detalhe do registro (master-detail).
     * Interpola placeholders com as props `params` da tela.
     * Ex.: "/task/:id" → quando params={id: 42}, navega para "/task/42".
     * Quando omitido, a tela não suporta navegação para detalhe.
     */
    detailPathTemplate: z.string().min(1).optional(),
    /**
     * Caminho dentro da resposta de detalhe para extrair o objeto de dados.
     * Ex.: "task" → extrai `{ task: {...} }.task`.
     * Quando omitido, usa a resposta diretamente.
     */
    detailDataPath: z.string().min(1).optional(),
    /**
     * Flag opcional: quando true, o detalhe do registro exibe um painel de chat
     * (TaskChat) junto aos dados do registro.
     */
    chat: z.boolean().optional(),
  })
  .strict()

export type ExternalScreenConfig = z.infer<typeof externalScreenConfigSchema>

export const screenConfigSchema = z.discriminatedUnion("kind", [
  cadastroScreenConfigSchema,
  customScreenConfigSchema,
  externalScreenConfigSchema,
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
