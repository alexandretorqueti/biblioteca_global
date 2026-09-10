/**
 * Database - Sistema de logging para chamadas/retornos das IAs
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface CallLog {
  id?: number;
  timestamp: string;
  provider: string;
  model: string;
  request_type: 'chat_completion' | 'system_prompt' | 'user_message' | 'tool_call' | 'response';
  request_data: string; // JSON
  response_data?: string; // JSON
  duration_ms?: number;
  success: boolean;
  error_message?: string;
  metadata?: string; // JSON com info adicional
}

export interface ConversationEvent {
  sessionId: string;
  agentId?: string;
  direction: 'outbound' | 'inbound' | 'tool_call' | 'tool_result';
  eventType: 'context' | 'message' | 'tool_call' | 'tool_result' | 'error';
  provider: string;
  model: string;
  content: unknown;
  success?: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export class WebAIDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = '/tmp/webai/webai-logs.db') {
    // Criar diretório se não existir
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    
    // Configurar WAL mode para melhor performance
    this.db.pragma('journal_mode = WAL');
    
    // Criar tabelas
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_type TEXT NOT NULL,
        request_data TEXT NOT NULL,
        response_data TEXT,
        duration_ms INTEGER,
        success INTEGER NOT NULL,
        error_message TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp ON call_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_call_logs_provider ON call_logs(provider);
      CREATE INDEX IF NOT EXISTS idx_call_logs_model ON call_logs(model);
      CREATE INDEX IF NOT EXISTS idx_call_logs_request_type ON call_logs(request_type);
      CREATE INDEX IF NOT EXISTS idx_call_logs_success ON call_logs(success);

      CREATE TABLE IF NOT EXISTS conversation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT NOT NULL,
        agent_id TEXT,
        direction TEXT NOT NULL,
        event_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        content TEXT NOT NULL,
        success INTEGER,
        error_message TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_events_session ON conversation_events(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_agent ON conversation_events(agent_id, timestamp);
    `);

    console.log('✅ Database inicializado:', this.dbPath);
  }

  logConversationEvent(event: ConversationEvent): number {
    const result = this.db.prepare(`
      INSERT INTO conversation_events
        (session_id, agent_id, direction, event_type, provider, model, content, success, error_message, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.agentId ?? null,
      event.direction,
      event.eventType,
      event.provider,
      event.model,
      JSON.stringify(event.content),
      event.success === undefined ? null : event.success ? 1 : 0,
      event.errorMessage ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );
    return Number(result.lastInsertRowid);
  }

  getConversationEvents(sessionId: string, limit = 500): unknown[] {
    return this.db.prepare(
      'SELECT * FROM conversation_events WHERE session_id = ? ORDER BY id ASC LIMIT ?',
    ).all(sessionId, limit);
  }

  /**
   * Loga uma chamada completa (request + response)
   */
  logCall(log: CallLog): number {
    const stmt = this.db.prepare(`
      INSERT INTO call_logs (
        timestamp, provider, model, request_type, 
        request_data, response_data, duration_ms, 
        success, error_message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      log.timestamp || new Date().toISOString(),
      log.provider,
      log.model,
      log.request_type,
      log.request_data,
      log.response_data || null,
      log.duration_ms || null,
      log.success ? 1 : 0,
      log.error_message || null,
      log.metadata || null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Loga apenas o request (antes de executar)
   */
  logRequest(provider: string, model: string, requestType: CallLog['request_type'], data: any): number {
    return this.logCall({
      timestamp: new Date().toISOString(),
      provider,
      model,
      request_type: requestType,
      request_data: JSON.stringify(data),
      success: true,
    });
  }

  /**
   * Atualiza um log com a resposta
   */
  updateLogWithResponse(id: number, response: any, durationMs: number, success: boolean, error?: string): void {
    const stmt = this.db.prepare(`
      UPDATE call_logs 
      SET response_data = ?, duration_ms = ?, success = ?, error_message = ?
      WHERE id = ?
    `);

    stmt.run(
      JSON.stringify(response),
      durationMs,
      success ? 1 : 0,
      error || null,
      id
    );
  }

  /**
   * Busca logs por provider/model/tipo
   */
  getLogs(filters: {
    provider?: string;
    model?: string;
    requestType?: string;
    limit?: number;
    offset?: number;
  }): CallLog[] {
    let query = 'SELECT * FROM call_logs WHERE 1=1';
    const params: any[] = [];

    if (filters.provider) {
      query += ' AND provider = ?';
      params.push(filters.provider);
    }
    if (filters.model) {
      query += ' AND model = ?';
      params.push(filters.model);
    }
    if (filters.requestType) {
      query += ' AND request_type = ?';
      params.push(filters.requestType);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as CallLog[];
  }

  /**
   * Estatísticas de uso
   */
  getStats(): any {
    const totalCalls = this.db.prepare('SELECT COUNT(*) as count FROM call_logs').get();
    const byProvider = this.db.prepare(`
      SELECT provider, COUNT(*) as count, 
             AVG(duration_ms) as avg_duration,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count
      FROM call_logs 
      GROUP BY provider
    `).all();

    const byModel = this.db.prepare(`
      SELECT model, COUNT(*) as count,
             AVG(duration_ms) as avg_duration
      FROM call_logs 
      GROUP BY model
    `).all();

    return {
      total_calls: (totalCalls as any).count,
      by_provider: byProvider,
      by_model: byModel,
    };
  }

  /**
   * Limpa logs antigos (mantém apenas os últimos N dias)
   */
  cleanupOldLogs(daysToKeep: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const stmt = this.db.prepare('DELETE FROM call_logs WHERE timestamp < ?');
    const result = stmt.run(cutoffDate.toISOString());

    return result.changes;
  }

  /**
   * Fecha conexão com banco
   */
  close(): void {
    this.db.close();
  }
}

// Singleton
let dbInstance: WebAIDatabase | null = null;

export function getDatabase(): WebAIDatabase {
  if (!dbInstance) {
    dbInstance = new WebAIDatabase();
  }
  return dbInstance;
}
