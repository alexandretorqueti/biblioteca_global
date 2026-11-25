/**
 * Suporte para testes de regressão contra MySQL REAL (tarefa
 * motor-deploy-reconcile-hardening, subtarefa 4).
 *
 * Regras (aceites da subtarefa):
 * - env resolvida na mesma ordem do motor (start.ts/bootstrap.ts):
 *   MOTOR_MYSQL_* -> MYSQL_* -> defaults do compose (host.docker.internal:3308,
 *   usuário `biblioteca`). O gate de testes herda o env do container do motor.
 * - database scratch isolada, NUNCA a base de produção do motor (projeto_640).
 *   O usuário `biblioteca` não tem CREATE global: o único padrão criável é
 *   `motor_v3_scratch<1 caractere>` (GRANT ALL ON `motor_v3_scratch_`.*, onde
 *   `_` é curinga de 1 caractere no MySQL) — daí o sufixo aleatório curto e o
 *   retry em caso de colisão.
 * - falhar ALTO (throw) quando o MySQL não está disponível: sem skip silencioso.
 * - DDL fiel derivado de SHOW CREATE TABLE da base real do motor (projeto_640,
 *   2026-11-22), com duas reduções documentadas: (1) FOREIGN KEYs removidas
 *   (o scratch não provisiona `projetos_captados` e a ordem de criação não
 *   deve importar); (2) `subtarefas` reduzida às colunas usadas pelo COUNT(*)
 *   de findDependentTasks. As colunas homônimas `status` (deploy_batches,
 *   deploy_requests, motor_outbox, subtarefas) são preservadas de propósito:
 *   elas reproduzem a ambiguidade que o fix 58cdc18d corrigiu no batchSelect.
 */
import { createConnection, createPool, type Connection, type Pool } from 'mysql2/promise'

export interface MotorMySqlEnv {
  host: string
  port: number
  user: string
  password: string
}

/** Mesma precedência do pool do motor (start.ts): MOTOR_MYSQL_* -> MYSQL_* -> default compose. */
export function resolveMotorMySqlEnv(): MotorMySqlEnv {
  return {
    host: process.env.MOTOR_MYSQL_HOST || process.env.MYSQL_HOST || 'host.docker.internal',
    port: Number(process.env.MOTOR_MYSQL_PORT || process.env.MYSQL_PORT || 3308),
    user: process.env.MOTOR_MYSQL_USER || process.env.MYSQL_USER || 'biblioteca',
    password: process.env.MOTOR_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
  }
}

const SCRATCH_PREFIX = 'motor_v3_scratch'
const SCRATCH_SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffixChar(): string {
  return SCRATCH_SUFFIX_CHARS[Math.floor(Math.random() * SCRATCH_SUFFIX_CHARS.length)]!
}

/**
 * Cria uma database scratch `motor_v3_scratch<char>` e retorna a conexão admin
 * (sem database selecionada) usada para o DROP no fim. Falha alto se o MySQL
 * estiver indisponível ou se o usuário não puder criar databases.
 */
