/**
 * CaptureFromRunningChrome - Usa o Chrome que já está rodando no container
 * Conecta via CDP na porta 9222
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CaptureResult {
  provider: string;
  timestamp: string;
  cookies: string;
  authToken?: string;
  conversationId?: string;
  responseId?: string;
  url: string;
}

async function captureFromRunningChrome(): Promise<CaptureResult[]> {
  console.log('🔌 Conectando ao Chrome já rodando (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const results: CaptureResult[] = [];

  try {
    // Pegar todas as páginas abertas
    const pages = await browser.pages();
    console.log(`📑 ${pages.length} páginas encontradas\n`);

    for (const page of pages) {
      const url = page.url();
      console.log(`🔍 Analisando: ${url}`);

      if (url.includes('gemini.google.com')) {
        console.log('  📌 Gemini detectado!\n');
        
        const result: CaptureResult = {
          provider: 'gemini',
          timestamp: new Date().toISOString(),
          cookies: '',
          url: url,
        };

        // Extrair cookies
        console.log('  🍪 Extraindo cookies...');
        const cookies = await page.cookies();
        result.cookies = cookies
          .filter(c => c.domain.includes('google.com'))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        console.log(`  ✅ ${cookies.length} cookies extraídos`);

        // Extrair auth token
        console.log('  🔑 Extraindo auth token...');
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
        console.log(`  ✅ Auth token: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

        // Extrair conversation IDs
        console.log('  💬 Extraindo conversation IDs...');
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
          console.log(`  ✅ Conversation ID: ${ids.conversationId}`);
          console.log(`  ✅ Response ID: ${ids.responseId}`);
        }

        results.push(result);
      }

      if (url.includes('chat.openai.com')) {
        console.log('  📌 ChatGPT detectado!\n');
        
        const result: CaptureResult = {
          provider: 'gpt',
          timestamp: new Date().toISOString(),
          cookies: '',
          url: url,
        };

        // Extrair cookies
        console.log('  🍪 Extraindo cookies...');
        const cookies = await page.cookies();
        result.cookies = cookies
          .filter(c => c.domain.includes('openai.com'))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        console.log(`  ✅ ${cookies.length} cookies extraídos`);

        // Extrair access_token
        console.log('  🔑 Extraindo access token...');
        const accessToken = await page.evaluate(() => {
          const sessionToken = localStorage.getItem('next-auth.session-token');
          return sessionToken;
        });
        result.authToken = accessToken || undefined;
        console.log(`  ✅ Access token: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

        results.push(result);
      }

      if (url.includes('claude.ai')) {
        console.log('  📌 Claude detectado!\n');
        
        const result: CaptureResult = {
          provider: 'claude',
          timestamp: new Date().toISOString(),
          cookies: '',
          url: url,
        };

        // Extrair cookies
        console.log('  🍪 Extraindo cookies...');
        const cookies = await page.cookies();
        result.cookies = cookies
          .filter(c => c.domain.includes('claude.ai'))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        console.log(`  ✅ ${cookies.length} cookies extraídos`);

        // Extrair sessionKey
        console.log('  🔑 Extraindo session key...');
        const sessionKey = await page.evaluate(() => {
          const cookies = document.cookie.split(';');
          for (const cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'sessionKey') return value;
          }
          return null;
        });
        result.authToken = sessionKey || undefined;
        console.log(`  ✅ Session key: ${result.authToken ? 'encontrado' : 'não encontrado'}`);

        results.push(result);
      }

      console.log('');
    }

  } finally {
    // Não fechar o browser, apenas desconectar
    browser.disconnect();
  }

  return results;
}

function generateCurlCommands(results: CaptureResult[]): string {
  let commands = '#!/bin/bash\n\n';
  commands += '# Comandos curl gerados automaticamente para teste manual\n';
  commands += `# Gerado em: ${new Date().toISOString()}\n\n`;

  for (const result of results) {
    commands += `# === ${result.provider.toUpperCase()} ===\n`;
    commands += `# Capturado em: ${result.timestamp}\n`;
    commands += `# URL: ${result.url}\n\n`;

    if (result.provider === 'gemini') {
      commands += `# Endpoint do Gemini (precisa capturar URL exata via DevTools)\n`;
      commands += `# URL provável: https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate\n\n`;
      commands += `curl -X POST "https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate" \\\n`;
      commands += `  -H "Cookie: ${result.cookies.substring(0, 200)}..." \\\n`;
      commands += `  -H "Content-Type: application/x-www-form-urlencoded" \\\n`;
      commands += `  -H "X-Same-Domain: 1" \\\n`;
      if (result.authToken) {
        commands += `  --data-urlencode "at=${result.authToken}" \\\n`;
      }
      if (result.conversationId && result.responseId) {
        commands += `  --data-urlencode 'fz=[["olá"],["${result.conversationId}"],["${result.responseId}"]]' \\\n`;
      } else {
        commands += `  --data-urlencode 'fz=[["olá"],["CONVERSATION_ID"],["RESPONSE_ID"]]' \\\n`;
      }
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
      commands += `# URL provável: https://claude.ai/api/organizations/ORG_ID/chat_conversations/CONV_ID/completion\n\n`;
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

// CLI
console.log('🚀 Iniciando captura do Chrome em execução...\n');

(async () => {
  try {
    const results = await captureFromRunningChrome();
    
    if (results.length === 0) {
      console.log('⚠️ Nenhuma página de IA encontrada.');
      console.log('💡 Abra o Gemini, ChatGPT ou Claude no Chrome e tente novamente.');
      process.exit(0);
    }

    // Salvar resultados
    const outputPath = '/tmp/webai-capture.json';
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`💾 Resultados salvos em: ${outputPath}`);
    
    // Gerar comandos curl
    const curlCommands = generateCurlCommands(results);
    const curlPath = '/tmp/webai-curl-commands.sh';
    fs.writeFileSync(curlPath, curlCommands);
    fs.chmodSync(curlPath, '755');
    console.log(`✅ Comandos curl salvos em: ${curlPath}`);
    
    console.log('\n✅ Captura concluída!\n');
    console.log('📊 Resumo:');
    for (const result of results) {
      console.log(`  - ${result.provider}: ${result.cookies.length} bytes de cookies`);
    }
    
    console.log('\n📁 Arquivos gerados:');
    console.log(`   - ${outputPath} (dados capturados)`);
    console.log(`   - ${curlPath} (comandos curl para teste manual)`);
    
    console.log('\n📋 Próximos passos:');
    console.log('   1. Revisar os dados capturados');
    console.log('   2. Testar os comandos curl manualmente');
    console.log('   3. Ajustar os payloads conforme necessário');
    console.log('   4. Implementar os providers HTTP diretos');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    console.error('\n💡 Certifique-se de que o Chrome está rodando com --remote-debugging-port=9222');
    process.exit(1);
  }
})();
