/**
 * XHRFullCapture - Captura body COMPLETO do XHR e compara com WIZ_global_data
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function xhrFullCapture() {
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
    
    // Hookar XMLHttpRequest com body COMPLETO
    console.log('🔧 Hookando XMLHttpRequest (body completo)...');
    await geminiPage.evaluate(() => {
      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;
      
      (window as any).__xhrFullCaptures = [];
      
      XMLHttpRequest.prototype.open = function(method: string, url: string, ...rest: any[]) {
        (this as any).__url = url;
        (this as any).__method = method;
        return originalXHROpen.apply(this, [method, url, ...rest] as any);
      };
      
      XMLHttpRequest.prototype.send = function(body: any) {
        const url = (this as any).__url || '';
        if (url.includes('StreamGenerate') || url.includes('BardFrontendService')) {
          const bodyStr = typeof body === 'string' ? body : 'non-string';
          (window as any).__xhrFullCaptures.push({
            url,
            method: (this as any).__method,
            body: bodyStr,  // COMPLETO, sem truncar
            bodyLen: bodyStr.length,
            timestamp: Date.now(),
          });
        }
        return originalXHRSend.apply(this, [body] as any);
      };
    });
    console.log('✅ XHR hookado\n');
    
    // Enviar mensagem
    console.log('💬 Enviando mensagem...');
    await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Responda OK', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 25s...');
    await new Promise(resolve => setTimeout(resolve, 25000));
    
    // Recuperar captura completa
    const captures = await geminiPage.evaluate(() => {
      return (window as any).__xhrFullCaptures || [];
    });
    
    console.log(`\n📊 Capturas: ${captures.length}`);
    
    if (captures.length === 0) {
      console.log('❌ Nenhuma captura');
      return;
    }
    
    const capture = captures[0];
    console.log(`   URL: ${capture.url.substring(0, 100)}...`);
    console.log(`   Body length: ${capture.bodyLen}`);
    
    // Parsear body
    const params = new URLSearchParams(capture.body);
    const fReqStr = params.get('f.req');
    const atToken = params.get('at');
    
    if (!fReqStr) {
      console.log('❌ f.req não encontrado');
      return;
    }
    
    console.log(`   f.req length: ${fReqStr.length}`);
    console.log(`   at token: ${atToken?.substring(0, 40)}...`);
    
    const fReq = JSON.parse(fReqStr);
    const template = JSON.parse(fReq[1]);
    
    // Salvar template completo
    fs.writeFileSync('/tmp/xhr-template.json', JSON.stringify(template, null, 2));
    console.log('\n💾 Template salvo em /tmp/xhr-template.json');
    
    // Extrair tokens dinâmicos
    const tok3 = String(template[3]);
    const tok4 = String(template[4]);
    const tok29 = String(template[2][9]);
    
    console.log('\n🔬 Tokens dinâmicos:');
    console.log(`   template[3] (${tok3.length} chars): ${tok3.substring(0, 80)}...`);
    console.log(`   template[4] (${tok4.length} chars): ${tok4}`);
    console.log(`   template[2][9] (${tok29.length} chars): ${tok29}`);
    
    // Agora procurar esses tokens no WIZ_global_data
    console.log('\n🔍 Procurando tokens no WIZ_global_data...');
    const wizMatch = await geminiPage.evaluate((t3: string, t4: string, t29: string) => {
      const wiz = (window as any).WIZ_global_data;
      if (!wiz) return { found: false };
      
      const results: { key: string; token: string; match: string }[] = [];
      
      for (const [k, v] of Object.entries(wiz)) {
        if (typeof v !== 'string') continue;
        const s = v as string;
        
        // Verificar se algum token está contido nesta string
        if (s.includes(t3.substring(0, 40))) {
          results.push({ key: k, token: 'template[3]', match: 'contém prefixo de template[3]' });
        }
        if (s.includes(t4)) {
          results.push({ key: k, token: 'template[4]', match: 'contém template[4] exato' });
        }
        if (s.includes(t29)) {
          results.push({ key: k, token: 'template[2][9]', match: 'contém template[2][9] exato' });
        }
        
        // Verificar se esta string está contida nos tokens
        if (s.length > 50 && t3.includes(s.substring(0, 50))) {
          results.push({ key: k, token: 'template[3]', match: `WIZ.${k} está contido em template[3]` });
        }
      }
      
      return { found: true, results };
    }, tok3, tok4, tok29);
    
    if (wizMatch.found) {
      console.log(`   Resultados: ${wizMatch.results?.length || 0}`);
      wizMatch.results?.forEach(r => {
        console.log(`   ${r.key}: ${r.token} → ${r.match}`);
      });
    }
    
    // Comparar com o template anterior (capturado via CDP)
    console.log('\n🔬 Comparando com template anterior...');
    try {
      const prevTemplate = JSON.parse(fs.readFileSync('/tmp/captured-template.json', 'utf-8'));
      
      console.log(`   template[3] anterior: ${String(prevTemplate[3]).substring(0, 60)}...`);
      console.log(`   template[3] atual:    ${tok3.substring(0, 60)}...`);
      console.log(`   template[3] iguais: ${String(prevTemplate[3]) === tok3}`);
      console.log();
      console.log(`   template[4] anterior: ${prevTemplate[4]}`);
      console.log(`   template[4] atual:    ${tok4}`);
      console.log(`   template[4] iguais: ${prevTemplate[4] === tok4}`);
      console.log();
      console.log(`   template[2][9] anterior: ${String(prevTemplate[2][9]).substring(0, 40)}...`);
      console.log(`   template[2][9] atual:    ${tok29.substring(0, 40)}...`);
      console.log(`   template[2][9] iguais: ${String(prevTemplate[2][9]) === tok29}`);
      
      // Verificar se partes dos tokens são iguais
      const prev3 = String(prevTemplate[3]);
      const commonPrefix3 = getCommonPrefix(prev3, tok3);
      console.log(`\n   template[3] prefixo comum: ${commonPrefix3} chars`);
      if (commonPrefix3 > 0) {
        console.log(`   Prefixo: ${tok3.substring(0, commonPrefix3 + 10)}...`);
      }
      
      // Verificar se o template[3] atual é uma transformação do anterior
      console.log(`\n   template[3] diff: posição ${findFirstDiff(prev3, tok3)}`);
      console.log(`   template[3] diff: posição ${findFirstDiff(tok3, prev3)}`);
      
    } catch (e) {
      console.log('   Template anterior não encontrado');
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

function findFirstDiff(a: string, b: string): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return i;
  }
  return Math.min(a.length, b.length);
}

xhrFullCapture().catch(console.error);