export async function createScratchDatabase(env: MotorMySqlEnv, maxAttempts = 12): Promise<{ database: string; admin: Connection }> {
  let admin: Connection
  try {
    admin = await createConnection({ host: env.host, port: env.port, user: env.user, password: env.password, connectTimeout: 10_000 })
  } catch (error) {
    throw new Error(
      `MySQL indisponível para o teste de regressão (host=${env.host} port=${env.port} user=${env.user}): ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      'Defina MOTOR_MYSQL_*/MYSQL_* com um MySQL alcançável — este teste não faz skip silencioso.',
      { cause: error },
    )
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const database = `${SCRATCH_PREFIX}${randomSuffixChar()}`
    try {
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      return { database, admin }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ER_DB_CREATE_EXISTS') { lastError = error; continue }
      await admin.end().catch(() => undefined)
      throw new Error(
        `Falha ao criar database scratch (${database}) — o usuário \`${env.user}\` precisa de privilégios no padrão \`motor_v3_scratch_\`.*: ` +
        (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
  }
  await admin.end().catch(() => undefined)
  throw new Error(`Não foi possível criar uma database scratch após ${maxAttempts} tentativas (último erro: ${String(lastError)})`)
}

export async function dropScratchDatabase(admin: Connection, database: string): Promise<void> {
  if (!database.startsWith(SCRATCH_PREFIX)) throw new Error(`Recusa a dropar database fora do padrão scratch: ${database}`)
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
  await admin.end().catch(() => undefined)
}

export function createScratchPool(env: MotorMySqlEnv, database: string): Pool {
  return createPool({ host: env.host, port: env.port, user: env.user, password: env.password, database, charset: 'utf8mb4', connectionLimit: 4 })
}

/**
 * DDL fiel das tabelas tocadas por batchSelect (runningBatches /
 * findPendingBatchByGateJob) e pelo ciclo de reconciliação + completeBatch.
 * FKs removidas (ver cabeçalho); colunas `status` homônimas preservadas.
 */
export const MOTOR_SCRATCH_DDL: readonly string[] = [
  `CREATE TABLE \`tarefas\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`projeto_id\` bigint unsigned NOT NULL,
    \`titulo\` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`descricao\` text COLLATE utf8mb4_unicode_ci,
    \`max_rework\` int NOT NULL DEFAULT '3',
    \`hard_timeout_ms\` bigint DEFAULT NULL,
    \`depends_on_task_id\` bigint unsigned DEFAULT NULL,
    \`auto_start\` tinyint(1) NOT NULL DEFAULT '1',
    \`boot_retry_count\` int NOT NULL DEFAULT '0',
    \`created_at\` timestamp NOT NULL DEFAULT (now()),
    \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    \`external_id\` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`chat_id\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`project_slug\` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`baseline_mode\` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'full',
    \`analysis_commit\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`execution_id\` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`fencing_token\` bigint DEFAULT NULL,
    \`resource_wait_key\` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`resource_wait_id\` bigint DEFAULT NULL,
    \`resource_wait_position\` int DEFAULT NULL,
    \`paused_at\` datetime(6) DEFAULT NULL,
    \`ultima_mensagem_erro\` text COLLATE utf8mb4_unicode_ci,
    \`tipo\` enum('desenvolvimento','automacao','verificacao') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'desenvolvimento',
    \`plan_coverage\` json DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uq_tarefas_external_id\` (\`external_id\`),
    UNIQUE KEY \`tarefas_external_id_unique\` (\`external_id\`),
    KEY \`tarefas_projeto_id_projetos_captados_id_fk\` (\`projeto_id\`),
    KEY \`tarefas_depends_on_task_id_tarefas_id_fk\` (\`depends_on_task_id\`),
    KEY \`idx_tarefas_resource_wait\` (\`resource_wait_key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`projeto_motor_config\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`projeto_id\` bigint unsigned NOT NULL,
    \`repo_path\` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`branch_trabalho\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`build_command\` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`unit_test_command\` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`unit_test_exclude\` json DEFAULT NULL,
    \`default_max_rework\` int NOT NULL DEFAULT '3',
    \`default_hard_timeout_ms\` bigint NOT NULL DEFAULT '3600000',
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    \`deploy_script\` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`deploy_host_root\` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`project_layout\` enum('monorepo','standalone') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'monorepo',
    \`repo_path_host\` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`git_remote\` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`deploy_kind\` enum('blue-green-api','script','container-rebuild','manual') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'blue-green-api',
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`projeto_motor_config_projeto_id_unique\` (\`projeto_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`deploy_requests\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`tarefa_id\` bigint unsigned NOT NULL,
    \`repo_path\` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`requested_commit\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`base_branch\` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`status\` enum('pending','running','succeeded','failed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
    \`batch_id\` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`last_error\` text COLLATE utf8mb4_unicode_ci,
    \`requested_at\` timestamp NOT NULL DEFAULT (now()),
    \`started_at\` timestamp NULL DEFAULT NULL,
    \`finished_at\` timestamp NULL DEFAULT NULL,
    \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    \`generation\` int NOT NULL DEFAULT '1',
    \`parent_generation\` int DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`deploy_requests_tarefa_generation_unique\` (\`tarefa_id\`,\`generation\`),
    KEY \`deploy_requests_repository_commit_status_idx\` (\`repo_path\`(255),\`base_branch\`,\`requested_commit\`,\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`deploy_batches\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`batch_id\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`repo_path\` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`base_branch\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`expected_commit\` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`workspace_path\` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`gate_job_id\` bigint unsigned DEFAULT NULL,
    \`status\` enum('pending','running','succeeded','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
    \`remote_pid\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`remote_status_path\` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`last_error\` text COLLATE utf8mb4_unicode_ci,
    \`started_at\` timestamp NULL DEFAULT NULL,
    \`finished_at\` timestamp NULL DEFAULT NULL,
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`deploy_batches_batch_unique\` (\`batch_id\`),
    UNIQUE KEY \`deploy_batches_gate_job_unique\` (\`gate_job_id\`),
    KEY \`deploy_batches_repository_status_idx\` (\`repo_path\`(255),\`status\`),
    KEY \`deploy_batches_status_started_idx\` (\`status\`,\`started_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_outbox\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`message_id\` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`type\` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`destination_queue\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'motor.commands',
    \`task_id\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`execution_id\` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`payload_json\` json NOT NULL,
    \`timestamp\` timestamp NOT NULL,
    \`correlation_id\` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`causation_id\` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`status\` enum('pending','published') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
    \`attempt\` int NOT NULL DEFAULT '0',
    \`defer_count\` int NOT NULL DEFAULT '0',
    \`last_error\` text COLLATE utf8mb4_unicode_ci,
    \`published_at\` timestamp NULL DEFAULT NULL,
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`motor_outbox_message_id_unique\` (\`message_id\`),
    UNIQUE KEY \`motor_outbox_logical_key_unique\` (\`type\`,\`task_id\`,\`correlation_id\`),
    KEY \`motor_outbox_pending_idx\` (\`status\`,\`id\`),
    KEY \`motor_outbox_task_idx\` (\`task_id\`,\`created_at\`),
    KEY \`idx_motor_outbox_destination_status\` (\`destination_queue\`,\`status\`,\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`bloqueios\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`tarefa_id\` bigint unsigned NOT NULL,
    \`block_reason\` text COLLATE utf8mb4_unicode_ci,
    \`block_command\` text COLLATE utf8mb4_unicode_ci,
    \`block_exit_code\` int DEFAULT NULL,
    \`block_excerpt\` text COLLATE utf8mb4_unicode_ci,
    \`blocked_at\` timestamp NULL DEFAULT NULL,
    \`created_at\` timestamp NOT NULL DEFAULT (now()),
    \`subtarefa_id\` bigint unsigned DEFAULT NULL,
    \`resolved_at\` timestamp NULL DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    KEY \`bloqueios_subtarefa_id_subtarefas_id_fk\` (\`subtarefa_id\`),
    KEY \`bloqueios_active_task_idx\` (\`tarefa_id\`,\`resolved_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`task_runtime_facts\` (
    \`tarefa_id\` bigint unsigned NOT NULL,
    \`analysis_started_at\` timestamp NULL DEFAULT NULL,
    \`analysis_execution_id\` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`provider\` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`clarification_pending_at\` timestamp NULL DEFAULT NULL,
    \`integration_confirmed_at\` timestamp NULL DEFAULT NULL,
    \`terminal_status\` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`terminal_at\` timestamp NULL DEFAULT NULL,
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    \`integration_commit_sha\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`base_commit_sha\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`merge_commit_sha\` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_phase\` enum('analysis','development') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_reason_code\` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_limit_scope\` enum('global','project','provider','model') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_limit_value\` int unsigned DEFAULT NULL,
    \`capacity_wait_provider\` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_since\` datetime DEFAULT NULL,
    \`capacity_wait_retry_at\` datetime DEFAULT NULL,
    \`capacity_wait_alert_at\` datetime DEFAULT NULL,
    \`capacity_wait_setup_state\` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`capacity_wait_setup_error\` text COLLATE utf8mb4_unicode_ci,
    \`capacity_wait_detail\` text COLLATE utf8mb4_unicode_ci,
    PRIMARY KEY (\`tarefa_id\`),
    KEY \`task_runtime_facts_analysis_idx\` (\`analysis_started_at\`),
    KEY \`task_runtime_facts_terminal_idx\` (\`terminal_status\`),
    KEY \`task_runtime_facts_analysis_execution_idx\` (\`analysis_execution_id\`),
    KEY \`task_runtime_facts_provider_analysis_idx\` (\`provider\`,\`analysis_started_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`tarefa_dependencias\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`tarefa_id\` bigint unsigned NOT NULL,
    \`depende_de_tarefa_id\` bigint unsigned NOT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`tarefa_dependencias_tarefa_depende_unica\` (\`tarefa_id\`,\`depende_de_tarefa_id\`),
    KEY \`tarefa_dependencias_tarefa_idx\` (\`tarefa_id\`),
    KEY \`tarefa_dependencias_depende_de_idx\` (\`depende_de_tarefa_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Mínima fiel: findDependentTasks usa apenas COUNT(*) WHERE s.tarefa_id=?.
  `CREATE TABLE \`subtarefas\` (
    \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
    \`tarefa_id\` bigint unsigned NOT NULL,
    \`seq\` int NOT NULL,
    \`titulo\` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`status\` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
    \`created_at\` timestamp NOT NULL DEFAULT (now()),
    \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`subtarefas_tarefa_id_tarefas_id_fk\` (\`tarefa_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_deploy_lock\` (
    \`id\` int NOT NULL DEFAULT '1',
    \`locked\` tinyint(1) NOT NULL DEFAULT '0',
    \`locked_at\` timestamp NULL DEFAULT NULL,
    \`locked_by\` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`reason\` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function applyScratchSchema(pool: Pool): Promise<void> {
  for (const ddl of MOTOR_SCRATCH_DDL) {
    await pool.query(ddl)
  }
}

/**
 * DDL fiel das tabelas de CATÁLOGO do Motor-v3 (tarefa motor-frente-b-monitor-
 * bridge, subtarefa 2). Derivado de SHOW CREATE TABLE da base real do motor
 * (projeto_640, 2026-11-25) com a MESMA redução do MOTOR_SCRATCH_DDL: FOREIGN
 * KEYs removidas (o scratch não provisiona a ordem/dependências; as colunas de
 * referência ficam como índice comum). As uniques de código (motor_events.code,
 * motor_actions.code) são preservadas — o fluxo de escrita real do catálogo
 * depende delas.
 *
 * Fidelidade deliberada: `motor_occurrences` NÃO tem UNIQUE sobre
 * (event_id, tarefa_id, subtarefa_id, generation) na tabela real — apenas
 * PRIMARY KEY(id) + KEY(event_id). O EventClassifier.incrementOccurrence usa
 * `INSERT ... ON DUPLICATE KEY UPDATE`; sem unique, essa cláusula nunca dispara
 * sobre a tupla (cada classificação insere uma linha nova, count permanece 1 e
 * a consulta de contagem lê rows[0]). O scratch reproduz EXATAMENTE esse
 * comportamento real — adicionar um unique aqui mascararia a divergência e
 * deixaria o teste infiel à base de produção. As asserts de classificação
 * (que é o aceite) não dependem do incremento de count.
 */
export const MOTOR_CATALOG_SCRATCH_DDL: readonly string[] = [
  `CREATE TABLE \`motor_events\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`code\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`name\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`category\` enum('erro','verificacao','conclusao','estado','humano','infra') COLLATE utf8mb4_unicode_ci NOT NULL,
    \`scope\` enum('global','projeto','tarefa','subtarefa') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'subtarefa',
    \`priority\` int NOT NULL DEFAULT '100',
    \`active\` tinyint NOT NULL DEFAULT '1',
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`motor_events_code_unique\` (\`code\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_patterns\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`event_id\` int NOT NULL,
    \`pattern\` text COLLATE utf8mb4_unicode_ci NOT NULL,
    \`match_type\` enum('regex','contains','exact') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'contains',
    \`match_target\` enum('code','message','stack','action_result') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'message',
    \`active\` tinyint NOT NULL DEFAULT '1',
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`motor_patterns_event_id_motor_events_id_fk\` (\`event_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_actions\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`code\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`name\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`description\` text COLLATE utf8mb4_unicode_ci,
    \`primitives_json\` json NOT NULL,
    \`on_partial_failure\` enum('continue','compensate','mark_dirty') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'continue',
    \`compensation_action_id\` int DEFAULT NULL,
    \`is_terminal\` tinyint NOT NULL DEFAULT '0',
    \`version\` int NOT NULL DEFAULT '1',
    \`active\` tinyint NOT NULL DEFAULT '1',
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`motor_actions_code_unique\` (\`code\`),
    KEY \`motor_actions_compensation_action_id_motor_actions_id_fk\` (\`compensation_action_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_reactions\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`event_id\` int NOT NULL,
    \`occurrence\` int NOT NULL,
    \`action_id\` int NOT NULL,
    \`params_json\` json DEFAULT NULL,
    \`condition_json\` json DEFAULT NULL,
    \`version\` int NOT NULL DEFAULT '1',
    \`active\` tinyint NOT NULL DEFAULT '1',
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`motor_reactions_action_id_motor_actions_id_fk\` (\`action_id\`),
    KEY \`idx_motor_reactions_event_condition\` (\`event_id\`,\`active\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_occurrences\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`event_id\` int NOT NULL,
    \`tarefa_id\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`subtarefa_id\` int DEFAULT NULL,
    \`generation\` int NOT NULL DEFAULT '1',
    \`count\` int NOT NULL DEFAULT '1',
    \`last_occurred_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`motor_occurrences_event_id_motor_events_id_fk\` (\`event_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE \`motor_catalog_proposals\` (
    \`id\` int NOT NULL AUTO_INCREMENT,
    \`source\` enum('monitor','human') COLLATE utf8mb4_unicode_ci NOT NULL,
    \`status\` enum('auto_activated','pending_review','approved','rejected') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_review',
    \`event_id\` int DEFAULT NULL,
    \`diagnosis\` text COLLATE utf8mb4_unicode_ci NOT NULL,
    \`proposal_json\` json NOT NULL,
    \`tarefa_id\` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    \`subtarefa_id\` int DEFAULT NULL,
    \`reviewed_by\` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    \`review_notes\` text COLLATE utf8mb4_unicode_ci,
    \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`motor_catalog_proposals_event_id_motor_events_id_fk\` (\`event_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function applyCatalogScratchSchema(pool: Pool): Promise<void> {
  for (const ddl of MOTOR_CATALOG_SCRATCH_DDL) {
    await pool.query(ddl)
  }
}
