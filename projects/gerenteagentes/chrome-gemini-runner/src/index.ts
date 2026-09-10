/**
 * WebAI Provider — executor de tarefas via Chrome + IAs web
 * 
 * @example
 * ```ts
 * // Servidor HTTP (API OpenAI-compatible)
 * import './server.js';
 * 
 * // Ou usar o runner diretamente
 * import { WebAIRunner, ConfigManager } from './index.js';
 * 
 * const config = new ConfigManager();
 * const runner = new WebAIRunner();
 * 
 * const provider = config.getProvider('gemini');
 * const result = await runner.execute(provider, systemPrompt, userMessage);
 * ```
 */

export { WebAIRunner } from './WebAIRunner.js';
export { BrowserManager } from './BrowserManager.js';
export { AIPage } from './AIPage.js';
export { PromptBuilder } from './PromptBuilder.js';
export { CommandSanitizer } from './CommandSanitizer.js';
export { ConfigManager } from './config.js';
export * from './types.js';
