/**
 * InjectXHRProvider - "Fase 1.5"
 * Usa o browser como token generator: injeta XHR via JavaScript na página
 * Envia mensagem e captura resposta SEM automação de DOM (mais rápido)
 * 
 * Vantagens sobre Fase 1:
 * - Não espera DOM renderizar (resposta via XHR)
 * - Mais rápido (~5-10s vs 15-30s)
 * - Não precisa de seletores CSS frágeis
 * 
 * Desvantagens vs Fase 2:
 * - Ainda precisa do browser aberto
 * - Mas não precisa crackear tokens
 */

import puppeteer from 'puppeteer';

export interface InjectXHRResult {
  success: boolean;
  text: string;
  reasoning?: string;
  conversationId?: string;
  responseId?: string;
  duration: number;
  error?: string;
}

export class InjectXHRProvider {
  private page: any;
  
  constructor(page: any) {
    this.page = page;
  }

  static async create(): Promise<InjectXHRProvider> {
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222',
      defaultViewport: null,
    });
    
    const pages = await browser.pages();
    const geminiPage = pages.find((p: any) => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      throw new Error('Página do Gemini não encontrada');
    }
    
    return new InjectXHRProvider(geminiPage);
  }

  async sendMessage(message: string): Promise<InjectXHRResult> {
    const startTime = Date.now();
    
    try {
      // Injetar função que envia XHR e captura resposta
      const result = await this.page.evaluate(async (msg: string) => {
        return new Promise<any>((resolve, reject) => {
          // Criar XHR
          const xhr = new XMLHttpRequest();
          
          // Montar URL (usar a mesma base da página)
          const baseUrl = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
          
          // Precisamos dos parâmetros corretos
          // Vamos capturar de um request real primeiro
          // Por enquanto, usar valores conhecidos
          const params = new URLSearchParams({
            bl: 'boq_assistant-bard-web-server_20260907.07_p0',
            hl: 'pt',
            rt: 'c',
            _reqid: String(Math.floor(Math.random() * 9000000) + 100000),
          });
          
          // f.sid — precisamos pegar da página
          // Por enquanto, vamos tentar sem ele
          
          const url = `${baseUrl}?${params.toString()}`;
          
          xhr.open('POST', url, true);
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
          xhr.setRequestHeader('X-Same-Domain', '1');
          
          xhr.onload = function() {
            if (xhr.status !== 200) {
              resolve({ success: false, error: `HTTP ${xhr.status}`, response: xhr.responseText?.substring(0, 500) });
              return;
            }
            
            // Parsear resposta
            const body = xhr.responseText || '';
            
            // Extrair texto da resposta
            // Formato: )]}'\n\n<size>\n<json>\n...
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
            
            resolve({
              success: answerText.length > 0,
              text: answerText,
              reasoning: reasoningText || undefined,
              conversationId,
              responseId,
              error: answerText.length === 0 ? 'Sem texto na resposta' : undefined,
            });
          };
          
          xhr.onerror = function() {
            resolve({ success: false, error: 'XHR error' });
          };
          
          // Aqui está o problema: precisamos montar o f.req com os tokens corretos
          // Por enquanto, vamos usar uma abordagem diferente:
          // Em vez de criar nosso próprio XHR, vamos INTERCEPTAR o próximo XHR
          // que o browser vai fazer e modificar a mensagem nele.
          
          // Abordagem alternativa: usar a função interna do Gemini para enviar
          // Precisamos encontrar a função que o Gemini usa para enviar mensagens
          
          // Por enquanto, rejeitar — precisamos de mais investigação
          resolve({ 
            success: false, 
            error: 'Precisa implementar montagem do payload com tokens',
            response: null,
          });
        });
      }, message);
      
      const duration = Date.now() - startTime;
      
      return {
        success: result.success,
        text: result.text || '',
        reasoning: result.reasoning,
        conversationId: result.conversationId,
        responseId: result.responseId,
        duration,
        error: result.error,
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
}

// Teste
async function main() {
  console.log('🚀 Testando InjectXHRProvider (Fase 1.5)...\n');
  
  const provider = await InjectXHRProvider.create();
  console.log('✅ Provider criado\n');
  
  const message = process.argv[2] || 'Responda OK';
  console.log(`💬 Mensagem: "${message}"\n`);
  
  const result = await provider.sendMessage(message);
  
  console.log(`\n⏱️  Duração: ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`✅ Sucesso: ${result.success}`);
  
  if (result.success) {
    console.log(`\n📝 Resposta: ${result.text}`);
  } else {
    console.log(`\n❌ Erro: ${result.error}`);
  }
}

main().catch(console.error);
