/**
 * NetworkInterceptor - Intercepta requisições de rede via CDP
 * Captura URLs, headers, payloads e responses em tempo real
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedNetworkRequest {
  timestamp: string;
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

async function interceptNetworkRequests() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const capturedRequests: CapturedNetworkRequest[] = [];

  try {
    const pages = await browser.pages();
    
    // Encontrar página do Gemini
    const geminiPage = pages.find(p => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      console.log('❌ Página do Gemini não encontrada');
      console.log('💡 Abra o Gemini no Chrome e tente novamente');
      return;
    }

    console.log('📌 Página do Gemini encontrada\n');
    console.log('🔍 Iniciando interceptação de rede...\n');
    console.log('💡 Faça uma pergunta no Gemini agora para capturar a requisição\n');

    // Criar CDP session
    const client = await geminiPage.createCDPSession();
    
    // Habilitar Network domain
    await client.send('Network.enable');

    // Capturar requests
    client.on('Network.requestWillBeSent', (params) => {
      const url = params.request.url;
      
      // Filtrar apenas requisições relevantes (batchexecute, StreamGenerate, etc)
      if (url.includes('batchexecute') || 
          url.includes('BardChatBackendData') || 
          url.includes('StreamGenerate') ||
          url.includes('assistant.lamda')) {
        
        console.log('📡 Requisição capturada:');
        console.log(`   URL: ${url}`);
        console.log(`   Method: ${params.request.method}`);
        console.log('');
        
        capturedRequests.push({
          timestamp: new Date().toISOString(),
          url: url,
          method: params.request.method,
          headers: params.request.headers,
          postData: params.request.postData,
        });
      }
    });

    // Capturar responses
    client.on('Network.responseReceived', async (params) => {
      const url = params.response.url;
      
      if (url.includes('batchexecute') || 
          url.includes('BardChatBackendData') || 
          url.includes('StreamGenerate') ||
          url.includes('assistant.lamda')) {
        
        console.log('📥 Response capturada:');
        console.log(`   URL: ${url}`);
        console.log(`   Status: ${params.response.status}`);
        console.log('');
        
        const capturedReq = capturedRequests.find(r => r.url === url);
        if (capturedReq) {
          capturedReq.response = {
            status: params.response.status,
            headers: params.response.headers,
          };
          
          // Tentar capturar body
          try {
            const response = await client.send('Network.getResponseBody', {
              requestId: params.requestId,
            });
            capturedReq.response.body = response.body.substring(0, 10000); // Limitar tamanho
            console.log(`   Body: ${response.body.length} bytes`);
          } catch (err) {
            console.log('   Body: não disponível ainda');
          }
        }
      }
    });

    // Aguardar o usuário fazer uma pergunta
    console.log('⏳ Aguardando requisições (60 segundos)...');
    console.log('💡 Faça uma pergunta no Gemini agora!\n');
    
    await new Promise(resolve => setTimeout(resolve, 60000));

    // Salvar resultados
    if (capturedRequests.length > 0) {
      const outputPath = '/tmp/webai-network-capture.json';
      fs.writeFileSync(outputPath, JSON.stringify(capturedRequests, null, 2));
      
      console.log(`\n✅ ${capturedRequests.length} requisições capturadas`);
      console.log(`💾 Salvas em: ${outputPath}`);
      
      // Gerar comando curl
      console.log('\n📋 Comando curl para teste:\n');
      for (const req of capturedRequests) {
        if (req.method === 'POST' && req.postData) {
          console.log(`curl -X POST "${req.url}" \\`);
          for (const [key, value] of Object.entries(req.headers)) {
            if (key.toLowerCase() !== 'content-length' && 
                key.toLowerCase() !== 'host' &&
                key.toLowerCase() !== 'content-type') {
              console.log(`  -H "${key}: ${value}" \\`);
            }
          }
          console.log(`  -H "Content-Type: ${req.headers['content-type'] || 'application/x-www-form-urlencoded'}" \\`);
          console.log(`  --data '${req.postData}' \\`);
          console.log('  -v\n');
        }
      }
    } else {
      console.log('\n⚠️ Nenhuma requisição capturada');
      console.log('💡 Tente fazer uma pergunta no Gemini');
    }

  } finally {
    browser.disconnect();
  }
}

interceptNetworkRequests().catch(console.error);
