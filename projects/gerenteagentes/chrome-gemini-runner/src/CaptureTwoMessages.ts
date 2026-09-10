/**
 * CaptureTwoMessages - Envia 2 mensagens via browser e compara os tokens do payload
 * Objetivo: descobrir se template[3] (token longo) muda por requisição
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function captureTwoMessages() {
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

    const capturedPostDatas: string[] = [];
    const client = await geminiPage.createCDPSession();
    await client.send('Network.enable');
    
    client.on('Network.requestWillBeSent', (params) => {
      if (params.request.url.includes('StreamGenerate') && params.request.postData) {
        console.log(`📡 StreamGenerate capturada (${capturedPostDatas.length + 1})`);
        capturedPostDatas.push(params.request.postData);
      }
    });
    
    await geminiPage.bringToFront();
    
    // Mensagem 1
    console.log('\n💬 Enviando mensagem 1...');
    await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Responda apenas: UM', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 25s...');
    await new Promise(resolve => setTimeout(resolve, 25000));
    
    // Mensagem 2
    console.log('\n💬 Enviando mensagem 2...');
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Responda apenas: DOIS', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 25s...');
    await new Promise(resolve => setTimeout(resolve, 25000));
    
    // Comparar tokens
    console.log(`\n✅ ${capturedPostDatas.length} requisições capturadas\n`);
    
    if (capturedPostDatas.length >= 2) {
      const templates = capturedPostDatas.map(pd => {
        const params = new URLSearchParams(pd);
        const fReq = JSON.parse(params.get('f.req') || '[]');
        return {
          template: JSON.parse(fReq[1]),
          at: params.get('at'),
        };
      });
      
      const t1 = templates[0];
      const t2 = templates[1];
      
      console.log('🔬 COMPARAÇÃO:');
      console.log(`   Mensagem 1: ${t1.template[0][0]}`);
      console.log(`   Mensagem 2: ${t2.template[0][0]}`);
      console.log();
      console.log(`   at token 1: ${String(t1.at).substring(0, 40)}...`);
      console.log(`   at token 2: ${String(t2.at).substring(0, 40)}...`);
      console.log(`   at iguais: ${t1.at === t2.at}`);
      console.log();
      
      // template[2] IDs
      console.log(`   IDs 1: ${JSON.stringify(t1.template[2].slice(0, 3))}`);
      console.log(`   IDs 2: ${JSON.stringify(t2.template[2].slice(0, 3))}`);
      console.log(`   sessionToken[2][9] iguais: ${t1.template[2][9] === t2.template[2][9]}`);
      console.log();
      
      // template[3] - token longo
      const tok1 = String(t1.template[3]);
      const tok2 = String(t2.template[3]);
      console.log(`   template[3] len 1: ${tok1.length}`);
      console.log(`   template[3] len 2: ${tok2.length}`);
      console.log(`   template[3] IGUAIS: ${tok1 === tok2}  ← CRÍTICO`);
      console.log(`   template[3][0:60] 1: ${tok1.substring(0, 60)}`);
      console.log(`   template[3][0:60] 2: ${tok2.substring(0, 60)}`);
      console.log();
      
      // template[4] - hash
      console.log(`   template[4] 1: ${t1.template[4]}`);
      console.log(`   template[4] 2: ${t2.template[4]}`);
      console.log(`   template[4] IGUAIS: ${t1.template[4] === t2.template[4]}`);
      
      // Salvar ambos para referência
      fs.writeFileSync('/tmp/two-templates.json', JSON.stringify({
        req1: { message: t1.template[0][0], at: t1.at, template: t1.template },
        req2: { message: t2.template[0][0], at: t2.at, template: t2.template },
      }, null, 2));
      console.log('\n💾 Templates salvos em /tmp/two-templates.json');
    }
    
  } finally {
    browser.disconnect();
  }
}

captureTwoMessages().catch(console.error);
