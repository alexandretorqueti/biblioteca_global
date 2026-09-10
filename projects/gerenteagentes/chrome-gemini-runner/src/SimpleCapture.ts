/**
 * SimpleCapture - Versão simplificada que apenas extrai cookies e tokens
 * Sem tentar fazer requisições automáticas
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

interface SimpleCaptureResult {
  provider: string;
  timestamp: string;
  cookies: string;
  authToken?: string;
  conversationId?: string;
  responseId?: string;
  url: string;
}

export class SimpleCapture {
  private userDataDir: string;

  constructor(userDataDir: string = '/tmp/webai-chrome-profile') {
    this.userDataDir = userDataDir;
  }

  /**
   * Captura dados do Gemini
   */
  async captureGemini(): Promise<SimpleCaptureResult> {
    console.log('\n🔍 Capturando dados do Gemini...\n');

    const result: SimpleCaptureResult = {
      provider: 'gemini',
      timestamp: new Date().toISOString(),
      cookies: '',
      url: 'https://gemini.google.com/',
    };

    // Remover lock do perfil
    const lockPath = path.join(this.userDataDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.log('🔓 Lock do perfil removido');
    }

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=9223', // Porta diferente para não conflitar
      ],
      userDataDir: this.userDataDir,
      protocolTimeout: 120_000,
    });

    try {
      const page = await browser.newPage();
      
      console.log('🌐 Navegando para Gemini...');
      await page.goto('https://gemini.google.com/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Aguardar um pouco para a página carregar completamente
      await new Promise(resolve => setTimeout(resolve, 5000));

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
      console.log(`✅ Auth token: ${result.authToken ? 'encontrado (' + result.authToken.substring(0, 50) + '...)' : 'não encontrado'}`);

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
      } else {
        console.log('⚠️ Conversation IDs não encontrados (pode ser normal na primeira visita)');
      }

    } finally {
      await browser.close();
    }

    return result;
  }

  /**
   * Captura dados do ChatGPT
   */
  async captureChatGPT(): Promise<SimpleCaptureResult> {
    console.log('\n🔍 Capturando dados do ChatGPT...\n');

    const result: SimpleCaptureResult = {
      provider: 'gpt',
      timestamp: new Date().toISOString(),
      cookies: '',
      url: 'https://chat.openai.com/',
    };

    const lockPath = path.join(this.userDataDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=9224',
      ],
      userDataDir: this.userDataDir,
      protocolTimeout: 120_000,
    });

    try {
      const page = await browser.newPage();
      
      console.log('🌐 Navegando para ChatGPT...');
      await page.goto('https://chat.openai.com/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      await new Promise(resolve => setTimeout(resolve, 5000));

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

    } finally {
      await browser.close();
    }

    return result;
  }

  /**
   * Captura dados do Claude
   */
  async captureClaude(): Promise<SimpleCaptureResult> {
    console.log('\n🔍 Capturando dados do Claude...\n');

    const result: SimpleCaptureResult = {
      provider: 'claude',
      timestamp: new Date().toISOString(),
      cookies: '',
      url: 'https://claude.ai/',
    };

    const lockPath = path.join(this.userDataDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=9225',
      ],
      userDataDir: this.userDataDir,
      protocolTimeout: 120_000,
    });

    try {
      const page = await browser.newPage();
      
      console.log('🌐 Navegando para Claude...');
      await page.goto('https://claude.ai/', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      await new Promise(resolve => setTimeout(resolve, 5000));

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

    } finally {
      await browser.close();
    }

    return result;
  }

  /**
   * Gera comandos curl para teste manual
   */
  static generateCurlCommands(results: SimpleCaptureResult[]): string {
    let commands = '#!/bin/bash\n\n';
    commands += '# Comandos curl gerados automaticamente para teste manual\n';
    commands += `# Gerado em: ${new Date().toISOString()}\n\n`;

    for (const result of results) {
      commands += `# === ${result.provider.toUpperCase()} ===\n`;
      commands += `# Capturado em: ${result.timestamp}\n\n`;

      if (result.provider === 'gemini') {
        commands += `# Endpoint do Gemini (precisa capturar via DevTools)\n`;
        commands += `curl -X POST "https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate" \\\n`;
        commands += `  -H "Cookie: ${result.cookies.substring(0, 200)}..." \\\n`;
        commands += `  -H "Content-Type: application/x-www-form-urlencoded" \\\n`;
        commands += `  -H "X-Same-Domain: 1" \\\n`;
        if (result.authToken) {
          commands += `  --data-urlencode "at=${result.authToken}" \\\n`;
        }
        commands += `  --data-urlencode 'fz=[["olá"],["CONVERSATION_ID"],["RESPONSE_ID"]]' \\\n`;
        commands += `  -v\n\n`;
      }

      if (result.provider === 'gpt') {
        commands += `# Endpoint do ChatGPT\n`;
        commands += `curl -X POST "https://chat.openai.com/backend-api/conversation" \\\n`;
        if (result.authToken) {
          commands += `  -H "Authorization: Bearer ${result.authToken}" \\\n`;
        }
        commands += `  -H "Content-Type: application/json" \\\n`;
        commands += `  -d '{\n`;
        commands += `    "action": "next",\n`;
        commands += `    "messages": [{\n`;
        commands += `      "id": "$(uuidgen)",\n`;
        commands += `      "author": {"role": "user"},\n`;
        commands += `      "content": {"content_type": "text", "parts": ["olá"]}\n`;
        commands += `    }],\n`;
        commands += `    "model": "text-davinci-002-render-sha"\n`;
        commands += `  }' \\\n`;
        commands += `  -v\n\n`;
      }

      if (result.provider === 'claude') {
        commands += `# Endpoint do Claude (precisa organization_id e conversation_id)\n`;
        commands += `curl -X POST "https://claude.ai/api/organizations/ORG_ID/chat_conversations/CONV_ID/completion" \\\n`;
        commands += `  -H "Cookie: sessionKey=${result.authToken || 'SESSION_KEY'}" \\\n`;
        commands += `  -H "Content-Type: application/json" \\\n`;
        commands += `  -d '{\n`;
        commands += `    "completion": {\n`;
        commands += `      "prompt": "olá",\n`;
        commands += `      "timezone": "America/Sao_Paulo"\n`;
        commands += `    }\n`;
        commands += `  }' \\\n`;
        commands += `  -v\n\n`;
      }
    }

    return commands;
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const capture = new SimpleCapture();
  
  console.log('🚀 Iniciando captura simplificada...\n');
  
  (async () => {
    const results: SimpleCaptureResult[] = [];
    
    try {
      // Capturar Gemini
      const gemini = await capture.captureGemini();
      results.push(gemini);
      
      // Capturar ChatGPT
      const gpt = await capture.captureChatGPT();
      results.push(gpt);
      
      // Capturar Claude
      const claude = await capture.captureClaude();
      results.push(claude);
      
      // Salvar resultados
      const outputPath = '/tmp/webai-simple-capture.json';
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
      console.log(`\n💾 Resultados salvos em: ${outputPath}`);
      
      // Gerar comandos curl
      const curlCommands = SimpleCapture.generateCurlCommands(results);
      const curlPath = '/tmp/webai-curl-commands.sh';
      fs.writeFileSync(curlPath, curlCommands);
      fs.chmodSync(curlPath, '755');
      console.log(`✅ Comandos curl salvos em: ${curlPath}`);
      
      console.log('\n✅ Captura concluída!\n');
      console.log('📁 Arquivos gerados:');
      console.log(`   - ${outputPath} (dados capturados)`);
      console.log(`   - ${curlPath} (comandos curl para teste manual)`);
      
      console.log('\n📋 Próximos passos:');
      console.log('   1. Revisar os dados capturados em', outputPath);
      console.log('   2. Testar os comandos curl em', curlPath);
      console.log('   3. Ajustar os payloads conforme necessário');
      console.log('   4. Implementar os providers HTTP diretos');
      
    } catch (error) {
      console.error('❌ Erro:', error);
      process.exit(1);
    }
  })();
}
