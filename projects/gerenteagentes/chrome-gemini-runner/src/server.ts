/**
 * WebAI Provider Server — API OpenAI-compatible
 * 
 * Expõe POST /v1/chat/completions para o OpenClaw consumir
 * Roteia para o WebAIRunner que executa via Chrome + IA web
 */

import express from 'express';
import cors from 'cors';
import { ConfigManager } from './config.js';
import { WebAIRunner } from './WebAIRunner.js';
import { FastGeminiProvider } from './FastGeminiProvider.js';
import { getDatabase } from './database.js';
import type { OpenAIChatRequest, OpenAIChatResponse } from './types.js';
import type { AgentContext, ToolRelayResponse } from './types.js';
import { buildSessionPrompt, buildToolResult, parseToolCall } from './SessionProtocol.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3100;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Config manager
const configManager = new ConfigManager();

// Database
const db = getDatabase();

interface WebAISession {
  id: string;
  agentId?: string;
  context?: AgentContext;
  initialized: boolean;
  toolRelayUrl?: string;
  createdAt: string;
}

const sessions = new Map<string, WebAISession>();

// Runner (reutiliza instância)
const runner = new WebAIRunner({
  headless: process.env.HEADLESS === 'true',
  debugPort: process.env.DEBUG_PORT ? parseInt(process.env.DEBUG_PORT) : 9222,
  taskTimeoutMs: process.env.TASK_TIMEOUT_MS ? parseInt(process.env.TASK_TIMEOUT_MS) : 30 * 60 * 1000,
  commandTimeoutMs: process.env.COMMAND_TIMEOUT_MS ? parseInt(process.env.COMMAND_TIMEOUT_MS) : 60 * 1000,
  pollIntervalMs: process.env.POLL_INTERVAL_MS ? parseInt(process.env.POLL_INTERVAL_MS) : 10 * 1000,
});

/**
 * POST /v1/chat/completions — API OpenAI-compatible
 */
app.post('/v1/chat/completions', async (req: express.Request, res: express.Response) => {
  const request: OpenAIChatRequest = req.body;
  const startTime = Date.now();
  const sessionId = request.session_id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let session = sessions.get(sessionId);

  if (!session) {
    session = {
      id: sessionId,
      agentId: request.agent_id || request.agent_context?.agent_id,
      context: request.agent_context,
      initialized: false,
      toolRelayUrl: request.tool_relay_url || process.env.TOOL_RELAY_URL,
      createdAt: new Date().toISOString(),
    };
    sessions.set(sessionId, session);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📥 Nova requisição: model=${request.model}`);
  console.log(`   Messages: ${request.messages.length}`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Log do request
  const logId = db.logRequest(request.model, request.model, 'chat_completion', {
    session_id: sessionId,
    agent_id: session.agentId,
    messages: request.messages,
    agent_context: request.agent_context,
    tool_relay_url: session.toolRelayUrl,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
  });
  
  // Busca o provider
  const provider = configManager.getProvider(request.model);
  if (!provider) {
    console.error(`❌ Provider não encontrado: ${request.model}`);
    db.updateLogWithResponse(logId, null, Date.now() - startTime, false, 'Provider não encontrado');
    return res.status(404).json({
      error: {
        message: `Provider '${request.model}' não encontrado`,
        type: 'invalid_request_error',
      },
    });
  }
  
  // Gera código de término único para esta requisição
  const terminationCode = `TAREFA_CONCLUIDA_${Date.now()}`;
  
  // Extrai system prompt e mensagens do Motor
  const systemMessage = request.messages.find(m => m.role === 'system');
  const userMessages = request.messages.filter(m => m.role === 'user');
  
  // Monta system prompt com código de término único
  const systemPrompt = systemMessage?.content 
    ? `${systemMessage.content}\n\nQuando terminar, envie: echo "${terminationCode}"`
    : buildDefaultSystemPrompt(terminationCode);
  const userMessage = userMessages.map(m => m.content).join('\n\n') || request.messages.map(m => m.content).join('\n\n');
  // Em uma sessão contextual, o prompt padrão de executor de terminal não deve
  // contaminar a primeira mensagem do agente. O Motor já enviou sua mensagem;
  // o bootstrap acrescenta somente um system prompt explicitamente informado.
  const motorFirstMessage = [systemMessage?.content, userMessage].filter(Boolean).join('\n\n');

  if (!session.initialized && session.context) {
    db.logConversationEvent({
      sessionId, agentId: session.agentId, direction: 'outbound', eventType: 'context',
      provider: request.model, model: request.model, content: session.context,
      metadata: { phase: 'initial_context' },
    });
  }
  
  try {
    // Verifica se deve usar FastGeminiProvider (Fase 1.5) para Gemini
    const isGemini = provider.id.toLowerCase().includes('gemini');
    
    let result: { success: boolean; output?: string; error?: string };
    
    if (isGemini) {
      // Usar FastGeminiProvider (Fase 1.5) — 9s vs 15-30s
      console.log('⚡ Usando FastGeminiProvider (Fase 1.5)');
      
      try {
        const fastProvider = await FastGeminiProvider.create();
        // Na primeira mensagem, contexto + tools + mensagem do Motor formam o bootstrap.
        // Nas seguintes, apenas a nova mensagem é enviada: o histórico permanece na sessão do Gemini.
        const fullMessage = !session.initialized && session.context
          ? buildSessionPrompt({ context: session.context, firstMessage: motorFirstMessage })
          : session.initialized
            ? userMessage
            : `${systemPrompt}\n\n${userMessage}`;
        db.logConversationEvent({
          sessionId, agentId: session.agentId, direction: 'outbound', eventType: 'message',
          provider: request.model, model: request.model, content: fullMessage,
          metadata: { phase: session.initialized ? 'message' : 'bootstrap' },
        });
        const fastResult = await fastProvider.sendMessage(fullMessage);
        fastProvider.disconnect();
        
        result = {
          success: fastResult.success,
          output: fastResult.text,
          error: fastResult.error,
        };
        
        session.initialized = true;
        db.logConversationEvent({
          sessionId, agentId: session.agentId, direction: 'inbound', eventType: 'message',
          provider: request.model, model: request.model, content: fastResult.text,
          success: fastResult.success, errorMessage: fastResult.error,
          metadata: { duration_ms: fastResult.duration },
        });
        console.log(`✅ FastGeminiProvider: ${(fastResult.duration / 1000).toFixed(1)}s`);

        // MVP de relay: o Gemini pede a tool por marcador e o Motor/OpenClaw executa.
        result = await processToolCalls({
          result, sessionId, session, model: request.model,
        });
      } catch (fastError) {
        console.error('❌ FastGeminiProvider falhou, fallback para WebAIRunner:', fastError);
        // Fallback para WebAIRunner (Fase 1)
        result = await runner.execute(provider, systemPrompt, userMessage, terminationCode);
      }
    } else {
      // Usar WebAIRunner (Fase 1) para GPT/Claude
      result = await runner.execute(provider, systemPrompt, userMessage, terminationCode);
    }
    
    // Monta resposta no formato OpenAI
    const response: OpenAIChatResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.output || result.error || 'Tarefa concluída sem saída',
          },
          finish_reason: result.success ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: 0, // Não temos contagem real
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
    
    // Log da resposta
    db.updateLogWithResponse(logId, response, Date.now() - startTime, result.success, result.error);
    
    console.log(`✅ Resposta enviada (success=${result.success})`);
    res.json(response);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Erro na execução: ${errorMessage}`);
    
    // Log do erro
    db.updateLogWithResponse(logId, null, Date.now() - startTime, false, errorMessage);
    
    res.status(500).json({
      error: {
        message: errorMessage,
        type: 'server_error',
      },
    });
  }
});

