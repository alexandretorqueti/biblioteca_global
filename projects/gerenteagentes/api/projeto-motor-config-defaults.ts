/**
 * projeto-motor-config-defaults.ts — Registro automático do Motor em
 * `projeto_motor_config` (fim do bloqueio "repoPath vazio").
 *
 * Contexto (incidente 27/11/2026 — projeto 16 vitrine-ia, tarefa 1138,
 * bloqueio 3568): projetos novos captados pela Isa criavam a linha em
 * `projetos_captados`, mas NENHUM código criava a linha correspondente em
 * `projeto_motor_config` (as linhas existentes foram criadas manualmente).
 * Qualquer tarefa vinculada a projeto sem config morria no preflight do
 * Analista ("repo_inacessivel: repoPath/workspace vazio"), queimava as 3
 * tentativas e virava bloqueio analysis_failed genérico.
 *
 * `ensureMotorConfigPadrao` elimina o passo manual: insere de forma
 * idempotente os defaults monorepo (espelho da linha do projeto 1 —
 * biblioteca-global, verificados no banco em 27/11) quando não existe linha
 * para o projeto. NUNCA sobrescreve linha existente: o ON DUPLICATE KEY
 * UPDATE é no-op (autoatribuição da coluna UNIQUE `projeto_id`, padrão
 * documentado pelo próprio drizzle para "nothing on conflict"), de forma que
 * ajustes posteriores feitos por missão/humano permanecem intactos.
 *
 * Projetos standalone continuam dependendo de cadastro manual/missão
 * dedicada — este helper só registra defaults monorepo para projetos sem
 * linha alguma.
 */
import { sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { projetoMotorConfig } from "../schema"

/**
 * Defaults monorepo espelhando a linha do projeto 1 (biblioteca-global),
 * verificados no banco em 27/11/2026.
 */
export const MOTOR_CONFIG_DEFAULTS_MONOREPO = {
  projectLayout: "monorepo" as const,
  repoPath: "/data/workspace/projects/codigofonte/biblioteca-global",
  branchTrabalho: "base-desenvolvimento",
  buildCommand: "npm ci --prefer-offline --no-audit --no-fund && npm run build",
  unitTestCommand: "npm run test",
  unitTestExclude: ["wt-deploy/"],
  deployKind: "blue-green-api" as const,
  defaultMaxRework: 3,
  defaultHardTimeoutMs: 3600000,
}

export interface EnsureMotorConfigResultado {
  /** true quando a linha foi criada por esta chamada; false quando já existia. */
  inserido: boolean
}

/**
 * Garante (idempotente) a linha de defaults monorepo em `projeto_motor_config`
 * para o projeto. Nunca altera uma linha existente — em conflito da UNIQUE
 * `projeto_id` o statement é no-op.
 */
export async function ensureMotorConfigPadrao(
  db: MySql2Database,
  projetoId: number,
): Promise<EnsureMotorConfigResultado> {
  if (!Number.isInteger(projetoId) || projetoId <= 0) {
    throw new Error(`ensureMotorConfigPadrao: projeto_id inválido (${String(projetoId)})`)
  }

  const resultado = await db
    .insert(projetoMotorConfig)
    .values({ projetoId, ...MOTOR_CONFIG_DEFAULTS_MONOREPO })
    .onDuplicateKeyUpdate({
      // No-op canônico: atribuir a coluna UNIQUE a ela mesma não muda nada
      // (nem `updated_at`, que só avança quando algum valor realmente muda).
      set: { projetoId: sql`${projetoMotorConfig.projetoId}` },
    })

  // mysql2 devolve [ResultSetHeader, fields] em INSERT; affectedRows = 0
  // quando o ON DUPLICATE KEY UPDATE no-op não alterou nenhuma linha.
  const header = Array.isArray(resultado)
    ? (resultado[0] as { affectedRows?: number } | undefined)
    : (resultado as { affectedRows?: number } | undefined)
  const affected = header?.affectedRows
  return { inserido: typeof affected === "number" ? affected > 0 : true }
}
