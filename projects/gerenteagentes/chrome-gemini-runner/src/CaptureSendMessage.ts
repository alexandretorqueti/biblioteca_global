/**
 * CaptureSendMessage - Envia uma mensagem programaticamente e captura a requisição COMPLETA
 * Não precisa de interação do usuário via VNC
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface FullRequest {
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
}

async function captureSendMessage() {
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

    console.log('📌 Página do Gemini encontrada');
    console.log(`🌐 URL: ${geminiPage.url()}\n`);

    const capturedRequests: FullRequest[] = [];
    const pendingRequests = new Map<string, FullRequest>();
    
    const client = await geminiPage.createCDPSession();
    await client.send('Network.enable');
    
    // Capturar requisições - foco no endpoint de envio de mensagem
    client.on('Network.requestWillBeSent', (params) => {
      const url = params.request.url;
      
      // Capturar requisições para BardChatUi/assistant.lamda (endpoint de mensagem)
      if (url.includes('assistant.lamda') || url.includes('StreamGenerate')) {
        console.log(`\n📡 [${new Date().toISOString()}] Requisição de mensagem capturada!`);
        console.log(`   URL: ${url}`);
        console.log(`   Method: ${params.request.method}`);
        
        const req: FullRequest = {
          timestamp: new Date().toISOString(),
          url: url,
          method: params.request.method,
          headers: params.request.headers,
          postData: params.request.postData || '',
        };
        
        capturedRequests.push(req);
        pendingRequests.set(params.requestId, req);
        
        console.log(`   PostData size: ${req.postData.length} bytes`);
      }
    });
    
    // Capturar respostas
    client.on('Network.responseReceived', async (params) => {
      const pending = pendingRequests.get(params.requestId);
      if (pending) {
        console.log(`\n📥 Response recebida: ${params.response.status}`);
        pending.response = {
          status: params.response.status,
          headers: params.response.headers,
          body: '',
        };
      }
    });
    
    // Capturar chunks de dados (SSE)
    client.on('Network.dataReceived', async (params) => {
      // dataReceived não tem body, usamos getResponseBody depois
    });
    
    // Capturar fim do carregamento para pegar o body completo
    client.on('Network.loadingFinished', async (params) => {
      const pending = pendingRequests.get(params.requestId);
      if (pending && pending.response) {
        try {
          const { body, base64Encoded } = await client.send('Network.getResponseBody', {
            requestId: params.requestId,
          });
          pending.response.body = base64Encoded 
            ? Buffer.from(body, 'base64').toString('utf-8')
            : body;
          console.log(`   Response body capturado: ${pending.response.body.length} bytes`);
        } catch (err) {
          console.log('   ⚠️ Não foi possível capturar response body');
        }
      }
    });
    
    // Agora enviar uma mensagem programaticamente
    console.log('\n💬 Enviando mensagem programaticamente...');
    
    // Trazer a página para frente
    await geminiPage.bringToFront();
    
    // Esperar o editor
    const editorSelector = '.ql-editor, [contenteditable="true"], rich-textarea';
    await geminiPage.waitForSelector(editorSelector, { timeout: 30000 });
    
    // Digitar a mensagem
    const testMessage = 'Responda apenas com a palavra OK';
    console.log(`   Mensagem: "${testMessage}"`);
    
    await geminiPage.click(editorSelector);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await geminiPage.keyboard.type(testMessage, { delay: 30 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('   Pressionando Enter...');
    await geminiPage.keyboard.press('Enter');
    
    // Aguardar captura da resposta
    console.log('\n⏳ Aguardando resposta (45 segundos)...');
    await new Promise(resolve => setTimeout(resolve, 45000));
    
    // Salvar resultados
    if (capturedRequests.length > 0) {
      const outputPath = '/tmp/gemini-full-request.json';
      fs.writeFileSync(outputPath, JSON.stringify(capturedRequests, null, 2));
      
      console.log(`\n\n✅ ${capturedRequests.length} requisição(ões) capturada(s)!`);
      console.log(`💾 Salvo em: ${outputPath}`);
      
      // Mostrar resumo
      for (const req of capturedRequests) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`URL: ${req.url}`);
        console.log(`Method: ${req.method}`);
        console.log(`Headers: ${Object.keys(req.headers).length}`);
        console.log(`PostData: ${req.postData.length} bytes`);
        if (req.response) {
          console.log(`Response: ${req.response.status}, body: ${req.response.body.length} bytes`);
        }
      }
    } else {
      console.log('\n❌ Nenhuma requisição de mensagem capturada');
      console.log('💡 Verifique se a mensagem foi enviada no Gemini');
    }
    
  } finally {
    browser.disconnect();
  }
}

captureSendMessage().catch(console.error);
