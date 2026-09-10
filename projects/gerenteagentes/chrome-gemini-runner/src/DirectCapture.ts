/**
 * DirectCapture - Abre Gemini em nova aba, faz pergunta e captura requisição
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  response?: {
    status: number;
    body?: string;
  };
}

async function directCapture() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  try {
    console.log('📑 Abrindo nova aba do Gemini...\n');
    
    const page = await browser.newPage();
    
    // Habilitar interceptação de rede
    await page.setRequestInterception(true);
    
    const capturedRequests: CapturedRequest[] = [];
    
    // Interceptar requisições
    page.on('request', (request) => {
      const url = request.url();
      
      if (url.includes('batchexecute')) {
        console.log(`\n📡 Requisição capturada:`);
        console.log(`   URL: ${url.substring(0, 100)}...`);
        console.log(`   Method: ${request.method()}`);
        
        const captured: CapturedRequest = {
          url: url,
          method: request.method(),
          headers: request.headers(),
          postData: request.postData(),
        };
        
        capturedRequests.push(captured);
        
        if (request.postData()) {
          console.log(`   PostData: ${request.postData()?.substring(0, 200)}...`);
        }
      }
      
      // Continuar com a requisição
      request.continue();
    });
    
    // Interceptar responses
    page.on('response', async (response) => {
      const url = response.url();
      
      if (url.includes('batchexecute')) {
        console.log(`\n📥 Response capturada:`);
        console.log(`   URL: ${url.substring(0, 100)}...`);
        console.log(`   Status: ${response.status()}`);
        
        const captured = capturedRequests.find(r => r.url === url);
        if (captured) {
          captured.response = {
            status: response.status(),
          };
          
          try {
            const body = await response.text();
            captured.response.body = body;
            console.log(`   Body: ${body.length} bytes`);
            if (body.length < 500) {
              console.log(`   Body content: ${body}`);
            }
          } catch (err) {
            console.log('   Body: não disponível');
          }
        }
      }
    });
    
    // Navegar para Gemini
    console.log('🌐 Navegando para Gemini...');
    await page.goto('https://gemini.google.com/app', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    
    console.log('✅ Gemini carregado\n');
    
    // Aguardar um pouco para a página carregar completamente
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Fazer uma pergunta
    console.log('💬 Fazendo pergunta...');
    
    // Encontrar o editor de texto
    const editor = await page.waitForSelector('[contenteditable="true"]', {
      timeout: 30000,
    });
    
    if (editor) {
      await editor.click();
      await page.keyboard.type('qual é a capital do Brasil?', { delay: 50 });
      await page.keyboard.press('Enter');
      
      console.log('✅ Pergunta enviada\n');
      console.log('⏳ Aguardando resposta (30 segundos)...\n');
      
      // Aguardar a resposta
      await new Promise(resolve => setTimeout(resolve, 30000));
    } else {
      console.log('❌ Editor não encontrado');
    }
    
    // Salvar resultados
    if (capturedRequests.length > 0) {
      const outputPath = '/tmp/webai-direct-capture.json';
      fs.writeFileSync(outputPath, JSON.stringify(capturedRequests, null, 2));
      
      console.log(`\n✅ ${capturedRequests.length} requisições capturadas`);
      console.log(`💾 Salvas em: ${outputPath}`);
      
      // Mostrar resumo
      for (const req of capturedRequests) {
        console.log(`\n📋 Requisição:`);
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
    
    // Fechar a aba
    await page.close();
    
  } finally {
    browser.disconnect();
  }
}

directCapture().catch(console.error);
