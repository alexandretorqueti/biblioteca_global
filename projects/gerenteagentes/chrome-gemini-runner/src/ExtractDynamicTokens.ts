/**
 * ExtractDynamicTokens - Extrai os tokens dinâmicos do JavaScript da página
 * Objetivo: encontrar como template[3], template[4] e template[2][9] são gerados
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function extractDynamicTokens() {
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
    
    // Extrair dados da página (WIZ_global_data, etc.)
    const pageData = await geminiPage.evaluate(() => {
      const data: any = {
        WIZ_global_data: (window as any).WIZ_global_data,
        _hd: (window as any)._hd,
        _F_toggles: (window as any)._F_toggles,
      };
      
      // Procurar por tokens em variáveis globais
      const globalKeys = Object.keys(window);
      const interestingKeys = globalKeys.filter(k => 
        k.includes('token') || k.includes('Token') || 
        k.includes('WIZ') || k.includes('data') ||
        k.startsWith('_')
      );
      
      data.interestingGlobalKeys = interestingKeys;
      
      // Procurar por funções que geram tokens
      const scripts = Array.from(document.querySelectorAll('script'));
      const tokenPatterns: string[] = [];
      
      for (const script of scripts) {
        const content = script.textContent || '';
        
        // Procurar por padrões de geração de tokens
        if (content.includes('!') && content.includes('generateToken')) {
          tokenPatterns.push('generateToken function found');
        }
        
        // Procurar por padrões de hash
        if (content.includes('hash') && content.includes('md5')) {
          tokenPatterns.push('md5 hash found');
        }
        
        // Procurar por padrões de CSRF/anti-abuse
        if (content.includes('CSRF') || content.includes('csrf')) {
          tokenPatterns.push('CSRF pattern found');
        }
      }
      
      data.tokenPatterns = tokenPatterns;
      
      return data;
    });
    
    console.log('🔬 Dados da página:');
    console.log(`   WIZ_global_data: ${pageData.WIZ_global_data ? 'OK' : 'NÃO'}`);
    console.log(`   _hd: ${pageData._hd ? 'OK' : 'NÃO'}`);
    console.log(`   interestingKeys: ${pageData.interestingGlobalKeys.length}`);
    console.log(`   tokenPatterns: ${pageData.tokenPatterns.length}`);
    
    // Salvar dados para análise
    fs.writeFileSync('/tmp/page-data.json', JSON.stringify(pageData, null, 2));
    console.log('\n💾 Dados salvos em /tmp/page-data.json');
    
    // Agora capturar uma requisição e comparar com os dados da página
    console.log('\n📡 Capturando próxima requisição...');
    
    const capturedRequests: string[] = [];
    const client = await geminiPage.createCDPSession();
    await client.send('Network.enable');
    
    client.on('Network.requestWillBeSent', (params) => {
      if (params.request.url.includes('StreamGenerate') && params.request.postData) {
        capturedRequests.push(params.request.postData);
      }
    });
    
    // Enviar mensagem
    await geminiPage.bringToFront();
    await geminiPage.waitForSelector('.ql-editor, [contenteditable="true"]', { timeout: 30000 });
    await geminiPage.click('.ql-editor, [contenteditable="true"]');
    await geminiPage.keyboard.type('Teste', { delay: 20 });
    await geminiPage.keyboard.press('Enter');
    
    console.log('⏳ Aguardando 20s...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    if (capturedRequests.length > 0) {
      const params = new URLSearchParams(capturedRequests[0]);
      const fReq = JSON.parse(params.get('f.req') || '[]');
      const template = JSON.parse(fReq[1]);
      
      console.log('\n🔬 Tokens capturados:');
      console.log(`   template[2][9]: ${String(template[2][9]).substring(0, 60)}...`);
      console.log(`   template[3]: ${String(template[3]).substring(0, 60)}...`);
      console.log(`   template[4]: ${template[4]}`);
      
      // Procurar esses tokens nos dados da página
      const pageDataStr = JSON.stringify(pageData);
      
      const tok29 = String(template[2][9]);
      const tok3 = String(template[3]);
      const tok4 = template[4];
      
      console.log('\n🔍 Procurando tokens na página:');
      console.log(`   template[2][9] na página: ${pageDataStr.includes(tok29)}`);
      console.log(`   template[3] na página: ${pageDataStr.includes(tok3)}`);
      console.log(`   template[4] na página: ${pageDataStr.includes(tok4)}`);
      
      // Salvar template para análise
      fs.writeFileSync('/tmp/captured-template.json', JSON.stringify(template, null, 2));
      console.log('\n💾 Template salvo em /tmp/captured-template.json');
    }
    
  } finally {
    browser.disconnect();
  }
}

extractDynamicTokens().catch(console.error);
