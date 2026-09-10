import type { AgentContext, AgentTool, ToolCall, ToolRelayResponse } from './types.js';

export interface SessionPromptInput {
  context: AgentContext;
  firstMessage: string;
}

export function buildSessionPrompt({ context, firstMessage }: SessionPromptInput): string {
  const files = context.files.length === 0
    ? '(nenhum arquivo fornecido)'
    : context.files.map((file) => `\n===== ARQUIVO: ${file.path} =====\n${file.content}\n===== FIM: ${file.path} =====`).join('\n');
  const tools = context.tools.length === 0
    ? '(nenhuma tool fornecida)'
    : context.tools.map(formatTool).join('\n');

  return [
    'Você está operando como o agente OpenClaw solicitado pelo Motor.',
    `Agent ID: ${context.agent_id}`,
    context.workspace ? `Workspace: ${context.workspace}` : '',
    '',
    'CONTEXTO DOS ARQUIVOS DO AGENTE:',
    files,
    '',
    'TOOLS DISPONÍVEIS:',
    tools,
    '',
    'PROTOCOLO DE TOOLS:',
    'Quando precisar usar uma tool, responda SOMENTE com um bloco no formato:',
    '<tool_call>{"name":"nome_da_tool","arguments":{}}</tool_call>',
    'Aguarde o <tool_result> antes de continuar. Quando terminar, responda normalmente.',
    '',
    'PRIMEIRA MENSAGEM DO MOTOR:',
    firstMessage,
  ].filter(Boolean).join('\n');
}

function formatTool(tool: AgentTool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? {},
  });
}

export function parseToolCall(text: string): ToolCall | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<ToolCall>;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    const args = parsed.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { name: parsed.name, arguments: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function buildToolResult(call: ToolCall, result: ToolRelayResponse): string {
  return `<tool_result>${JSON.stringify({ name: call.name, success: result.success, output: result.output, error: result.error })}</tool_result>`;
}
