/**
 * AIPage — abstrai a interação com qualquer página de IA (Gemini, GPT, Claude, etc.)
 */

import type { Page } from 'puppeteer';
import type { AIProviderConfig } from './types.js';

export class AIPage {
  constructor(
    private page: Page,
    private provider: AIProviderConfig
  ) {}

  /**
   * Aguarda a IA terminar de gerar a resposta
   * Monitora o botão "Stop/Parar" — quando some, a geração terminou
   */
  async waitForGenerationComplete(timeoutMs = 300_000): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      await this.page.waitForSelector(this.provider.selectors.stopButton, { 
        hidden: true, 
        timeout: timeoutMs 
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.warn(`⚠️ Timeout aguardando geração completar (${this.provider.name})`);
    }
  }

  /**
   * Lê o último bloco de código da resposta da IA
   * Tenta pegar o <pre> inteiro (que contém todos os <code>), ou fallback para último <code>
   */
  async readLastCommand(): Promise<string | null> {
    return await this.page.evaluate((seletor) => {
      // Tenta pegar o último <pre> (bloco de código completo)
      const pres = document.querySelectorAll('pre');
      if (pres.length > 0) {
        const lastPre = pres[pres.length - 1] as HTMLElement;
        const text = lastPre.innerText.trim();
        if (text) return text;
      }
      
      // Fallback: pega o último <code> (se não houver <pre>)
      const codes = document.querySelectorAll(seletor);
      if (codes.length === 0) return null;
      return (codes[codes.length - 1] as HTMLElement).innerText.trim();
    }, this.provider.selectors.code);
  }

  /**
   * Envia uma mensagem para a IA
   */
  async sendMessage(message: string): Promise<void> {
    await this.page.waitForSelector(this.provider.selectors.editor, { visible: true });
    await this.page.click(this.provider.selectors.editor);
    
    // Limpa o editor (CSP-safe)
    await this.page.evaluate((seletor) => {
      const caixa = document.querySelector(seletor) as HTMLElement;
      if (!caixa) return;
      caixa.focus();
      document.execCommand('selectAll', false, undefined as any);
      document.execCommand('delete', false, undefined as any);
    }, this.provider.selectors.editor);
    
    // Insere o texto em chunks (evita travamento)
    const chunkSize = 5000;
    const tempoDeRespiro = 50;
    
    for (let i = 0; i < message.length; i += chunkSize) {
      const chunk = message.slice(i, i + chunkSize);
      
      await this.page.evaluate((seletor, pedaco) => {
        const caixa = document.querySelector(seletor) as HTMLElement;
        if (!caixa) return;
        caixa.focus();
        document.execCommand('insertText', false, pedaco);
      }, this.provider.selectors.editor, chunk);
      
      await new Promise(resolve => setTimeout(resolve, tempoDeRespiro));
    }
    
    // Dispara evento de input para habilitar o botão Enviar
    await this.page.evaluate((seletor) => {
      const caixa = document.querySelector(seletor);
      if (!caixa) return;
      caixa.dispatchEvent(new Event('input', { bubbles: true }));
    }, this.provider.selectors.editor);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Envia com Enter
    await this.page.keyboard.press('Enter');
  }

  /**
   * Navega para a IA e aguarda carregar
   */
  async navigate(): Promise<void> {
    await this.page.goto(this.provider.url, { 
      waitUntil: 'networkidle2',
      timeout: 60_000 
    });
    
    await this.page.waitForSelector(this.provider.selectors.editor, { 
      visible: true, 
      timeout: 30_000 
    });
  }

  /**
   * Verifica se está na página da IA
   */
  async isOnProviderPage(): Promise<boolean> {
    const url = this.page.url();
    return url.includes(new URL(this.provider.url).hostname);
  }
}
