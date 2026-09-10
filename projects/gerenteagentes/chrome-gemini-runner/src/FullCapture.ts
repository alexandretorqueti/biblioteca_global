/**
 * FullCapture - Captura COMPLETA de todas as requisições HTTP e WebSocket
 * Inicia interceptação ANTES de fazer a pergunta
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedRequest {
  timestamp: string;
  type: 'http' | 'websocket';
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  responseBody?: string;
  wsMessage?: string;
  wsDirection?: 'sent' | 'received';
}

async function fullCapture() {
  console.log('🔍 Iniciando captura COMPLETA...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  try {
    const pages = await browser.pages();
    const geminiPage = pages.find(p => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      console.log('❌ Página do Gemini não encontrada');
      return;
    }

    console.log('📌 Página do Gemini encontrada\n');
    console.log(`🌐 URL: ${geminiPage.url()}\n`);

    const captured: CapturedRequest[] = [];
    const client = await geminiPage.createCDPSession();
    
    // Habilitar interceptação
    await client.send('Network.enable');
    
    // Capturar requisições HTTP
    client.on('Network.requestWillBeSent', (params) => {
      captured.push({
        timestamp: new Date().toISOString(),
        type: 'http',
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData,
      });
      
      if (params.request.url.includes('batchexecute')) {
        console.log(`\n📡 [${new Date().toISOString()}] HTTP POST: ${params.request.url.substring(0, 80)}...`);
        if (params.request.postData) {
          console.log(`   PostData: ${params.request.postData.substring(0, 200)}...`);
        }
      }
    });
    
    // Capturar respostas HTTP
    client.on('Network.responseReceived', async (params) => {
      if (params.response.url.includes('batchexecute')) {
        console.log(`\n📥 [${new Date().toISOString()}] HTTP Response: ${params.response.url.substring(0, 80)}...`);
        console.log(`   Status: ${params.response.status}`);
        
        // Tentar capturar o body
        try {
          const response = await client.send('Network.getResponseBody', {
            requestId: params.requestId,
          });
          
          const req = captured.find(r => r.url === params.response.url && !r.responseBody);
          if (req) {
            req.responseBody = response.body;
            console.log(`   Body size: ${response.body.length} bytes`);
          }
        } catch (err) {
          console.log(`   ⚠️ Não foi possível capturar o body`);
        }
      }
    });
    
    // Capturar WebSockets
    client.on('Network.webSocketCreated', (params) => {
      console.log(`\n🔗 [${new Date().toISOString()}] WebSocket criado: ${params.url}`);
    });
    
    client.on('Network.webSocketFrameSent', (params) => {
      captured.push({
        timestamp: new Date().toISOString(),
        type: 'websocket',
        wsDirection: 'sent',
        wsMessage: params.response.payloadData,
      });
      
      console.log(`\n📤 [${new Date().toISOString()}] WS SENT: ${params.response.payloadData.substring(0, 200)}...`);
    });
    
    client.on('Network.webSocketFrameReceived', (params) => {
      captured.push({
        timestamp: new Date().toISOString(),
        type: 'websocket',
        wsDirection: 'received',
        wsMessage: params.response.payloadData,
      });
      
      console.log(`\n📥 [${new Date().toISOString()}] WS RECEIVED: ${params.response.payloadData.substring(0, 200)}...`);
    });
    
    console.log('\n⏳ Captura iniciada. Faça uma pergunta no Gemini agora!');
    console.log('⏰ Aguardando 60 segundos...\n');
    
    // Aguardar 60 segundos para capturar a pergunta e resposta
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    // Salvar resultados
    const outputPath = '/tmp/webai-full-capture.json';
    fs.writeFileSync(outputPath, JSON.stringify(captured, null, 2));
    
    console.log(`\n\n✅ Captura concluída!`);
    console.log(`💾 Salvo em: ${outputPath}`);
    console.log(`📊 Total: ${captured.length} eventos capturados`);
    
    const httpReqs = captured.filter(c => c.type === 'http');
    const wsReqs = captured.filter(c => c.type === 'websocket');
    
    console.log(`   HTTP: ${httpReqs.length}`);
    console.log(`   WebSocket: ${wsReqs.length}`);
    
    // Procurar por mensagens com palavras-chave
    const keywords = ['pais', 'país', 'seguro', 'atomico', 'atômico', 'ataque', 'morar'];
    
    console.log('\n\n🔎 Procurando por mensagens com palavras-chave...\n');
    
    for (const req of captured) {
      const textToSearch = [
        req.postData,
        req.responseBody,
        req.wsMessage
      ].filter(Boolean).join(' ').toLowerCase();
      
      const matchedKeywords = keywords.filter(kw => textToSearch.includes(kw));
      
      if (matchedKeywords.length > 0) {
        console.log(`✅ [${req.timestamp}] ${req.type.toUpperCase()} - Keywords: ${matchedKeywords.join(', ')}`);
        
        if (req.url) {
          console.log(`   URL: ${req.url.substring(0, 100)}...`);
        }
        
        if (req.postData) {
          console.log(`   PostData: ${req.postData.substring(0, 500)}...`);
        }
        
        if (req.wsMessage) {
          console.log(`   WS Message: ${req.wsMessage.substring(0, 500)}...`);
        }
        
        if (req.responseBody) {
          console.log(`   Response: ${req.responseBody.substring(0, 500)}...`);
        }
        
        console.log();
      }
    }
    
  } finally {
    browser.disconnect();
  }
}

fullCapture().catch(console.error);
