/**
 * FastGeminiProvider - Fase 1 otimizada
 * Usa CDP para digitar+Enter (rápido) e XHR hook para capturar resposta (sem esperar DOM)
 * 
 * Comparado com AIPage.ts (Fase 1):
 * - Fase 1: digita no DOM → espera resposta renderizar no DOM → extrai texto do DOM
 * - FastProvider: digita via CDP → captura resposta via XHR → parse direto do JSON
 * 
 * Ganho estimado: 15-30s → 5-10s
 */

import puppeteer from 'puppeteer';

export interface FastGeminiResult {
  success: boolean;
  text: string;
  reasoning?: string;
  conversationId?: string;
  responseId?: string;
  duration: number;
  error?: string;
}

export class FastGeminiProvider {
  private page: any;
  private browser: any;

  static async create(): Promise<FastGeminiProvider> {
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222',
      defaultViewport: null,
    });
    
    const pages = await browser.pages();
    const geminiPage = pages.find((p: any) => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      throw new Error('Página do Gemini não encontrada. Acesse via VNC e faça login.');
    }
    
    const provider = new FastGeminiProvider();
    provider.browser = browser;
    provider.page = geminiPage;
    
    // Instalar XHR hook para capturar respostas
    await provider.installXHRHook();
    
    return provider;
  }

  private async installXHRHook() {
    await this.page.evaluate(() => {
      // Limpar capturas anteriores
      (window as any).__fastProviderCaptures = [];
      (window as any).__fastProviderResolve = null;
      
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      
      XMLHttpRequest.prototype.open = function(method: string, url: string, ...rest: any[]) {
        (this as any).__fp_url = url;
        return origOpen.apply(this, [method, url, ...rest] as any);
      };
      
      XMLHttpRequest.prototype.send = function(body: any) {
        const url = (this as any).__fp_url || '';
        if (url.includes('StreamGenerate')) {
          const xhr = this;
          const capture: any = { url, timestamp: Date.now() };
          
          xhr.addEventListener('load', () => {
            capture.responseBody = xhr.responseText || '';
            capture.status = xhr.status;
            (window as any).__fastProviderCaptures.push(capture);
            
            // Resolver promise se houver
            if ((window as any).__fastProviderResolve) {
              (window as any).__fastProviderResolve(capture);
              (window as any).__fastProviderResolve = null;
            }
          });
        }
        return origSend.apply(this, [body] as any);
      };
    });
  }

  async sendMessage(message: string): Promise<FastGeminiResult> {
    const startTime = Date.now();
    
    try {
      // 1. Configurar promise para aguardar resposta do XHR
      await this.page.evaluate(() => {
        (window as any).__fastProviderResult = new Promise((resolve) => {
          (window as any).__fastProviderResolve = resolve;
        });
      });
      
      // 2. Digitar mensagem via CDP (rápido)
      await this.page.bringToFront();
      
      const inputSelector = '.ql-editor, [contenteditable="true"]';
      await this.page.waitForSelector(inputSelector, { timeout: 10000 });
      await this.page.click(inputSelector);
      
      // Limpar campo
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('a');
      await this.page.keyboard.up('Control');
      await this.page.keyboard.press('Backspace');
      
      // Digitar mensagem (sem delay para ser mais rápido)
      await this.page.keyboard.type(message, { delay: 5 });
      
      // 3. Enviar (Enter)
      await this.page.keyboard.press('Enter');
      
      // 4. Aguardar resposta via XHR (timeout 120s)
      const response = await this.page.evaluate(() => {
        return (window as any).__fastProviderResult;
      });
      
      if (!response || !response.responseBody) {
        const duration = Date.now() - startTime;
        return {
          success: false,
          text: '',
          duration,
          error: 'Timeout ou resposta vazia do XHR',
        };
      }
      
      // 5. Parsear resposta
      const parsed = this.parseResponse(response.responseBody);
      const duration = Date.now() - startTime;
      
      return {
        ...parsed,
        duration,
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        text: '',
        duration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseResponse(body: string): { success: boolean; text: string; reasoning?: string; conversationId?: string; responseId?: string } {
    const cleaned = body.replace(/^\)\]\}'/, '').trim();
    const lines = cleaned.split('\n');
    
    let answerText = '';
    let reasoningText = '';
    let conversationId = '';
    let responseId = '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[')) continue;
      
      try {
        const chunk = JSON.parse(trimmed);
        if (!Array.isArray(chunk) || !chunk[0] || chunk[0][0] !== 'wrb.fr') continue;
        
        const innerStr = chunk[0][2];
        if (typeof innerStr !== 'string') continue;
        
        const inner = JSON.parse(innerStr);
        
        // IDs
        if (Array.isArray(inner[1]) && typeof inner[1][0] === 'string') {
          conversationId = inner[1][0];
          responseId = inner[1][1];
        }
        
        // Novo responseId
        if (inner[2] && typeof inner[2] === 'object' && inner[2]['18']) {
          responseId = inner[2]['18'];
        }
        
        // Texto
        if (Array.isArray(inner[4]) && Array.isArray(inner[4][0])) {
          const rc = inner[4][0];
          if (Array.isArray(rc[1]) && typeof rc[1][0] === 'string' && rc[1][0].length > 0) {
            if (rc[1][0].length >= answerText.length) {
              answerText = rc[1][0];
            }
          }
          if (Array.isArray(rc[37]) && Array.isArray(rc[37][0]) && typeof rc[37][0][0] === 'string') {
            if (rc[37][0][0].length >= reasoningText.length) {
              reasoningText = rc[37][0][0];
            }
          }
        }
      } catch {}
    }
    
    return {
      success: answerText.length > 0,
      text: answerText,
      reasoning: reasoningText || undefined,
      conversationId: conversationId || undefined,
      responseId: responseId || undefined,
    };
  }

  disconnect() {
    if (this.browser) {
      this.browser.disconnect();
    }
  }
}

// Teste
async function main() {
  console.log('🚀 Testando FastGeminiProvider (Fase 1 otimizada)...\n');
  
  const provider = await FastGeminiProvider.create();
  console.log('✅ Provider criado e XHR hook instalado\n');
  
  const message = process.argv[2] || 'Responda apenas com a palavra SUCESSO';
  console.log(`💬 Mensagem: "${message}"\n`);
  
  const result = await provider.sendMessage(message);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`⏱️  Duração: ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`✅ Sucesso: ${result.success}`);
  
  if (result.success) {
    console.log(`\n📝 RESPOSTA:\n${result.text}`);
    if (result.reasoning) {
      console.log(`\n🧠 RACIOCÍNIO:\n${result.reasoning.substring(0, 300)}...`);
    }
    if (result.conversationId) {
      console.log(`\n🆔 Conv: ${result.conversationId}`);
      console.log(`🆔 Resp: ${result.responseId}`);
    }
  } else {
    console.log(`\n❌ ERRO: ${result.error}`);
  }
  console.log('='.repeat(60));
  
  provider.disconnect();
}

main().catch(console.error);
