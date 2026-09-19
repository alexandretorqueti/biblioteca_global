import type { Pool } from 'mysql2/promise'

export interface MessageProcessingRecord {
    message_id: string;
    task_id: string | null;
    message_type: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    attempt: number;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
    timeout_at: Date | null;
    error_message: string | null;
}

export interface ClaimResult {
    claimed: boolean;
    alreadyCompleted: boolean;
    alreadyProcessing: boolean;
}

export class MessageProcessingState {
    constructor(private readonly pool: Pool) {}

    /**
     * Registra uma nova mensagem na fila para processamento.
     * Deve ser chamada junto com a persistência da outbox na mesma transação.
     */
    async registerMessage(
        messageId: string,
        messageType: string,
        taskId: string | null = null,
    ): Promise<void> {
        await this.pool.execute(
            'INSERT INTO motor_message_processing_state (message_id, task_id, message_type, status, attempt, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
            [messageId, taskId, messageType, 'pending']
        );
    }

    /**
     * Tenta claim uma mensagem para processamento.
     * Usa UPDATE atômico para garantir idempotência em concorrência.
     *
     * Retorna:
     * - { claimed: true }: claim bem-sucedido, o chamador deve processar
     * - { alreadyCompleted: true }: mensagem já foi processada, ack silencioso
     * - { alreadyProcessing: true }: outra instância já está processando, ack silencioso
     */
    async tryClaim(messageId: string): Promise<ClaimResult> {
        // Primeiro verifica se já existe e já foi completado
        const [rows]: any[][] = await this.pool.query(
            'SELECT status FROM motor_message_processing_state WHERE message_id = ?',
            [messageId]
        );

        if (rows.length > 0) {
            const existing = rows[0] as any;
            if (existing.status === 'completed') {
                return { claimed: false, alreadyCompleted: true, alreadyProcessing: false };
            }

            if (existing.status === 'processing') {
                return { claimed: false, alreadyCompleted: false, alreadyProcessing: true };
            }
        }

        // Tenta claim o pendente para processing
        const [[result]]: any[] = await this.pool.query(
            `UPDATE motor_message_processing_state 
             SET status='processing', started_at=NOW() 
             WHERE message_id=? AND status='pending'`,
            [messageId]
        );

        if ((result as any).affectedRows === 0) {
            return { claimed: false, alreadyCompleted: false, alreadyProcessing: true };
        }

        return { claimed: true, alreadyCompleted: false, alreadyProcessing: false };
    }

    /**
     * Marca a mensagem como completada com sucesso.
     */
    async markCompleted(messageId: string): Promise<void> {
        await this.pool.execute(
            'UPDATE motor_message_processing_state SET status=completed, completed_at=NOW() WHERE message_id=?',
            [messageId]
        );
    }

    /**
     * Marca a mensagem como falha.
     */
    async markFailed(messageId: string, errorMessage: string): Promise<void> {
        await this.pool.execute(
            'UPDATE motor_message_processing_state SET status=failed, completed_at=NOW(), error_message=? WHERE message_id=?',
            [errorMessage, messageId]
        );
    }

    /**
     * Incrementa a contagem de tentativas e reseta para pending (retry).
     */
    async incrementAttempt(messageId: string): Promise<void> {
        await this.pool.execute(
            `UPDATE motor_message_processing_state 
             SET status='pending', started_at=NULL, completed_at=NULL, timeout_at=NULL, error_message=NULL 
             WHERE message_id = ?`,
            [messageId]
        );
        
        await this.pool.execute(
            'UPDATE motor_message_processing_state SET attempt = attempt + 1 WHERE message_id = ?',
            [messageId]
        );
    }

    /**
     * Recupera o registro de uma mensagem específica.
     */
    async getMessage(messageId: string): Promise<MessageProcessingRecord | null> {
        const [rows]: any[][] = await this.pool.query(
            'SELECT * FROM motor_message_processing_state WHERE message_id=?',
            [messageId]
        );
        return (rows as any[]).length > 0 ? (rows[0] as MessageProcessingRecord) : null;
    }

    /**
     * Recupera mensagens pendentes que expiraram (timeout) para resgate.
     */
    async getTimedOutMessages(minutes: number = 5): Promise<MessageProcessingRecord[]> {
        const timeoutAt = new Date(Date.now() - minutes * 60 * 1000);
        const [rows]: any[][] = await this.pool.query(
            `SELECT * FROM motor_message_processing_state 
             WHERE status='processing' AND started_at < ?`,
            [timeoutAt]
        );
        return rows as MessageProcessingRecord[];
    }
}
