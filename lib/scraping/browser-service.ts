/**
 * Browser Service
 * Manages browser instances for web scraping
 * Uses singleton pattern to reuse browser instances
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';

class BrowserService {
  private static instance: BrowserService | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map();
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  /**
   * Get or create browser instance
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // If already initializing, wait for it
    if (this.isInitializing && this.initPromise) {
      await this.initPromise;
      if (this.browser && this.browser.isConnected()) {
        return this.browser;
      }
    }

    // Start initialization
    this.isInitializing = true;
    this.initPromise = this.initializeBrowser();

    try {
      await this.initPromise;
      if (this.browser && this.browser.isConnected()) {
        return this.browser;
      }
      throw new Error('Failed to initialize browser');
    } finally {
      this.isInitializing = false;
      this.initPromise = null;
    }
  }

  private async initializeBrowser(): Promise<void> {
    try {
      console.log('[BrowserService] Initializing browser...');
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      console.log('[BrowserService] Browser initialized successfully');
    } catch (error: any) {
      console.error('[BrowserService] Failed to initialize browser:', error.message);
      
      // Check if error is due to missing browser binaries
      if (error.message && (error.message.includes('Executable doesn\'t exist') || error.message.includes('browserType.launch'))) {
        const installError = new Error(
          'Playwright browser binaries are not installed. Please run: npx playwright install chromium\n' +
          'Or for all browsers: npx playwright install'
        );
        installError.name = 'BrowserNotInstalledError';
        this.browser = null;
        this.context = null;
        throw installError;
      }
      
      this.browser = null;
      this.context = null;
      throw error;
    }
  }

  /**
   * Get or create a page for a specific URL
   * Reuses existing page if available
   */
  async getPage(url: string): Promise<Page> {
    const browser = await this.getBrowser();
    
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    // Check if we have a page for this URL
    if (this.pages.has(url)) {
      const page = this.pages.get(url)!;
      if (!page.isClosed()) {
        return page;
      }
      // Page was closed, remove it
      this.pages.delete(url);
    }

    // Create new page
    const page = await this.context.newPage();
    this.pages.set(url, page);
    return page;
  }

  /**
   * Get a fresh page with cleared session data
   * Useful for registration where each address needs a clean session
   */
  async getFreshPage(): Promise<Page> {
    const browser = await this.getBrowser();
    
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    // Clear all cookies from context first
    try {
      await this.context.clearCookies();
    } catch (e) {
      // Ignore errors
    }

    // Create a new page
    const page = await this.context.newPage();
    
    // Clear localStorage and sessionStorage via JavaScript after page loads
    page.addInitScript(() => {
      // This runs before page scripts, clearing storage early
      if (typeof Storage !== 'undefined') {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (e) {
          // Ignore
        }
      }
    });
    
    return page;
  }

  /**
   * Navigate to URL and wait for load
   * @param freshSession - If true, creates a fresh page with cleared session data
   */
  async navigateTo(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle', timeout?: number, freshSession?: boolean }): Promise<Page> {
    const browser = await this.getBrowser();
    
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    // If fresh session is requested, always create a new page
    if (options?.freshSession) {
      const page = await this.getFreshPage();
      
      try {
        // Check if browser/context is still valid
        if (!browser.isConnected() || !page) {
          throw new Error('Browser or page has been closed');
        }

        await page.goto(url, {
          waitUntil: options?.waitUntil || 'networkidle',
          timeout: options?.timeout || 60000,
        });
        
        // Clear cookies and storage again after navigation to ensure clean state
        try {
          await this.context.clearCookies();
          await page.evaluate(() => {
            try {
              localStorage.clear();
              sessionStorage.clear();
            } catch (e) {
              // Ignore
            }
          });
        } catch (e) {
          // Ignore errors - page should still be usable
        }
        
        return page;
      } catch (error: any) {
        if (!page.isClosed()) {
          try {
            await page.close();
          } catch (e) {
            // Ignore
          }
        }
        throw error;
      }
    }

    // Check if we have a page for this URL
    let page: Page | null = null;
    if (this.pages.has(url)) {
      page = this.pages.get(url)!;
      if (page.isClosed()) {
        // Page was closed, remove it and create new one
        this.pages.delete(url);
        page = null;
      }
    }

    // Create new page if needed
    if (!page) {
      page = await this.context.newPage();
      this.pages.set(url, page);
    }
    
    try {
      // Check if browser/context is still valid
      if (!browser.isConnected() || !page) {
        throw new Error('Browser or page has been closed');
      }

      await page.goto(url, {
        waitUntil: options?.waitUntil || 'networkidle',
        timeout: options?.timeout || 60000,
      });
      return page;
    } catch (error: any) {
      // Handle ERR_ABORTED - navigation was interrupted, but page might still be usable
      if (error.message?.includes('ERR_ABORTED') || error.message?.includes('net::ERR_ABORTED')) {
        console.warn(`[BrowserService] Navigation to ${url} was aborted, but page may still be usable`);
        // Wait a bit and check if page is still valid
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (page && !page.isClosed() && browser.isConnected()) {
          try {
            // Check current URL - might have navigated partially
            const currentUrl = page.url();
            if (currentUrl && currentUrl.includes('midnight.gd')) {
              // Page is on the right domain, might be usable
              console.log(`[BrowserService] Page is at ${currentUrl}, continuing...`);
              return page;
            }
          } catch (e) {
            // Page is not usable, continue to create new page
          }
        }
        
        // Page is not usable, create a new one
        if (page && !page.isClosed()) {
          try {
            await page.close();
          } catch (e) {
            // Ignore
          }
        }
        this.pages.delete(url);
        
        // Retry with new page
        try {
          page = await this.context.newPage();
          this.pages.set(url, page);
          await page.goto(url, {
            waitUntil: options?.waitUntil || 'networkidle',
            timeout: options?.timeout || 60000,
          });
          return page;
        } catch (retryError: any) {
          console.error(`[BrowserService] Retry navigation to ${url} failed:`, retryError.message);
          if (page && !page.isClosed()) {
            try {
              await page.close();
            } catch (e) {
              // Ignore
            }
          }
          this.pages.delete(url);
          throw retryError;
        }
      }
      
      // Other errors - close page and throw
      console.error(`[BrowserService] Failed to navigate to ${url}:`, error.message);
      if (page && !page.isClosed()) {
        try {
          await page.close();
        } catch (e) {
          // Ignore
        }
      }
      this.pages.delete(url);
      throw error;
    }
  }

  /**
   * Close a specific page
   */
  async closePage(url: string): Promise<void> {
    if (this.pages.has(url)) {
      const page = this.pages.get(url)!;
      if (!page.isClosed()) {
        await page.close();
      }
      this.pages.delete(url);
    }
  }

  /**
   * Close all pages
   */
  async closeAllPages(): Promise<void> {
    const closePromises = Array.from(this.pages.values()).map(async (page) => {
      if (!page.isClosed()) {
        await page.close();
      }
    });
    await Promise.all(closePromises);
    this.pages.clear();
  }

  /**
   * Close browser and cleanup
   */
  async closeBrowser(): Promise<void> {
    await this.closeAllPages();

    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    console.log('[BrowserService] Browser closed');
  }

  /**
   * Cleanup on process exit
   */
  async cleanup(): Promise<void> {
    await this.closeBrowser();
  }
}

// Export singleton instance
export const browserService = BrowserService.getInstance();

// Handle process exit
process.on('SIGINT', async () => {
  await browserService.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await browserService.cleanup();
  process.exit(0);
});

