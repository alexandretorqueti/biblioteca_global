/**
 * OpenPages - Abre as páginas das IAs no Chrome via CDP
 */

import puppeteer from 'puppeteer';

async function openPages() {
  console.log('🔌 Conectando ao Chrome (porta 9222)...\n');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  try {
    console.log('📑 Abrindo páginas das IAs...\n');

    // Abrir ChatGPT
    console.log('🌐 Abrindo ChatGPT...');
    const gptPage = await browser.newPage();
    await gptPage.goto('https://chat.openai.com/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    console.log('✅ ChatGPT aberto\n');

    // Abrir Claude
    console.log('🌐 Abrindo Claude...');
    const claudePage = await browser.newPage();
    await claudePage.goto('https://claude.ai/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    console.log('✅ Claude aberto\n');

    // Listar todas as páginas
    const pages = await browser.pages();
    console.log(`📋 ${pages.length} páginas abertas:`);
    for (const page of pages) {
      const url = page.url();
      const title = await page.title();
      console.log(`   - ${title}: ${url}`);
    }

    console.log('\n✅ Páginas abertas com sucesso!');
    console.log('💡 Aguarde 10 segundos para as páginas carregarem completamente...');
    
  } finally {
    browser.disconnect();
  }
}

openPages().catch(console.error);
