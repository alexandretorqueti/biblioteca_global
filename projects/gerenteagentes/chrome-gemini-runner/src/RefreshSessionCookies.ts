/**
 * RefreshSessionCookies - Atualiza os cookies do gemini-session.json
 * Pega os cookies frescos do Chrome em execução (porta 9222)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

async function refreshCookies() {
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
    
    // Extrair cookies frescos
    const cookies = await geminiPage.cookies('https://gemini.google.com');
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    console.log(`🍪 ${cookies.length} cookies extraídos (${cookieHeader.length} bytes)`);
    
    // Atualizar o gemini-session.json
    const sessionPath = '/app/gemini-session.json';
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    
    session.cookies = cookieHeader;
    session.cookiesUpdatedAt = new Date().toISOString();
    
    // Também atualizar o token "at" (SNlM0e) fresco da página
    const freshToken = await geminiPage.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const content = script.textContent || '';
        const match = content.match(/"SNlM0e":"([^"]+)"/);
        if (match) return match[1];
      }
      return null;
    });
    
    if (freshToken) {
      session.at = freshToken;
      session.atUpdatedAt = new Date().toISOString();
      console.log(`🔑 Auth token atualizado: ${freshToken.substring(0, 40)}...`);
    } else {
      console.log(`⚠️ Auth token não encontrado na página (mantendo o capturado)`);
    }
    
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    
    console.log(`\n✅ gemini-session.json atualizado!`);
    console.log(`   Cookies: ${session.cookies.length} bytes`);
    console.log(`   at: ${session.at.substring(0, 40)}...`);
    
  } finally {
    browser.disconnect();
  }
}

refreshCookies().catch(console.error);
