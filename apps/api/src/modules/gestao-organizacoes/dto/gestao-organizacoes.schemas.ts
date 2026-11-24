/**
 * Schemas Zod dos endpoints de administração de organizações/colaboradores
 * (gestao-de-tarefas-global — macro #2, subtarefa 3).
 *
 * Estilo do projeto (mesmo padrão de ocorrencias/dto): body `unknown` no
 * controller + `safeParse` com mensagens claras em `details`.
 *
 * Chaves em camelCase (endpoints custom do projeto; o CRUD genérico continua
 * snake_case). `organizacaoId` NÃO entra nos schemas: a organização é sempre
 * a da sessão — presença de valor divergente é rejeitada antes do parse
 * (`rejeitarOrganizacaoDivergente` no service).
 */
import { z } from "zod"

/** CPF com máscara canônica (mesmo formato da coluna char(14) do schema). */
export const cpfSchema = z
  .string()
  .regex(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/, "CPF deve usar a máscara 000.000.000-00")

export const telefoneSchema = z
  .string()
  .regex(/^\+?[\d\s()-]{8,20}$/, "Telefone inválido — use dígitos (opcionalmente +, espaços, parênteses e hífen)")

const nomeSchema = z.string().trim().min(1, "Nome é obrigatório").max(160)
const emailSchema = z.string().trim().email("E-mail inválido").max(160)
const usuarioIdSchema = z.number().int().positive("usuarioId deve ser um id positivo")

/** Vínculo do primeiro admin: usuário global EXISTENTE + dados do colaborador. */
export const adminOrganizacaoSchema = z.object({
  /** core.usuarios.id do usuário global que será o admin da organização. */
  usuarioId: usuarioIdSchema,
  nome: nomeSchema,
  email: emailSchema,
  telefone: telefoneSchema.optional(),
  cpf: cpfSchema.optional(),
})

/**
 * POST (master) — cria organização e designa o primeiro admin:
 * cria colaborador ativo vinculado por usuarioId e garante perfil admin
 * no pivot projetos_usuarios do projeto gestao-de-tarefas-global.
 */
export const criarOrganizacaoSchema = z.object({
  nome: nomeSchema,
  descricao: z.string().trim().max(2000).optional(),
  admin: adminOrganizacaoSchema,
})

/** POST (admin da organização) — cadastro de colaborador na organização da sessão. */
export const criarColaboradorSchema = z.object({
  nome: nomeSchema,
  email: emailSchema,
  telefone: telefoneSchema.optional(),
  cpf: cpfSchema.optional(),
  ativo: z.boolean().default(true),
  /** Vínculo opcional com usuário global (validado: existe, ativo e sem duplicidade). */
  usuarioId: usuarioIdSchema.optional(),
})

/** PUT (admin da organização) — edição parcial de colaborador da própria organização. */
export const atualizarColaboradorSchema = z
  .object({
    nome: nomeSchema.optional(),
    email: emailSchema.optional(),
    telefone: telefoneSchema.optional(),
    cpf: cpfSchema.optional(),
    ativo: z.boolean().optional(),
    usuarioId: usuarioIdSchema.optional(),
  })
  .refine((dados) => Object.keys(dados).length > 0, {
    message: "Informe ao menos um campo para atualizar",
  })

/** PUT vínculo colaborador↔usuário: numero para vincular, null para desvincular. */
export const vincularUsuarioSchema = z
  .object({
    usuarioId: usuarioIdSchema.nullable(),
  })
  .strict()

export type CriarOrganizacaoInput = z.infer<typeof criarOrganizacaoSchema>
export type CriarColaboradorInput = z.infer<typeof criarColaboradorSchema>
export type AtualizarColaboradorInput = z.infer<typeof atualizarColaboradorSchema>
export type VincularUsuarioInput = z.infer<typeof vincularUsuarioSchema>
