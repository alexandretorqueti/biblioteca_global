/**
 * EndpointCapture - Captura automática de endpoints via Puppeteer CDP
 * 
 * Abre o Chrome, navega para a IA, faz uma pergunta, e captura:
 * - Cookies
 * - Auth tokens
 * - URL do endpoint
 * - Headers
 * - Payload
 * - Response
 */

import puppeteer, { type Browser, type Page, type HTTPRequest } from 'puppeteer';
import fs from 'fs';
import path from 'path';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
  };
}

interface CaptureResult {
  provider: string;
  timestamp: string;
  cookies: string;
  authToken?: string;
  conversationId?: string;
  responseId?: string;
  requests: CapturedRequest[];
}

export class EndpointCapture {
  private userDataDir: string;
  private outputPath: string;

  constructor(userDataDir: string = '/tmp/webai-chrome-profile', outputPath: string = '/tmp/webai-capture.json') {
    this.userDataDir = userDataDir;
    this.outputPath = outputPath;
  }

  /**
   * Captura endpoints do Gemini
   */
  async captureGemini(): Promise<CaptureResult> {
    console.log('\n🔍 Capturando endpoints do Gemini...\n');

    const result: CaptureResult = {
      provider: 'gemini',
      timestamp: new Date().toISOString(),
      cookies: '',
      requests: [],
    };

    const browser = await this.launchBrowser();
    
    try {
      const page = await browser.newPage();
      
      // Habilitar interceptação de rede via CDP
      const client = await page.createCDPSession();
      await client.send('Network.enable');

      // Capturar requisições
      const capturedRequests: CapturedRequest[] = [];
      
      page.on('request', (request: HTTPRequest) => {
        const url = request.url();
        if (url.includes('BardChatBackendData') || url.includes('StreamGenerate')) {
          console.log(`📡 Requisição capturada: ${url}`);
          capturedRequests.push({
            url,
            method: request.method(),
            headers: request.headers(),
            postData: request.postData(),
          });
        }
      });

      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('BardChatBackendData') || url.includes('StreamGenerate')) {
          console.log(`📥 Response capturada: ${response.status()}`);
          
          const capturedReq = capturedRequests.find(r => r.url === url);
          if (capturedReq) {
            capturedReq.response = {
              status: response.status(),
              headers: response.headers(),
            };
            
            try {
              const body = await response.text();
              capturedReq.response.body = body.substring(0, 5000); // Limitar tamanho
              console.log(`✅ Response body capturado (${body.length} chars)`);
            } catch (err) {
              console.warn('⚠️ Não foi possível capturar response body');
            }
          }
        }
      });

      // Navegar para Gemini
      console.log('🌐 Navegando para Gemini...');
      await page.goto('https://gemini.google.com/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Extrair cookies
      console.log('🍪 Extraindo cookies...');
      const cookies = await page.cookies();
      result.cookies = cookies
        .filter(c => c.domain.includes('google.com'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      console.log(`✅ ${cookies.length} cookies extraídos`);

      // Extrair auth token (SNlM0e)
      console.log('🔑 Extraindo auth token...');
      const authToken = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || '';
          const match = content.match(/"SNlM0e":"([^"]+)"/);
          if (match) return match[1];
        }
        return null;
      });
      result.authToken = authToken || undefined;
      console.log(`✅ Auth token: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

      // Extrair conversation IDs
      console.log('💬 Extraindo conversation IDs...');
      const ids = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || '';
          const convMatch = content.match(/"conversation_id":"([^"]+)"/);
          const respMatch = content.match(/"response_id":"([^"]+)"/);
          if (convMatch && respMatch) {
            return {
              conversationId: convMatch[1],
              responseId: respMatch[1],
            };
          }
        }
        return null;
      });
      
      if (ids) {
        result.conversationId = ids.conversationId;
        result.responseId = ids.responseId;
        console.log(`✅ Conversation ID: ${ids.conversationId}`);
        console.log(`✅ Response ID: ${ids.responseId}`);
      }

      // Fazer uma pergunta para capturar o endpoint real
      console.log('\n💬 Fazendo pergunta para capturar endpoint...');
      
      // Esperar o editor carregar
      await page.waitForSelector('[contenteditable="true"]', { timeout: 30000 });
      
      // Digitar pergunta
      const editor = await page.$('[contenteditable="true"]');
      if (editor) {
        await editor.click();
        await page.keyboard.type('olá', { delay: 50 });
        await page.keyboard.press('Enter');
        
        console.log('⏳ Aguardando resposta...');
        await new Promise(resolve => setTimeout(resolve, 10000)); // Aguardar 10s
      }

      result.requests = capturedRequests;
      console.log(`\n✅ ${capturedRequests.length} requisições capturadas`);

    } finally {
      await browser.close();
    }

    // Salvar resultado
    this.saveResult(result);
    
    return result;
  }

  /**
   * Captura endpoints do ChatGPT
   */
  async captureChatGPT(): Promise<CaptureResult> {
    console.log('\n🔍 Capturando endpoints do ChatGPT...\n');

    const result: CaptureResult = {
      provider: 'gpt',
      timestamp: new Date().toISOString(),
      cookies: '',
      requests: [],
    };

    const browser = await this.launchBrowser();
    
    try {
      const page = await browser.newPage();
      
      // Habilitar interceptação de rede
      const client = await page.createCDPSession();
      await client.send('Network.enable');

      const capturedRequests: CapturedRequest[] = [];
      
      page.on('request', (request: HTTPRequest) => {
        const url = request.url();
        if (url.includes('backend-api/conversation') || url.includes('backend-api/message')) {
          console.log(`📡 Requisição capturada: ${url}`);
          capturedRequests.push({
            url,
            method: request.method(),
            headers: request.headers(),
            postData: request.postData(),
          });
        }
      });

      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('backend-api/conversation') || url.includes('backend-api/message')) {
          console.log(`📥 Response capturada: ${response.status()}`);
          
          const capturedReq = capturedRequests.find(r => r.url === url);
          if (capturedReq) {
            capturedReq.response = {
              status: response.status(),
              headers: response.headers(),
            };
            
            try {
              const body = await response.text();
              capturedReq.response.body = body.substring(0, 5000);
              console.log(`✅ Response body capturado (${body.length} chars)`);
            } catch (err) {
              console.warn('⚠️ Não foi possível capturar response body');
            }
          }
        }
      });

      // Navegar para ChatGPT
      console.log('🌐 Navegando para ChatGPT...');
      await page.goto('https://chat.openai.com/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Extrair cookies
      console.log('🍪 Extraindo cookies...');
      const cookies = await page.cookies();
      result.cookies = cookies
        .filter(c => c.domain.includes('openai.com'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      console.log(`✅ ${cookies.length} cookies extraídos`);

      // Extrair access_token
      console.log('🔑 Extraindo access token...');
      const accessToken = await page.evaluate(() => {
        const sessionToken = localStorage.getItem('next-auth.session-token');
        return sessionToken;
      });
      result.authToken = accessToken || undefined;
      console.log(`✅ Access token: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

      // Fazer pergunta
      console.log('\n💬 Fazendo pergunta para capturar endpoint...');
      await page.waitForSelector('textarea', { timeout: 30000 });
      
      const textarea = await page.$('textarea');
      if (textarea) {
        await textarea.click();
        await page.keyboard.type('olá', { delay: 50 });
        await page.keyboard.press('Enter');
        
        console.log('⏳ Aguardando resposta...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      result.requests = capturedRequests;
      console.log(`\n✅ ${capturedRequests.length} requisições capturadas`);

    } finally {
      await browser.close();
    }

    this.saveResult(result);
    return result;
  }

  /**
   * Captura endpoints do Claude
   */
  async captureClaude(): Promise<CaptureResult> {
    console.log('\n🔍 Capturando endpoints do Claude...\n');

    const result: CaptureResult = {
      provider: 'claude',
      timestamp: new Date().toISOString(),
      cookies: '',
      requests: [],
    };

    const browser = await this.launchBrowser();
    
    try {
      const page = await browser.newPage();
      
      // Habilitar interceptação de rede
      const client = await page.createCDPSession();
      await client.send('Network.enable');

      const capturedRequests: CapturedRequest[] = [];
      
      page.on('request', (request: HTTPRequest) => {
        const url = request.url();
        if (url.includes('chat_conversations') || url.includes('completion')) {
          console.log(`📡 Requisição capturada: ${url}`);
          capturedRequests.push({
            url,
            method: request.method(),
            headers: request.headers(),
            postData: request.postData(),
          });
        }
      });

      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('chat_conversations') || url.includes('completion')) {
          console.log(`📥 Response capturada: ${response.status()}`);
          
          const capturedReq = capturedRequests.find(r => r.url === url);
          if (capturedReq) {
            capturedReq.response = {
              status: response.status(),
              headers: response.headers(),
            };
            
            try {
              const body = await response.text();
              capturedReq.response.body = body.substring(0, 5000);
              console.log(`✅ Response body capturado (${body.length} chars)`);
            } catch (err) {
              console.warn('⚠️ Não foi possível capturar response body');
            }
          }
        }
      });

      // Navegar para Claude
      console.log('🌐 Navegando para Claude...');
      await page.goto('https://claude.ai/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Extrair cookies
      console.log('🍪 Extraindo cookies...');
      const cookies = await page.cookies();
      result.cookies = cookies
        .filter(c => c.domain.includes('claude.ai'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      console.log(`✅ ${cookies.length} cookies extraídos`);

      // Extrair sessionKey
      console.log('🔑 Extraindo session key...');
      const sessionKey = await page.evaluate(() => {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
          const [name, value] = cookie.trim().split('=');
          if (name === 'sessionKey') return value;
        }
        return null;
      });
      result.authToken = sessionKey || undefined;
      console.log(`✅ Session key: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

      // Fazer pergunta
      console.log('\n💬 Fazendo pergunta para capturar endpoint...');
      await page.waitForSelector('[contenteditable="true"]', { timeout: 30000 });
      
      const editor = await page.$('[contenteditable="true"]');
      if (editor) {
        await editor.click();
        await page.keyboard.type('olá', { delay: 50 });
        await page.keyboard.press('Enter');
        
        console.log('⏳ Aguardando resposta...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      result.requests = capturedRequests;
      console.log(`\n✅ ${capturedRequests.length} requisições capturadas`);

    } finally {
      await browser.close();
    }

    this.saveResult(result);
    return result;
  }

  /**
   * Lança browser com configurações otimizadas
   */
  private async launchBrowser(): Promise<Browser> {
    // Remover lock do perfil se existir
    const lockPath = path.join(this.userDataDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.log('🔓 Lock do perfil removido');
    }

    return await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=9222',
      ],
      userDataDir: this.userDataDir,
      protocolTimeout: 600_000,
      dumpio: false,
    });
  }

  /**
   * Salva resultado em arquivo JSON
   */
  private saveResult(result: CaptureResult): void {
    const dir = path.dirname(this.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Adicionar ao arquivo (append)
    let existing: CaptureResult[] = [];
    if (fs.existsSync(this.outputPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(this.outputPath, 'utf-8'));
      } catch {
        existing = [];
      }
    }

    existing.push(result);
    fs.writeFileSync(this.outputPath, JSON.stringify(existing, null, 2));
    
    console.log(`\n💾 Resultado salvo em: ${this.outputPath}`);
  }

  /**
   * Gera comandos curl a partir dos resultados capturados
   */
  static generateCurlCommands(captureFile: string = '/tmp/webai-capture.json'): string {
    const results: CaptureResult[] = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
    
    let commands = '# Comandos curl gerados automaticamente\n\n';
    
    for (const result of results) {
      commands += `# === ${result.provider.toUpperCase()} ===\n`;
      commands += `# Capturado em: ${result.timestamp}\n\n`;
      
      for (const req of result.requests) {
        if (req.method === 'POST' && req.postData) {
          commands += `curl -X POST "${req.url}" \\\n`;
          
          // Headers
          for (const [key, value] of Object.entries(req.headers)) {
            if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'host') {
              commands += `  -H "${key}: ${value}" \\\n`;
            }
          }
          
          // Post data
          if (req.postData) {
            commands += `  -d '${req.postData}' \\\n`;
          }
          
          commands += '  -v\n\n';
        }
      }
      
      commands += '\n';
    }
    
    return commands;
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const capture = new EndpointCapture();
  
  console.log('🚀 Iniciando captura automática de endpoints...\n');
  
  (async () => {
    try {
      // Capturar Gemini
      await capture.captureGemini();
      
      // Capturar ChatGPT
      await capture.captureChatGPT();
      
      // Capturar Claude
      await capture.captureClaude();
      
      // Gerar comandos curl
      console.log('\n📋 Gerando comandos curl...\n');
      const curlCommands = EndpointCapture.generateCurlCommands();
      fs.writeFileSync('/tmp/webai-curl-commands.sh', curlCommands);
      console.log('✅ Comandos curl salvos em: /tmp/webai-curl-commands.sh');
      
      console.log('\n✅ Captura concluída!\n');
      console.log('📁 Arquivos gerados:');
      console.log('   - /tmp/webai-capture.json (dados capturados)');
      console.log('   - /tmp/webai-curl-commands.sh (comandos curl)');
      
    } catch (error) {
      console.error('❌ Erro:', error);
      process.exit(1);
    }
  })();
}
