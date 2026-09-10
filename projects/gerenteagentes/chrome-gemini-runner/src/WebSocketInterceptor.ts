/**
 * WebSocketInterceptor - Captura mensagens WebSocket do Gemini
 * Usa CDP para interceptar conexões WebSocket em tempo real
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedWSMessage {
  timestamp: string;
  type: 'sent' | 'received';
  wsUrl: string;
  data: string;
  size: number;
}

interface CaptureResult {
  provider: string;
  timestamp: string;
  messages: CapturedWSMessage[];
}

async function interceptWebSocket() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const capturedMessages: CapturedWSMessage[] = [];

  try {
    const pages = await browser.pages();
    const geminiPage = pages.find(p => p.url().includes('gemini.google.com'));
    
    if (!geminiPage) {
      console.log('❌ Página do Gemini não encontrada');
      return;
    }

    console.log('📌 Página do Gemini encontrada\n');
    console.log('🔍 Iniciando interceptação de WebSocket...\n');
    console.log('💡 Faça uma pergunta no Gemini agora!\n');
    console.log('⏰ Tempo de captura: 5 minutos\n');

    const client = await geminiPage.createCDPSession();
    
    // Habilitar interceptação de Network e WebSocket
    await client.send('Network.enable');
    
    // Armazenar mapeamento de requestId -> wsUrl
    const wsUrls = new Map<string, string>();
    
    // Capturar criação de WebSocket
    client.on('Network.webSocketCreated', (params) => {
      console.log(`\n🔗 WebSocket criado:`);
      console.log(`   ID: ${params.requestId}`);
      console.log(`   URL: ${params.url}`);
      wsUrls.set(params.requestId, params.url);
    });
    
    // Capturar mensagens enviadas
    client.on('Network.webSocketFrameSent', (params) => {
      const wsUrl = wsUrls.get(params.requestId) || 'unknown';
      
      // Filtrar apenas WebSockets do Gemini
      if (wsUrl.includes('google.com') || wsUrl.includes('gemini')) {
        const msg: CapturedWSMessage = {
          timestamp: new Date().toISOString(),
          type: 'sent',
          wsUrl: wsUrl,
          data: params.response.payloadData,
          size: params.response.payloadData.length,
        };
        capturedMessages.push(msg);
        
        console.log(`\n📤 [${new Date().toISOString()}] WS SENT (${msg.size} bytes):`);
        console.log(`   WS: ${wsUrl.substring(0, 80)}...`);
        console.log(`   Data: ${msg.data.substring(0, 300)}...`);
      }
    });
    
    // Capturar mensagens recebidas
    client.on('Network.webSocketFrameReceived', (params) => {
      const wsUrl = wsUrls.get(params.requestId) || 'unknown';
      
      if (wsUrl.includes('google.com') || wsUrl.includes('gemini')) {
        const msg: CapturedWSMessage = {
          timestamp: new Date().toISOString(),
          type: 'received',
          wsUrl: wsUrl,
          data: params.response.payloadData,
          size: params.response.payloadData.length,
        };
        capturedMessages.push(msg);
        
        console.log(`\n📥 [${new Date().toISOString()}] WS RECEIVED (${msg.size} bytes):`);
        console.log(`   WS: ${wsUrl.substring(0, 80)}...`);
        console.log(`   Data: ${msg.data.substring(0, 300)}...`);
      }
    });
    
    // Capturar fechamento de WebSocket
    client.on('Network.webSocketClosed', (params) => {
      const wsUrl = wsUrls.get(params.requestId) || 'unknown';
      if (wsUrl.includes('google.com') || wsUrl.includes('gemini')) {
        console.log(`\n🔒 WebSocket fechado: ${params.requestId}`);
      }
    });
    
    // Aguardar 5 minutos
    console.log('⏳ Aguardando mensagens WebSocket (300 segundos)...');
    await new Promise(resolve => setTimeout(resolve, 300000));
    
    // Salvar resultados
    const result: CaptureResult = {
      provider: 'gemini',
      timestamp: new Date().toISOString(),
      messages: capturedMessages,
    };
    
    const outputPath = '/tmp/webai-ws-capture.json';
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    
    console.log(`\n\n✅ ${capturedMessages.length} mensagens WebSocket capturadas`);
    console.log(`💾 Salvas em: ${outputPath}`);
    
    // Resumo
    const sent = capturedMessages.filter(m => m.type === 'sent');
    const received = capturedMessages.filter(m => m.type === 'received');
    
    console.log(`\n📊 Resumo:`);
    console.log(`   Enviadas: ${sent.length}`);
    console.log(`   Recebidas: ${received.length}`);
    
    if (sent.length > 0) {
      console.log(`\n📤 Mensagens enviadas (possíveis mensagens do usuário):`);
      for (const msg of sent) {
        console.log(`   [${msg.timestamp}] ${msg.size} bytes`);
        console.log(`   Data: ${msg.data.substring(0, 200)}...`);
        console.log();
      }
    }
    
  } finally {
    browser.disconnect();
  }
}

interceptWebSocket().catch(console.error);
