/**
 * BrowserManager — gerencia a abertura e fechamento do Chrome/Chromium
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { WebAIRunnerConfig } from './types.js';

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private config: Required<WebAIRunnerConfig>) {}

  /**
   * Abre o Chrome em modo debug
   * Usa perfil persistente para manter login entre restarts
   */
  async launch(): Promise<Page> {
    console.log('🌐 Abrindo Chrome em modo debug...');
    console.log(`   Perfil: ${this.config.userDataDir}`);
    console.log(`   Headless: ${this.config.headless}`);
    console.log(`   Executable: /usr/bin/chromium`);
    console.log(`   DISPLAY: ${process.env.DISPLAY || 'não definido'}`);
    
    try {
      this.browser = await puppeteer.launch({
        headless: this.config.headless,
        executablePath: '/usr/bin/chromium', // Usa Chromium do sistema (instalado no Dockerfile)
        args: [
          `--remote-debugging-port=${this.config.debugPort}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          // Otimizações para rodar em container
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        userDataDir: this.config.userDataDir,
        protocolTimeout: 600_000, // 10 minutos
        dumpio: true, // Log stdout/stderr do Chrome
      });
      
      // Pega a primeira aba
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      
      // Configura viewport
      await this.page.setViewport({ width: 1920, height: 1080 });
      
      console.log('✅ Chrome aberto com sucesso');
      
      return this.page;
    } catch (error) {
      console.error('❌ Erro ao abrir Chrome:', error);
      throw error;
    }
  }

  /**
   * Fecha o Chrome e limpa recursos
   */
  async close(): Promise<void> {
    if (this.browser) {
      console.log('🔒 Fechando Chrome...');
      await this.browser.close();
      this.browser = null;
      this.page = null;
      console.log('✅ Chrome fechado');
    }
  }

  /**
   * Retorna a página atual
   */
  getPage(): Page | null {
    return this.page;
  }
}
