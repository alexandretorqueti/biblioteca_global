/**
 * RealTimeMonitor - Monitora requisições HTTP e WebSocket em tempo real
 * Aguarda o usuário fazer uma pergunta e captura tudo
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedEvent {
  timestamp: string;
  type: 'http' | 'websocket';
  url?: string;
  method?: string;
  postData?: string;
  responseBody?: string;
  wsMessage?: string;
  wsDirection?: 'sent' | 'received';
}

async function realTimeMonitor() {
  console.log('🔍 Iniciando monitoramento em tempo real...\n');
  console.log('💡 Aguardando você fazer uma pergunta no Gemini...\n');
  console.log('🌐 Acesse: http://192.168.1.8:6080/vnc.html\n');
  console.log('⏰ Monitorando por 5 minutos...\n');

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
    console.log('='.repeat(80));
    console.log('🎯 MONITORAMENTO ATIVO - Faça sua pergunta agora!\n');

    const captured: CapturedEvent[] = [];
    const client = await geminiPage.createCDPSession();
    
    // Habilitar interceptação
    await client.send('Network.enable');
    
    // Capturar requisições HTTP
    client.on('Network.requestWillBeSent', (params) => {
      const event: CapturedEvent = {
        timestamp: new Date().toISOString(),
        type: 'http',
        url: params.request.url,
        method: params.request.method,
        postData: params.request.postData,
      };
      
      captured.push(event);
      
      // Logar apenas requisições interessantes
      if (params.request.url.includes('batchexecute') || 
          params.request.url.includes('BardChat') ||
          params.request.method === 'POST') {
        console.log(`\n📡 [${new Date().toISOString()}] HTTP ${params.request.method}: ${params.request.url.substring(0, 80)}...`);
        if (params.request.postData) {
          console.log(`   PostData (${params.request.postData.length} bytes): ${params.request.postData.substring(0, 300)}...`);
        }
      }
    });
    
    // Capturar respostas HTTP
    client.on('Network.responseReceived', async (params) => {
      if (params.response.url.includes('batchexecute') || 
          params.response.url.includes('BardChat')) {
        console.log(`\n📥 [${new Date().toISOString()}] HTTP Response: ${params.response.url.substring(0, 80)}...`);
        console.log(`   Status: ${params.response.status}`);
        
        // Tentar capturar o body
        try {
          const response = await client.send('Network.getResponseBody', {
            requestId: params.requestId,
          });
          
          const event = captured.find(e => e.url === params.response.url && !e.responseBody);
          if (event) {
            event.responseBody = response.body;
            console.log(`   Body size: ${response.body.length} bytes`);
            
            // Mostrar preview se for interessante
            if (response.body.length < 1000) {
              console.log(`   Body preview: ${response.body.substring(0, 500)}`);
            }
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
      const event: CapturedEvent = {
        timestamp: new Date().toISOString(),
        type: 'websocket',
        wsDirection: 'sent',
        wsMessage: params.response.payloadData,
      };
      
      captured.push(event);
      
      console.log(`\n📤 [${new Date().toISOString()}] WS SENT (${params.response.payloadData.length} bytes):`);
      console.log(`   Message: ${params.response.payloadData.substring(0, 500)}...`);
    });
    
    client.on('Network.webSocketFrameReceived', (params) => {
      const event: CapturedEvent = {
        timestamp: new Date().toISOString(),
        type: 'websocket',
        wsDirection: 'received',
        wsMessage: params.response.payloadData,
      };
      
      captured.push(event);
      
      console.log(`\n📥 [${new Date().toISOString()}] WS RECEIVED (${params.response.payloadData.length} bytes):`);
      console.log(`   Message: ${params.response.payloadData.substring(0, 500)}...`);
    });
    
    // Aguardar 5 minutos
    await new Promise(resolve => setTimeout(resolve, 300000));
    
    // Salvar resultados
    const outputPath = '/tmp/webai-realtime-capture.json';
    fs.writeFileSync(outputPath, JSON.stringify(captured, null, 2));
    
    console.log(`\n\n${'='.repeat(80)}`);
    console.log(`\n✅ Monitoramento concluído!`);
    console.log(`💾 Salvo em: ${outputPath}`);
    console.log(`📊 Total: ${captured.length} eventos capturados`);
    
    const httpReqs = captured.filter(c => c.type === 'http');
    const wsReqs = captured.filter(c => c.type === 'websocket');
    
    console.log(`   HTTP: ${httpReqs.length}`);
    console.log(`   WebSocket: ${wsReqs.length}`);
    
    // Procurar por mensagens com palavras-chave
    const keywords = ['pais', 'país', 'seguro', 'atomico', 'atômico', 'ataque', 'morar', 'qual', 'mais'];
    
    console.log('\n\n🔎 Procurando por mensagens com palavras-chave...\n');
    
    let foundCount = 0;
    
    for (const req of captured) {
      const textToSearch = [
        req.postData,
        req.responseBody,
        req.wsMessage
      ].filter(Boolean).join(' ').toLowerCase();
      
      const matchedKeywords = keywords.filter(kw => textToSearch.includes(kw));
      
      if (matchedKeywords.length > 0) {
        foundCount++;
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
    
    if (foundCount === 0) {
      console.log('⚠️ Nenhuma mensagem com palavras-chave encontrada');
      console.log('💡 Verifique se você fez a pergunta durante o monitoramento');
    }
    
  } finally {
    browser.disconnect();
  }
}

realTimeMonitor().catch(console.error);
