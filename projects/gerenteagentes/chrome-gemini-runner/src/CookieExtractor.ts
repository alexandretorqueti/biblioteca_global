/**
 * CookieExtractor - Extrai cookies do Chrome via DevTools Protocol
 */

import puppeteer from 'puppeteer';

export class CookieExtractor {
  /**
   * Extrai cookies de um domínio específico via Puppeteer
   */
  static async extractCookies(
    userDataDir: string,
    url: string,
    domains: string[] = []
  ): Promise<Record<string, string>> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      userDataDir,
    });

    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2' });

      // Extrair todos os cookies
      const cookies = await page.cookies();

      // Filtrar por domínio se especificado
      const filteredCookies = domains.length > 0
        ? cookies.filter(c => domains.some(d => c.domain.includes(d)))
        : cookies;

      // Converter para formato name=value
      const cookieMap: Record<string, string> = {};
      for (const cookie of filteredCookies) {
        cookieMap[cookie.name] = cookie.value;
      }

      console.log(`✅ ${filteredCookies.length} cookies extraídos`);
      return cookieMap;

    } finally {
      await browser.close();
    }
  }

  /**
   * Extrai cookies e formata como header HTTP
   */
  static async getCookiesAsHeader(
    userDataDir: string,
    url: string,
    domains: string[] = []
  ): Promise<string> {
    const cookies = await this.extractCookies(userDataDir, url, domains);
    
    const cookieString = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    return cookieString;
  }

  /**
   * Extrai auth token específico do Gemini (SNlM0e)
   */
  static async extractGeminiAuthToken(
    userDataDir: string
  ): Promise<string | null> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      userDataDir,
    });

    try {
      const page = await browser.newPage();
      await page.goto('https://gemini.google.com/', { waitUntil: 'networkidle2' });

      // Extrair auth token da página
      const authToken = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || '';
          // Procurar por SNlM0e (auth token do Gemini)
          const match = content.match(/"SNlM0e":"([^"]+)"/);
          if (match) return match[1];
        }
        return null;
      });

      console.log(`✅ Auth token extraído: ${authToken ? 'sim' : 'não'}`);
      return authToken;

    } finally {
      await browser.close();
    }
  }

  /**
   * Extrai conversation_id e response_id do Gemini
   */
  static async extractGeminiConversationIds(
    userDataDir: string
  ): Promise<{ conversationId: string; responseId: string } | null> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      userDataDir,
    });

    try {
      const page = await browser.newPage();
      await page.goto('https://gemini.google.com/', { waitUntil: 'networkidle2' });

      // Extrair IDs da página
      const ids = await page.evaluate(() => {
        // Procurar no window.__DATA__ ou similar
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || '';
          // Procurar por conversation_id
          const convMatch = content.match(/"conversation_id":"([^"]+)"/);
          const respMatch = content.match(/"response_id":"([^"]+)"/);
          if (convMatch && respMatch) {
            return {
              conversationId: convMatch[1],
              responseId: respMatch[1],
            };
          }
        }
        return null;
      });

      console.log(`✅ Conversation IDs extraídos: ${ids ? 'sim' : 'não'}`);
      return ids;

    } finally {
      await browser.close();
    }
  }
}

// CLI para teste
if (import.meta.url === `file://${process.argv[1]}`) {
  const userDataDir = '/tmp/webai-chrome-profile';
  
  console.log('🔍 Extraindo cookies do Gemini...\n');
  
  CookieExtractor.getCookiesAsHeader(
    userDataDir,
    'https://gemini.google.com/',
    ['google.com']
  ).then(cookies => {
    console.log('\n📋 Cookies (primeiros 200 chars):');
    console.log(cookies.substring(0, 200) + '...');
    
    console.log('\n🔑 Extraindo auth token...');
    return CookieExtractor.extractGeminiAuthToken(userDataDir);
  }).then(authToken => {
    if (authToken) {
      console.log('✅ Auth token:', authToken.substring(0, 50) + '...');
    }
    
    console.log('\n💬 Extraindo conversation IDs...');
    return CookieExtractor.extractGeminiConversationIds(userDataDir);
  }).then(ids => {
    if (ids) {
      console.log('✅ Conversation ID:', ids.conversationId);
      console.log('✅ Response ID:', ids.responseId);
    }
  }).catch(err => {
    console.error('❌ Erro:', err);
  });
}
