/**
 * TokenChainAnalysis - Verifica se tokens vêm da resposta anterior
 * Envia 3 mensagens e analisa cadeia: response[N] → request[N+1]
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedExchange {
  requestBody: string;
  responseBody: string;
  timestamp: number;
  template: any[];
  at: string;
}

async function tokenChainAnalysis() {
  console.log('🔌 Conectando ao Chrome...\n');

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
    
    // Hookar XHR para capturar request + response
    console.log('🔧 Hookando XMLHttpRequest (request + response)...');
    await geminiPage.evaluate(() => {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      
      (window as any).__exchanges = [];
      
      XMLHttpRequest.prototype.open = function(method: string, url: string, ...rest: any[]) {
        (this as any).__url = url;
        (this as any).__method = method;
        return origOpen.apply(this, [method, url, ...rest] as any);
      };
      
      XMLHttpRequest.prototype.send = function(body: any) {
        const url = (this as any).__url || '';
        if (url.includes('StreamGenerate') || url.includes('BardFrontendService')) {
          const xhr = this;
          const exchange: any = {
            requestBody: typeof body === 'string' ? body : '',
            timestamp: Date.now(),
            url: url,
          };
          
          xhr.addEventListener('load', () => {
            exchange.responseBody = xhr.responseText || '';
            exchange.responseStatus = xhr.status;
            (window as any).__exchanges.push(exchange);
          });
        }
        return origSend.apply(this, [body] as any);
      };
    });
    console.log('✅ XHR hookado (request + response)\n');
    
    // Enviar 3 mensagens
    const messages = ['Responda UM', 'Responda DOIS', 'Responda TRES'];
    
    for (let i = 0; i < messages.length; i++) {
      console.log(`💬 Mensagem ${i + 1}: "${messages[i]}"`);
      await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
      await geminiPage.click('.ql-editor, [contenteditable="true"]');
      await geminiPage.keyboard.type(messages[i], { delay: 20 });
      await geminiPage.keyboard.press('Enter');
      
      console.log('⏳ Aguardando 20s...');
      await new Promise(resolve => setTimeout(resolve, 20000));
      
      const exchanges = await geminiPage.evaluate(() => (window as any).__exchanges || []);
      console.log(`   Exchanges capturados: ${exchanges.length}\n`);
    }
    
    // Analisar exchanges
    const exchanges = await geminiPage.evaluate(() => (window as any).__exchanges || []);
    console.log(`\n📊 Total de exchanges: ${exchanges.length}\n`);
    
    // Parsear cada exchange
    const parsed: CapturedExchange[] = [];
    
    for (let i = 0; i < exchanges.length; i++) {
      const ex = exchanges[i];
      const params = new URLSearchParams(ex.requestBody);
      const fReqStr = params.get('f.req');
      if (!fReqStr) continue;
      
      const fReq = JSON.parse(fReqStr);
      const template = JSON.parse(fReq[1]);
      
      parsed.push({
        requestBody: ex.requestBody,
        responseBody: ex.responseBody,
        timestamp: ex.timestamp,
        template,
        at: params.get('at') || '',
      });
      
      console.log(`Exchange ${i}:`);
      console.log(`   template[3] (${String(template[3]).length} chars): ${String(template[3]).substring(0, 60)}...`);
      console.log(`   template[4]: ${template[4]}`);
      console.log(`   template[2][9]: ${String(template[2][9]).substring(0, 40)}...`);
      console.log(`   at: ${params.get('at')?.substring(0, 40)}...`);
      console.log(`   response length: ${ex.responseBody?.length || 0}`);
      console.log();
    }
    
    // Análise de cadeia: tokens da response[N] estão no request[N+1]?
    console.log('🔬 ANÁLISE DE CADEIA:');
    
    for (let i = 0; i < parsed.length - 1; i++) {
      const curr = parsed[i];
      const next = parsed[i + 1];
      
      const currTok3 = String(curr.template[3]);
      const currTok4 = String(curr.template[4]);
      const nextTok3 = String(next.template[3]);
      const nextTok4 = String(next.template[4]);
      
      // Verificar se tokens do request atual aparecem na resposta
      const respContainsTok3 = curr.responseBody?.includes(currTok3.substring(10, 40));
      const respContainsTok4 = curr.responseBody?.includes(currTok4);
      
      console.log(`\nExchange ${i} → ${i + 1}:`);
      console.log(`   Response[${i}] contém tok3 de Request[${i}]: ${respContainsTok3}`);
      console.log(`   Response[${i}] contém tok4 de Request[${i}]: ${respContainsTok4}`);
      
      // Verificar se partes dos tokens são reutilizadas
      const commonPrefix3 = getCommonPrefix(currTok3, nextTok3);
      console.log(`   template[3] prefixo comum entre req[${i}] e req[${i+1}]: ${commonPrefix3} chars`);
      
      // Procurar substrings do próximo token na resposta anterior
      if (curr.responseBody) {
        const nextTok3Fragment = nextTok3.substring(10, 50);
        const respHasFragment = curr.responseBody.includes(nextTok3Fragment);
        console.log(`   Response[${i}] contém fragmento de template[3] do Request[${i+1}]: ${respHasFragment}`);
      }
    }
    
    // Salvar tudo para análise
    fs.writeFileSync('/tmp/chain-analysis.json', JSON.stringify({
      exchanges: parsed.map(p => ({
        template: p.template,
        at: p.at,
        responseLen: p.responseBody?.length,
        responseFirst500: p.responseBody?.substring(0, 500),
      })),
    }, null, 2));
    console.log('\n💾 Análise salva em /tmp/chain-analysis.json');
    
    // Análise adicional: procurar padrões nos hashes
    console.log('\n🔬 ANÁLISE DE HASHES:');
    for (let i = 0; i < parsed.length; i++) {
      const t4 = String(parsed[i].template[4]);
      const msg = parsed[i].template[0][0];
      console.log(`   Exchange ${i}: hash=${t4}, msg="${msg}"`);
      
      // O hash pode ser MD5 de algo relacionado à mensagem
      // Vamos verificar se há relação
    }
    
  } finally {
    browser.disconnect();
  }
}

function getCommonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

tokenChainAnalysis().catch(console.error);
