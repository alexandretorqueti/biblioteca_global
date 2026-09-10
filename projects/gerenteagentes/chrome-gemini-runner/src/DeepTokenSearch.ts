/**
 * DeepTokenSearch - Busca profunda pelos tokens no JavaScript da página
 * Analisa WIZ_global_data, scripts inline, e procura padrões
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function deepTokenSearch() {
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
    
    // 1. Análise completa do WIZ_global_data
    console.log('🔬 Analisando WIZ_global_data...');
    const wizData = await geminiPage.evaluate(() => {
      const wiz = (window as any).WIZ_global_data;
      if (!wiz) return { found: false };
      
      const entries: { key: string; type: string; preview: string; len?: number }[] = [];
      
      for (const [k, v] of Object.entries(wiz)) {
        const type = typeof v;
        let preview = '';
        let len: number | undefined;
        
        if (type === 'string') {
          const s = v as string;
          len = s.length;
          preview = s.substring(0, 100);
        } else if (type === 'object' && v !== null) {
          preview = JSON.stringify(v).substring(0, 100);
        } else {
          preview = String(v);
        }
        
        entries.push({ key: k, type, preview, len });
      }
      
      return { found: true, entries };
    });
    
    if (wizData.found && wizData.entries) {
      console.log(`   ${wizData.entries.length} chaves encontradas`);
      
      // Filtrar chaves interessantes
      const interesting = wizData.entries.filter(e => 
        e.type === 'string' && (e.len || 0) > 50
      );
      
      console.log(`   Strings longas (>50 chars): ${interesting.length}`);
      interesting.forEach(e => {
        console.log(`   ${e.key} (${e.len} chars): ${e.preview.substring(0, 60)}...`);
      });
      
      // Procurar especificamente por tokens que começam com !
      const tokens = wizData.entries.filter(e => 
        e.type === 'string' && e.preview.startsWith('!')
      );
      console.log(`\n   Tokens que começam com !: ${tokens.length}`);
      tokens.forEach(e => {
        console.log(`   ${e.key} (${e.len} chars): ${e.preview}...`);
      });
      
      // Salvar WIZ_global_data completo
      fs.writeFileSync('/tmp/wiz-global-data.json', JSON.stringify(wizData, null, 2));
      console.log('\n💾 WIZ_global_data salvo em /tmp/wiz-global-data.json');
    } else {
      console.log('   WIZ_global_data não encontrado');
    }
    
    // 2. Procurar por tokens em todos os scripts inline
    console.log('\n🔬 Procurando tokens em scripts inline...');
    const scriptTokens = await geminiPage.evaluate(() => {
      const results: { src: string; tokens: string[] }[] = [];
      const scripts = Array.from(document.querySelectorAll('script'));
      
      for (const script of scripts) {
        const content = script.textContent || '';
        const src = script.src || '(inline)';
        
        // Procurar strings que começam com ! e têm >100 chars
        const matches: string[] = [];
        const regex = /"(![^"]{100,})"/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          matches.push(match[1].substring(0, 80));
        }
        
        // Também procurar por padrões de hash MD5 (32 chars hex)
        const hashRegex = /"([0-9a-f]{32})"/g;
        const hashes: string[] = [];
        while ((match = hashRegex.exec(content)) !== null) {
          hashes.push(match[1]);
        }
        
        if (matches.length > 0 || hashes.length > 0) {
          results.push({ src, tokens: [...matches.map(m => `!${m}`), ...hashes.map(h => `hash:${h}`)] });
        }
      }
      
      return results;
    });
    
    console.log(`   Scripts com tokens: ${scriptTokens.length}`);
    scriptTokens.forEach(s => {
      console.log(`   ${s.src}:`);
      s.tokens.slice(0, 3).forEach(t => {
        console.log(`      ${t.substring(0, 80)}...`);
      });
    });
    
    // 3. Hookar XMLHttpRequest também
    console.log('\n🔧 Hookando XMLHttpRequest...');
    await geminiPage.evaluate(() => {
      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;
      
      (window as any).__xhrCaptures = [];
      
      XMLHttpRequest.prototype.open = function(method: string, url: string, ...rest: any[]) {
        (this as any).__url = url;
        (this as any).__method = method;
        return originalXHROpen.apply(this, [method, url, ...rest] as any);
      };
      
      XMLHttpRequest.prototype.send = function(body: any) {
        const url = (this as any).__url || '';
        if (url.includes('StreamGenerate') || url.includes('BardFrontendService')) {
          (window as any).__xhrCaptures.push({
            url,
            method: (this as any).__method,
            body: typeof body === 'string' ? body.substring(0, 500) : 'non-string',
            timestamp: Date.now(),
          });
        }
        return originalXHRSend.apply(this, [body] as any);
      };
      
      console.log('[HOOK] XMLHttpRequest hookado');
    });
    
    // 4. Enviar mensagem e capturar
    console.log('\n💬 Enviando mensagem...');
    await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Teste XHR', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 25s...');
    await new Promise(resolve => setTimeout(resolve, 25000));
    
    // Verificar capturas XHR
    const xhrCaptures = await geminiPage.evaluate(() => {
      return (window as any).__xhrCaptures || [];
    });
    
    console.log(`\n📊 Capturas XHR: ${xhrCaptures.length}`);
    xhrCaptures.forEach((c: any, i: number) => {
      console.log(`   [${i}] ${c.method} ${c.url.substring(0, 80)}...`);
      console.log(`       body: ${c.body.substring(0, 100)}...`);
    });
    
    // 5. Verificar se há iframes
    console.log('\n🔍 Procurando iframes...');
    const iframes = await geminiPage.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: f.src,
        id: f.id,
        name: f.name,
      }));
    });
    console.log(`   Iframes: ${iframes.length}`);
    iframes.forEach(f => {
      console.log(`   ${f.id || f.name}: ${f.src.substring(0, 80)}`);
    });
    
  } finally {
    browser.disconnect();
  }
}

deepTokenSearch().catch(console.error);
