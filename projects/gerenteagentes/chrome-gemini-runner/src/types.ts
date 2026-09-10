/**
 * Contratos do WebAI Provider
 */

export interface AIProviderConfig {
  id: string;
  name: string;
  url: string;
  selectors: {
    code: string;
    editor: string;
    stopButton: string;
  };
  promptStyle: 'gemini' | 'gpt' | 'claude' | 'generic';
  auth?: {
    type: 'cookie' | 'token' | 'none';
    value?: string;
  };
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProjectContext {
  name: string;
  repoPath: string;
  stack?: string;
  documentation?: string;
}

export interface SubTaskContext {
  id: string;
  description: string;
  scope?: string;
  successCriteria?: string;
}

export interface WebAIRunnerConfig {
  debugPort?: number;
  headless?: boolean;
  taskTimeoutMs?: number;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  userDataDir?: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executedAt: Date;
  durationMs: number;
}

export interface ExecutionResult {
  success: boolean;
  terminationCode?: string;
  commandsExecuted: CommandResult[];
  totalDurationMs: number;
  error?: string;
  output?: string;
}

// OpenAI API contracts
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentContextFile {
  path: string;
  content: string;
}

export interface AgentTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AgentContext {
  agent_id: string;
  workspace?: string;
  files: AgentContextFile[];
  tools: AgentTool[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolRelayResponse {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  agent_id?: string;
  session_id?: string;
  agent_context?: AgentContext;
  tool_relay_url?: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length';
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
