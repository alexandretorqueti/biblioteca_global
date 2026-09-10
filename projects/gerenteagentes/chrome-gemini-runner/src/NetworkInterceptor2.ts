/**
 * NetworkInterceptor v2 - Captura requisições batchexecute do Gemini
 * Roda por 5 minutos para dar tempo de fazer a pergunta
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedRequest {
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

async function intercept() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const capturedRequests: CapturedRequest[] = [];

  try {
    const pages = await browser.pages();
    const geminiPage = pages.find(p => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      console.log('❌ Página do Gemini não encontrada');
      return;
    }

    console.log('📌 Página do Gemini encontrada\n');
    console.log('🔍 Iniciando interceptação de rede...\n');
    console.log('💡 Faça uma pergunta no Gemini agora!\n');
    console.log('⏰ Tempo de captura: 5 minutos\n');

    const client = await geminiPage.createCDPSession();
    await client.send('Network.enable');

    // Capturar TODAS as requisições POST
    client.on('Network.requestWillBeSent', (params) => {
      const url = params.request.url;
      
      // Capturar qualquer requisição POST para batchexecute
      if (params.request.method === 'POST' && url.includes('batchexecute')) {
        console.log(`\n📡 [${new Date().toISOString()}] Requisição capturada:`);
        console.log(`   URL: ${url.substring(0, 100)}...`);
        console.log(`   Method: ${params.request.method}`);
        if (params.request.postData) {
          console.log(`   PostData: ${params.request.postData.substring(0, 200)}...`);
        }
        
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
      
      if (url.includes('batchexecute')) {
        console.log(`\n📥 [${new Date().toISOString()}] Response capturada:`);
        console.log(`   URL: ${url.substring(0, 100)}...`);
        console.log(`   Status: ${params.response.status}`);
        
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
            capturedReq.response.body = response.body;
            console.log(`   Body: ${response.body.length} bytes`);
            if (response.body.length < 500) {
              console.log(`   Body content: ${response.body}`);
            }
          } catch (err) {
            console.log('   Body: não disponível ainda');
          }
        }
      }
    });

    // Aguardar 5 minutos
    console.log('⏳ Aguardando requisições (300 segundos)...');
    await new Promise(resolve => setTimeout(resolve, 300000));

    // Salvar resultados
    if (capturedRequests.length > 0) {
      const outputPath = '/tmp/webai-network-capture-v2.json';
      fs.writeFileSync(outputPath, JSON.stringify(capturedRequests, null, 2));
      
      console.log(`\n\n✅ ${capturedRequests.length} requisições capturadas`);
      console.log(`💾 Salvas em: ${outputPath}`);
      
      // Mostrar resumo
      for (const req of capturedRequests) {
        console.log(`\n📋 Requisição em ${req.timestamp}:`);
        console.log(`   URL: ${req.url.substring(0, 100)}...`);
        if (req.postData) {
          console.log(`   PostData: ${req.postData.substring(0, 300)}...`);
        }
        if (req.response) {
          console.log(`   Response status: ${req.response.status}`);
          if (req.response.body) {
            console.log(`   Response body: ${req.response.body.substring(0, 300)}...`);
          }
        }
      }
    } else {
      console.log('\n⚠️ Nenhuma requisição capturada');
    }

  } finally {
    browser.disconnect();
  }
}

intercept().catch(console.error);
