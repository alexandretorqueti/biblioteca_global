/**
 * WebSocketChecker - Verifica WebSockets ativos na página do Gemini
 */

import puppeteer from 'puppeteer';

async function checkWebSockets() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

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
    
    // Verificar WebSockets ativos via JavaScript
    const wsInfo = await geminiPage.evaluate(() => {
      // Tentar acessar performance entries
      const entries = performance.getEntriesByType('resource') as any[];
      const wsEntries = entries.filter(e => 
        e.initiatorType === 'websocket' || 
        e.name.includes('ws://') || 
        e.name.includes('wss://')
      );
      
      return {
        url: window.location.href,
        wsEntries: wsEntries.map(e => ({ name: e.name, duration: e.duration })),
        hasWebSocket: typeof WebSocket !== 'undefined'
      };
    });
    
    console.log('📊 Informações da página:');
    console.log(JSON.stringify(wsInfo, null, 2));
    
    // Verificar se há WebSockets no CDP
    const client = await geminiPage.createCDPSession();
    await client.send('Network.enable');
    
    // Aguardar um pouco para ver se há WebSockets
    console.log('\n⏳ Aguardando 5 segundos para detectar WebSockets...\n');
    
    const wsUrls: string[] = [];
    
    client.on('Network.webSocketCreated', (params) => {
      wsUrls.push(params.url);
      console.log(`🔗 WebSocket detectado: ${params.url}`);
    });
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (wsUrls.length === 0) {
      console.log('⚠️ Nenhum WebSocket detectado em 5 segundos');
      console.log('💡 O Gemini pode não estar usando WebSocket, ou a conexão já foi estabelecida antes do interceptor iniciar');
    } else {
      console.log(`\n✅ ${wsUrls.length} WebSocket(s) detectado(s)`);
    }
    
  } finally {
    browser.disconnect();
  }
}

checkWebSockets().catch(console.error);