/**
 * GET /v1/models — lista modelos disponíveis
 */
app.get('/v1/models', (req, res) => {
  const providers = configManager.getAllProviders();
  
  const models = providers.map(p => ({
    id: p.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'webai',
    permission: [],
    root: p.id,
    parent: null,
  }));
  
  res.json({
    object: 'list',
    data: models,
  });
});

/**
 * GET /api/providers — lista providers cadastrados (admin)
 */
app.get('/api/providers', (req: express.Request, res: express.Response) => {
  const providers = configManager.getAllProviders();
  res.json({ providers });
});

/**
 * POST /api/providers — cadastra novo provider (admin)
 */
app.post('/api/providers', (req: express.Request, res: express.Response) => {
  const provider = req.body;
  
  if (!provider.id || !provider.name || !provider.url) {
    return res.status(400).json({
      error: 'Campos obrigatórios: id, name, url, selectors',
    });
  }
  
  configManager.setProvider(provider);
  res.json({ success: true, provider });
});

/**
 * DELETE /api/providers/:id — remove provider (admin)
 */
app.delete('/api/providers/:id', (req: express.Request, res: express.Response) => {
  const removed = configManager.removeProvider(String(req.params.id));
  
  if (removed) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Provider não encontrado' });
  }
});

/**
 * GET /health — health check
 */
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    providers: configManager.getAllProviders().length,
    uptime: process.uptime(),
  });
});

/**
 * GET /api/logs — lista logs de chamadas (admin)
 */
app.get('/api/logs', (req: express.Request, res: express.Response) => {
  const { provider, model, requestType, limit, offset } = req.query;
  
  const logs = db.getLogs({
    provider: provider as string,
    model: model as string,
    requestType: requestType as string,
    limit: limit ? parseInt(limit as string) : 100,
    offset: offset ? parseInt(offset as string) : 0,
  });
  
  res.json({ logs, count: logs.length });
});

/**
 * GET /api/logs/:id — busca log específico (admin)
 */
