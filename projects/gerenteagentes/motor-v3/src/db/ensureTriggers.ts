import type { Pool, RowDataPacket } from 'mysql2/promise'

/**
 * Rede de segurança da conclusão de tarefas (camada A do desenho A+B+C).
 *
 * Incidente (2026-09-25, tarefa 820): uma resolução externa marcou a última
 * subtarefa como 'verified' via SQL direto, contornando a transação do motor
 * que grava task_runtime_facts (terminal_status/integration_confirmed_at) e
 * emite DEPLOY_REQUESTED. A tarefa ficou eternamente em 'ready' (fila de
 * execução), sem fatos de conclusão e sem deploy.
 *
 * O trigger fecha o invariante "todas as subtarefas finais => tarefa
 * concluída" para QUALQUER writer (inclusive SQL manual): ao detectar a
 * última subtarefa virando verified/superseded sem terminal_status gravado,
 * conclui a tarefa e enfileira DEPLOY_REQUESTED com message_id determinístico
 * (deduplicado pelo UNIQUE de motor_outbox.message_id).
 *
 * Supressão: os caminhos canônicos do motor (completeVerification,
 * completeNoCodeExecution e ExternalResolutionHandler) definem
 * `@motor_completing := 1` na mesma conexão antes de atualizar subtarefas; o
 * trigger não atua quando a variável está definida, evitando duplicar as
 * mensagens que o próprio motor já emite.
 *
 * Por que não vai como migration drizzle: CREATE/DROP TRIGGER não é suportado
 * pelo protocolo de prepared statements (ER_UNSUPPORTED_PS), que é o caminho
 * do drizzle-kit migrate. Por isso a instalação roda no boot do motor via
 * pool.query() (protocolo de texto), com GET_LOCK para serializar blue/green
 * e DROP+CREATE idempotente (autocura se o trigger for removido).
 */

export const SUBTASK_COMPLETION_TRIGGER = 'trg_subtarefas_completion_net'

const TRIGGER_LOCK_KEY = 'gerente…gers'

const DROP_TRIGGER_SQL = `DROP TRIGGER IF EXISTS ${SUBTASK_COMPLETION_TRIGGER}`

const CREATE_TRIGGER_SQL = `
CREATE TRIGGER ${SUBTASK_COMPLETION_TRIGGER}
AFTER UPDATE ON subtarefas
FOR EACH ROW
BEGIN
  DECLARE v_total INT DEFAULT 0;
  DECLARE v_pendentes INT DEFAULT 0;
  DECLARE v_terminal VARCHAR(64) DEFAULT NULL;

  IF @motor_completing IS NULL
     AND NEW.status IN ('verified', 'superseded')
     AND NEW.status <> OLD.status THEN
    SELECT COUNT(*) INTO v_total
      FROM subtarefas
     WHERE tarefa_id = NEW.tarefa_id;
    SELECT COUNT(*) INTO v_pendentes
      FROM subtarefas
     WHERE tarefa_id = NEW.tarefa_id
       AND status NOT IN ('verified', 'superseded');

    IF v_total > 0 AND v_pendentes = 0 THEN
      SELECT terminal_status INTO v_terminal
        FROM task_runtime_facts
       WHERE tarefa_id = NEW.tarefa_id
       LIMIT 1;

      IF v_terminal IS NULL THEN
        INSERT INTO task_runtime_facts
          (tarefa_id, terminal_status, terminal_at, integration_confirmed_at, created_at, updated_at)
        VALUES
          (NEW.tarefa_id, 'completed', NOW(), NOW(), NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          terminal_status = 'completed',
          terminal_at = COALESCE(terminal_at, NOW()),
          integration_confirmed_at = COALESCE(integration_confirmed_at, NOW()),
          updated_at = NOW();

        INSERT IGNORE INTO motor_outbox
          (message_id, type, destination_queue, task_id, execution_id,
           payload_json, timestamp, status, attempt)
        SELECT CONCAT('deploy-completed-trigger-', t.id),
               'DEPLOY_REQUESTED',
               'motor.commands',
               COALESCE(t.external_id, CAST(t.id AS CHAR)),
               CONCAT('exec-trigger-completion-', t.id),
               JSON_OBJECT('reason', 'subtask_completion_safety_net', 'subtaskId', NEW.id),
               NOW(),
               'pending',
               0
          FROM tarefas t
         WHERE t.id = NEW.tarefa_id
           AND t.tipo = 'desenvolvimento'
           AND t.paused_at IS NULL;
      END IF;
    END IF;
  END IF;
END
`

/**
 * Instala (ou reinstala) o trigger de conclusão. Idempotente; chamado no boot
 * do motor-v3. Falha aqui NÃO derruba o boot: as camadas B (fallback no
 * consumer) e C (endpoint de resolução externa) continuam protegendo o
 * invariante — mas o erro é logado em destaque para intervenção.
 */
export async function ensureCompletionTrigger(pool: Pool): Promise<boolean> {
  const connection = await pool.getConnection()
  let locked = false
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [TRIGGER_LOCK_KEY],
    )
    locked = Number(lockRows[0]?.acquired ?? 0) === 1
    if (!locked) {
      // Outro container (blue/green) está instalando agora; o trigger é o
      // mesmo. Boot seguinte reinstala se necessário.
      console.warn('[Motor v3] Trigger de conclusão: lock ocupado; instalação delegada ao outro slot')
      return false
    }
    await connection.query(DROP_TRIGGER_SQL)
    await connection.query(CREATE_TRIGGER_SQL)
    console.log(`[Motor v3] Trigger de conclusão (camada A) instalado: ${SUBTASK_COMPLETION_TRIGGER}`)
    return true
  } finally {
    if (locked) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [TRIGGER_LOCK_KEY]) } catch { /* melhor esforço */ }
    }
    connection.release()
  }
}
