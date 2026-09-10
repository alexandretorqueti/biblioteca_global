/**
 * ConfigManager — gerencia as IAs cadastradas
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AIProviderConfig } from './types.js';

const CONFIG_FILE = process.env.WEBAI_CONFIG_FILE || './webai-providers.json';

export class ConfigManager {
  private providers: Map<string, AIProviderConfig> = new Map();

  constructor() {
    this.loadConfig();
  }

  /**
   * Carrega a configuração do arquivo
   */
  private loadConfig(): void {
    if (existsSync(CONFIG_FILE)) {
      try {
        const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        for (const provider of data.providers || []) {
          this.providers.set(provider.id, provider);
        }
        console.log(`✅ ${this.providers.size} provider(s) carregado(s)`);
      } catch (error) {
        console.error('❌ Erro ao carregar config:', error);
      }
    } else {
      console.log('⚠️ Arquivo de config não encontrado, usando defaults');
      this.loadDefaults();
    }
  }

  /**
   * Carrega configurações padrão (Gemini, GPT, Claude)
   */
  private loadDefaults(): void {
    const defaults: AIProviderConfig[] = [
      {
        id: 'gemini',
        name: 'Google Gemini',
        url: 'https://gemini.google.com/',
        selectors: {
          code: 'code',
          editor: '.ql-editor',
          stopButton: 'button[aria-label*="Parar"], button[aria-label*="Stop"]',
        },
        promptStyle: 'gemini',
        contextWindow: 1000000,
        maxTokens: 8192,
      },
      {
        id: 'gpt',
        name: 'ChatGPT',
        url: 'https://chat.openai.com/',
        selectors: {
          code: 'pre code',
          editor: '#prompt-textarea',
          stopButton: 'button[data-testid="stop-button"]',
        },
        promptStyle: 'gpt',
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: 'claude',
        name: 'Claude',
        url: 'https://claude.ai/',
        selectors: {
          code: 'code',
          editor: '[contenteditable="true"]',
          stopButton: 'button[aria-label="Stop Response"]',
        },
        promptStyle: 'claude',
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ];

    for (const provider of defaults) {
      this.providers.set(provider.id, provider);
    }
  }

  /**
   * Retorna um provider pelo ID
   */
  getProvider(id: string): AIProviderConfig | undefined {
    return this.providers.get(id);
  }

  /**
   * Retorna todos os providers
   */
  getAllProviders(): AIProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Adiciona ou atualiza um provider
   */
  setProvider(provider: AIProviderConfig): void {
    this.providers.set(provider.id, provider);
    this.saveConfig();
  }

  /**
   * Remove um provider
   */
  removeProvider(id: string): boolean {
    const removed = this.providers.delete(id);
    if (removed) {
      this.saveConfig();
    }
    return removed;
  }

  /**
   * Salva a configuração no arquivo
   */
  private saveConfig(): void {
    const data = {
      providers: Array.from(this.providers.values()),
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    console.log(`✅ Config salva (${this.providers.size} providers)`);
  }
}