app.get('/api/logs/:id', (req: express.Request, res: express.Response) => {
  const id = parseInt(String(req.params.id), 10);
  const logs = db.getLogs({ limit: 1 });
  const log = logs.find(l => l.id === id);
  
  if (!log) {
    return res.status(404).json({ error: 'Log não encontrado' });
  }
  
  res.json(log);
});

/**
 * GET /api/stats — estatísticas de uso (admin)
 */
app.get('/api/stats', (req: express.Request, res: express.Response) => {
  const stats = db.getStats();
  res.json(stats);
});

/** GET /api/sessions/:id/events — tráfego completo da sessão */
app.get('/api/sessions/:id/events', (req: express.Request, res: express.Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
  const sessionId = String(req.params.id);
  res.json({ session_id: sessionId, events: db.getConversationEvents(sessionId, limit) });
});

/** Executa o ciclo mínimo Gemini -> relay do Motor -> Gemini. */
async function processToolCalls(input: {
  result: { success: boolean; output?: string; error?: string };
  sessionId: string;
  session: WebAISession;
  model: string;
}): Promise<{ success: boolean; output?: string; error?: string }> {
  let current = input.result;
  const maxRounds = 8;

  for (let round = 0; round < maxRounds; round++) {
    const call = parseToolCall(current.output || '');
    if (!call) return current;

    db.logConversationEvent({
      sessionId: input.sessionId, agentId: input.session.agentId,
      direction: 'tool_call', eventType: 'tool_call', provider: input.model, model: input.model,
      content: call, metadata: { round },
    });

    let relayResult: ToolRelayResponse;
    if (!input.session.toolRelayUrl) {
      relayResult = { success: false, error: 'TOOL_RELAY_URL não configurado no WebAI' };
    } else {
      try {
        const response = await fetch(input.session.toolRelayUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: input.sessionId, agent_id: input.session.agentId, tool_call: call }),
          signal: AbortSignal.timeout(120_000),
        });
        const payload = await response.json() as ToolRelayResponse;
        relayResult = response.ok ? payload : { success: false, error: payload.error || `Relay HTTP ${response.status}` };
      } catch (error) {
        relayResult = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    db.logConversationEvent({
      sessionId: input.sessionId, agentId: input.session.agentId,
      direction: 'tool_result', eventType: 'tool_result', provider: input.model, model: input.model,
      content: relayResult, success: relayResult.success, errorMessage: relayResult.error,
      metadata: { tool: call.name, round },
    });

    const toolResultMessage = buildToolResult(call, relayResult);
    db.logConversationEvent({
      sessionId: input.sessionId, agentId: input.session.agentId,
      direction: 'outbound', eventType: 'message', provider: input.model, model: input.model,
      content: toolResultMessage, metadata: { phase: 'tool_result', round },
    });

    const provider = await FastGeminiProvider.create();
    try {
      const next = await provider.sendMessage(toolResultMessage);
      current = { success: next.success, output: next.text, error: next.error };
      db.logConversationEvent({
        sessionId: input.sessionId, agentId: input.session.agentId,
        direction: 'inbound', eventType: 'message', provider: input.model, model: input.model,
        content: next.text, success: next.success, errorMessage: next.error,
        metadata: { phase: 'after_tool', round, duration_ms: next.duration },
      });
    } finally {
      provider.disconnect();
    }
  }

  return { success: false, output: current.output, error: `Limite de ${maxRounds} ciclos de tool atingido` };
}

/**
 * DELETE /api/logs/cleanup — limpa logs antigos (admin)
 */
app.delete('/api/logs/cleanup', (req: express.Request, res: express.Response) => {
  const { days } = req.query;
  const daysToKeep = days ? parseInt(days as string) : 30;
  
  const deleted = db.cleanupOldLogs(daysToKeep);
  
  res.json({ 
    success: true, 
    deleted_count: deleted,
    message: `${deleted} logs removidos (mais antigos que ${daysToKeep} dias)`
  });
});

/**
 * Monta o system prompt padrão para executor de terminal
 */
function buildDefaultSystemPrompt(terminationCode: string): string {
  return `Você é um executor automatizado de tarefas de desenvolvimento de software.
Você tem acesso a um terminal Linux e deve executar a tarefa que será fornecida.

REGRAS ABSOLUTAS:
1. Você NÃO pode falar, comentar, explicar ou conversar.
2. Você SÓ pode enviar UM comando de terminal por resposta.
3. O comando DEVE estar dentro de um bloco de código (usando \`\`\`).
4. Se precisar de mais informações, use comandos como \`cat\`, \`ls\`, \`grep\`, \`find\` — NÃO pergunte.
5. Quando a tarefa estiver 100% concluída (código escrito, testes passando, build OK), 
   envie EXATAMENTE este comando como sinal de término:
   echo "${terminationCode}"

Aguardando a tarefa...`;
}

// Start server
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 WebAI Provider rodando na porta ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Providers: ${configManager.getAllProviders().length} cadastrados`);
  console.log(`${'='.repeat(60)}\n`);
});
