/**
 * GeminiDirectProvider - Envia mensagens para o Gemini via HTTP direto
 * Sem browser automation - usa o endpoint StreamGenerate capturado via engenharia reversa
 *
 * Estratégia TEMPLATE: o payload completo (99 posições) foi capturado de uma sessão real.
 * A cada mensagem, clonamos o template e trocamos apenas:
 *   - template[0][0] = mensagem do usuário
 *   - template[2][0..2] = conversationId, responseId, choiceId (novos ou da conversa atual)
 *
 * Endpoint: https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 */

import fs from 'fs';

export interface GeminiSession {
  provider: string;
  url: string;
  bl: string;
  fsid: string;
  hl: string;
  at: string;                 // auth token (SNlM0e)
  cookies: string;            // header Cookie completo
  googHeaders: Record<string, string>;  // headers x-goog-ext-*
  userAgent: string;
  template: any[];            // payload f.req[1] capturado (99 posições)
}

export interface GeminiDirectResult {
  success: boolean;
  text: string;
  reasoning?: string;
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
  error?: string;
  raw?: string;
}

/** Gera um ID aleatório no formato usado pelo Gemini */
function generateId(prefix: string, len = 16): string {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < len; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${id}`;
}

export class GeminiDirectProvider {
  private session: GeminiSession;
  private conversationId: string;
  private responseId: string;

  constructor(sessionPath: string = '/app/gemini-session.json') {
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    this.session = JSON.parse(raw);
    
    // IDs de sessão — novos por provider (nova conversa)
    this.conversationId = generateId('c_');
    this.responseId = generateId('r_');
    
    console.log(`✅ [GeminiDirect] Sessão carregada (${sessionPath})`);
    console.log(`   template: ${this.session.template.length} posições`);
  }

  /**
   * Envia uma mensagem para o Gemini e retorna a resposta
   */
  async sendMessage(message: string): Promise<GeminiDirectResult> {
    try {
      // 1. Clonar o template e trocar mensagem + IDs
      const template = structuredClone(this.session.template);
      template[0][0] = message;
      template[2][0] = this.conversationId;
      template[2][1] = this.responseId;
      template[2][2] = generateId('rc_');
      
      // 2. Montar f.req = [null, "<template JSON>"]
      const fReq = JSON.stringify([null, JSON.stringify(template)]);
      
      // 3. Montar URL com parâmetros
      const url = new URL(this.session.url);
      url.searchParams.set('bl', this.session.bl);
      url.searchParams.set('f.sid', this.session.fsid);
      url.searchParams.set('hl', this.session.hl);
      url.searchParams.set('_reqid', String(Math.floor(Math.random() * 9000000) + 100000));
      url.searchParams.set('rt', 'c');
      
      console.log(`📡 [GeminiDirect] Enviando mensagem (${message.length} chars)...`);
      
      // 4. Headers (incluindo x-goog-ext capturados)
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': this.session.cookies,
        'X-Same-Domain': '1',
        'Referer': 'https://gemini.google.com/',
        'User-Agent': this.session.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        ...this.session.googHeaders,
      };
      
      // 5. POST
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          'f.req': fReq,
          'at': this.session.at,
        }).toString(),
        signal: AbortSignal.timeout(120000),
      });
      
      if (!response.ok) {
        return {
          success: false,
          text: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      
      const body = await response.text();
      console.log(`📥 [GeminiDirect] Response: ${body.length} bytes`);
      
      // 6. Parsear resposta
      return this.parseResponse(body);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        text: '',
        error: errorMessage,
      };
    }
  }

  /**
   * Parseia a resposta no formato streaming do Gemini
   * Formato: )]}'\n\n<size>\n<json>\n<size>\n<json>...
   * Cada json: [["wrb.fr",null,"<inner>"],...]
   */
  private parseResponse(body: string): GeminiDirectResult {
    try {
      // Remove prefixo anti-XSSI
      const cleaned = body.replace(/^\)\]\}'/, '').trim();
      
      // Divide em linhas; linhas numéricas são sizes, linhas [ são JSON
      const lines = cleaned.split('\n');
      
      let answerText = '';
      let reasoningText = '';
      let latestConversationId: string | undefined;
      let latestResponseId: string | undefined;
      let latestChoiceId: string | undefined;
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('[')) continue;
        
        try {
          const chunk = JSON.parse(trimmed);
          // Formato: [["wrb.fr", null, "<inner json string>"], ["di",...], ...]
          if (!Array.isArray(chunk) || !chunk[0] || chunk[0][0] !== 'wrb.fr') continue;
          
          const innerStr = chunk[0][2];
          if (typeof innerStr !== 'string') continue;
          
          const inner = JSON.parse(innerStr);
          
          // inner[1] = ["c_xxx", "r_xxx"] — IDs da conversa
          if (Array.isArray(inner[1]) && typeof inner[1][0] === 'string') {
            latestConversationId = inner[1][0];
            latestResponseId = inner[1][1];
          }
          
          // inner[2] pode ter {"18": "r_xxx"} — novo responseId
          if (inner[2] && typeof inner[2] === 'object' && inner[2]['18']) {
            latestResponseId = inner[2]['18'];
          }
          
          // inner[4][0] = array da resposta
          if (Array.isArray(inner[4]) && Array.isArray(inner[4][0])) {
            const rc = inner[4][0];
            
            // rc[0] = choice id (rc_xxx)
            if (typeof rc[0] === 'string' && rc[0].startsWith('rc_')) {
              latestChoiceId = rc[0];
            }
            
            // rc[1] = [texto da resposta] — pegar o mais longo/latest
            if (Array.isArray(rc[1]) && typeof rc[1][0] === 'string' && rc[1][0].length > 0) {
              if (rc[1][0].length >= answerText.length) {
                answerText = rc[1][0];
              }
            }
            
            // rc[37][0][0] = texto do raciocínio (thinking)
            if (Array.isArray(rc[37]) && Array.isArray(rc[37][0]) && typeof rc[37][0][0] === 'string') {
              if (rc[37][0][0].length >= reasoningText.length) {
                reasoningText = rc[37][0][0];
              }
            }
          }
        } catch {
          // chunk inválido, ignora
        }
      }
      
      // Atualiza IDs para continuidade da conversa
      if (latestConversationId) this.conversationId = latestConversationId;
      if (latestResponseId) this.responseId = latestResponseId;
      
      if (!answerText) {
        return {
          success: false,
          text: '',
          error: 'Resposta sem texto (pode ter sido bloqueada ou token expirado)',
          raw: body.substring(0, 2000),
        };
      }
      
      return {
        success: true,
        text: answerText,
        reasoning: reasoningText || undefined,
        conversationId: this.conversationId,
        responseId: this.responseId,
        choiceId: latestChoiceId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        text: '',
        error: `Erro ao parsear resposta: ${errorMessage}`,
        raw: body.substring(0, 2000),
      };
    }
  }

  /** Reseta a conversa (novos IDs) */
  resetConversation(): void {
    this.conversationId = generateId('c_');
    this.responseId = generateId('r_');
  }

  getConversationId(): string {
    return this.conversationId;
  }
}
