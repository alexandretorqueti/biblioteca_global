/**
 * InterceptPayloadBuilder v2 - Hooka fetch na página atual (sem reload)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function interceptPayloadBuilder() {
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
    
    // Injetar hook diretamente na página atual (sem reload)
    console.log('🔧 Injetando hook no fetch...');
    await geminiPage.evaluate(() => {
      const originalFetch = window.fetch;
      
      (window as any).__interceptedPayloads = [];
      
      (window as any).fetch = async function(...args: any[]) {
        const [url, options] = args;
        
        if (typeof url === 'string' && url.includes('StreamGenerate') && options?.body) {
          const bodyStr = typeof options.body === 'string' ? options.body : options.body.toString();
          const params = new URLSearchParams(bodyStr);
          const fReq = params.get('f.req');
          
          if (fReq) {
            const stack = new Error().stack;
            
            (window as any).__interceptedPayloads.push({
              fReq,
              at: params.get('at'),
              timestamp: Date.now(),
              stack: stack,
            });
          }
        }
        
        return originalFetch.apply(this, args as any);
      };
      
      console.log('[HOOK] Fetch hookado com sucesso');
    });
    console.log('✅ Hook injetado (sem reload)\n');
    
    // Enviar mensagem e capturar
    console.log('💬 Enviando mensagem...');
    await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Teste hook', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 25s para captura...');
    await new Promise(resolve => setTimeout(resolve, 25000));
    
    // Recuperar payloads interceptados
    const intercepted = await geminiPage.evaluate(() => {
      return (window as any).__interceptedPayloads || [];
    });
    
    console.log(`\n📊 Payloads interceptados: ${intercepted.length}`);
    
    if (intercepted.length > 0) {
      const payload = intercepted[0];
      console.log(`   f.req length: ${payload.fReq.length}`);
      console.log(`   at: ${payload.at?.substring(0, 40)}...`);
      console.log(`   timestamp: ${payload.timestamp}`);
      
      // Salvar stack trace
      if (payload.stack) {
        fs.writeFileSync('/tmp/stack-trace.txt', payload.stack);
        console.log(`\n🔬 Stack trace salvo em /tmp/stack-trace.txt`);
        
        // Mostrar linhas relevantes
        const lines = payload.stack.split('\n');
        console.log('\n🔬 Stack trace (linhas relevantes):');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes('gemini') || line.includes('bard') || line.includes('boq') || line.includes('StreamGenerate')) {
            console.log(`   [${i}] ${line.trim().substring(0, 120)}`);
          }
        }
      }
      
      fs.writeFileSync('/tmp/intercepted-payload.json', JSON.stringify(payload, null, 2));
      console.log('\n💾 Payload salvo em /tmp/intercepted-payload.json');
    } else {
      console.log('❌ Nenhum payload interceptado');
    }
    
    // Procurar variáveis com tokens longos (!...)
    console.log('\n🔍 Procurando variáveis com tokens longos (!...)...');
    const tokenVars = await geminiPage.evaluate(() => {
      const results: { key: string; len: number; preview: string }[] = [];
      
      // Procurar em window
      for (const key of Object.keys(window)) {
        try {
          const val = (window as any)[key];
          if (typeof val === 'string' && val.startsWith('!') && val.length > 100) {
            results.push({ key, len: val.length, preview: val.substring(0, 80) });
          }
        } catch {}
      }
      
      // Procurar em WIZ_global_data
      const wiz = (window as any).WIZ_global_data;
      if (wiz) {
        for (const [k, v] of Object.entries(wiz)) {
          if (typeof v === 'string' && (v as string).startsWith('!') && (v as string).length > 100) {
            results.push({ key: `WIZ.${k}`, len: (v as string).length, preview: (v as string).substring(0, 80) });
          }
        }
      }
      
      return results;
    });
    
    console.log(`   Encontradas: ${tokenVars.length}`);
    tokenVars.forEach((v: any) => {
      console.log(`   ${v.key} (${v.len} chars): ${v.preview}...`);
    });
    
  } finally {
    browser.disconnect();
  }
}

interceptPayloadBuilder().catch(console.error);
