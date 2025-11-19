/**
 * T&C Scraper
 * Scrapes Terms and Conditions message from the website
 * Replaces GET /TandC API call
 */

import { browserService } from './browser-service';

const BASE_URL = 'https://sm.midnight.gd';
let cachedTandCMessage: string | null = null;
let tandcMessageFetched = false;

/**
 * Get T&C message from the website
 * Returns the same format as the API: { message: string }
 */
export async function fetchTandCMessage(): Promise<{ message: string }> {
  // Return cached message if available
  if (cachedTandCMessage && tandcMessageFetched) {
    return { message: cachedTandCMessage };
  }

  try {
    // Navigate to the wizard/wallet page first, then follow the flow to get to t-c page
    // We can't directly navigate to /wizard/t-c - must go through the flow
    const walletUrl = `${BASE_URL}/wizard/wallet`;
    const page = await browserService.navigateTo(walletUrl);

    // Wait for page to load
    await page.waitForTimeout(2000);
    
    // Try to click through to terms page if not already there
    // This simulates the natural flow: wallet → address → terms
    const initialUrl = page.url();
    if (!initialUrl.includes('/wizard/t-c')) {
      // If we're on wallet page, try to get to terms page
      // For T&C extraction, we can try to navigate through the flow
      // or just extract from wherever we can find it
      console.log('[TandCScraper] Not on terms page, attempting to navigate through flow...');
      
      // Try clicking "Enter an address manually" if visible
      try {
        const enterAddressButton = page.locator('text=Enter an address manually').first();
        if (await enterAddressButton.isVisible({ timeout: 3000 })) {
          await enterAddressButton.click();
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        // Continue
      }
      
      // Note: We can't actually enter an address just to get T&C message
      // So we'll extract it from wherever it appears on the page
      // or from JavaScript state
    }
    
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // DEBUG: Log page URL and title for debugging
    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[TandCScraper] Debug: Current URL: ${currentUrl}, Title: ${pageTitle}`);

    // Method 1: Extract T&C message from "Message to be signed" field
    // This is shown on the /wizard/t-c page
    try {
      // Look for label "Message to be signed" or similar
      const messageLabel = await page.locator('text=/Message to be signed/i').first();
      if (await messageLabel.isVisible({ timeout: 5000 })) {
        // Find the associated textarea/input/pre that contains the message
        // Try to find parent container and then the message element
        const parent = await messageLabel.locator('..').first();
        
        // Look for textarea, pre, or input in the same section
        const messageSelectors = [
          'textarea',
          'pre',
          'input[readonly]',
          '[data-testid*="message"]',
        ];
        
        for (const selector of messageSelectors) {
          try {
            const elements = await parent.locator(selector).all();
            for (const element of elements) {
              const text = await element.textContent();
              if (text && text.length > 50) {
                // The message should contain "agree" or "terms"
                if (text.toLowerCase().includes('agree') || text.toLowerCase().includes('terms')) {
                  const message = text.trim();
                  cachedTandCMessage = message;
                  tandcMessageFetched = true;
                  console.log('[TandCScraper] Successfully extracted T&C message from Message to be signed field');
                  return { message };
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // Also try searching in broader context
        const allTextareas = await page.locator('textarea').all();
        for (const textarea of allTextareas) {
          if (await textarea.isVisible({ timeout: 2000 })) {
            const text = await textarea.textContent();
            if (text && text.length > 50 && (
              text.toLowerCase().includes('agree') ||
              text.toLowerCase().includes('terms') ||
              text.toLowerCase().includes('conditions')
            )) {
              const message = text.trim();
              cachedTandCMessage = message;
              tandcMessageFetched = true;
              console.log('[TandCScraper] Successfully extracted T&C message from textarea');
              return { message };
            }
          }
        }
      }
    } catch (e) {
      // Continue to next method
      console.log('[TandCScraper] Method 1 failed, trying other methods...');
    }

    // Method 2: Look for T&C message in the DOM
    const tandcMessage = await page.evaluate(() => {
      // Check for T&C message in common selectors
      const selectors = [
        '[data-testid*="tandc"]',
        '[data-testid*="terms"]',
        '[class*="tandc"]',
        '[class*="terms"]',
        '[id*="tandc"]',
        '[id*="terms"]',
        'textarea',
        'pre',
        'code',
        '[role="dialog"]',
        '[role="alertdialog"]',
      ];

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const element of Array.from(elements)) {
            const text = element.textContent || '';
            // T&C messages are usually longer strings (at least 30 chars)
            if (text.length > 30) {
              // Check if it looks like a T&C message
              const lowerText = text.toLowerCase();
              if (lowerText.includes('terms') || 
                  lowerText.includes('conditions') || 
                  lowerText.includes('agree') ||
                  lowerText.includes('accept')) {
                return text.trim();
              }
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      // Check all text content for T&C pattern
      const allText = document.body.innerText || '';
      const allHTML = document.body.innerHTML || '';
      
      // Look for message that might be the T&C
      // T&C messages often start with specific patterns
      const tandcPatterns = [
        /terms\s+and\s+conditions[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
        /i\s+agree[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
        /accept[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
        /terms[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
      ];

      for (const pattern of tandcPatterns) {
        const match = allText.match(pattern);
        if (match && match[1] && match[1].trim().length > 10) {
          return match[1].trim();
        }
      }

      // Check HTML for data attributes or hidden fields that might contain T&C
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const scriptContent = script.textContent || script.innerHTML || '';
          // Look for JSON data or window variables containing T&C
          const tandcMatch = scriptContent.match(/(?:tandc|terms|TandC)[":\s]*"([^"]{20,200})"/i);
          if (tandcMatch && tandcMatch[1]) {
            return tandcMatch[1];
          }
        }
      } catch (e) {
        // Continue
      }

      // Return debug info if not found
      return {
        notFound: true,
        pageTextSample: allText.substring(0, 500),
        htmlSample: allHTML.substring(0, 500),
      };
    });

    // Method 3: Try to intercept network requests for T&C
    // Set up listener BEFORE navigating/interacting to catch any API calls
    let interceptedMessage: string | null = null;
    const interceptedUrls: string[] = [];
    
    const responseHandler = async (response: { url: () => string; json: () => Promise<any>; text: () => Promise<string>; headers: () => Record<string, string> }) => {
      const url = response.url();
      interceptedUrls.push(url);
      
      if (url.includes('/TandC') || url.includes('tandc') || url.includes('terms') || url.includes('TandC')) {
        console.log(`[TandCScraper] Debug: Intercepted request to: ${url}`);
        try {
          const headers = response.headers();
          const contentType = headers['content-type'] || headers['Content-Type'] || '';
          if (contentType.includes('json')) {
            const data = await response.json();
            console.log(`[TandCScraper] Debug: Response data:`, JSON.stringify(data).substring(0, 200));
            if (data.message) {
              interceptedMessage = data.message;
            }
          } else {
            const text = await response.text();
            console.log(`[TandCScraper] Debug: Response text:`, text.substring(0, 200));
            // Try to parse as JSON anyway
            try {
              const data = JSON.parse(text);
              if (data.message) {
                interceptedMessage = data.message;
              }
            } catch (e) {
              // Not JSON
            }
          }
        } catch (e) {
          console.log(`[TandCScraper] Debug: Error reading response:`, (e as Error).message);
        }
      }
    };

    page.on('response', responseHandler);

    // Wait for intercepted requests and also trigger any lazy-loaded content
    await page.waitForTimeout(3000);

    // Try clicking through the wizard to trigger T&C loading
    try {
      // Click through to terms step
      const continueButtons = await page.locator('text=Continue').all();
      for (const btn of continueButtons) {
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    } catch (e) {
      // Couldn't click, continue
    }

    await page.waitForTimeout(2000);

    // Remove listener to avoid memory leaks
    page.off('response', responseHandler);

    if (interceptedMessage) {
      console.log(`[TandCScraper] Successfully extracted T&C from network request`);
      cachedTandCMessage = interceptedMessage;
      tandcMessageFetched = true;
      return { message: interceptedMessage };
    }

    // Check if tandcMessage is a debug object or actual message
    if (typeof tandcMessage === 'string' && tandcMessage.length > 0) {
      console.log(`[TandCScraper] Successfully extracted T&C from DOM`);
      cachedTandCMessage = tandcMessage;
      tandcMessageFetched = true;
      return { message: tandcMessage };
    }

    // Log debug info if we got it
    if (tandcMessage && typeof tandcMessage === 'object' && 'notFound' in tandcMessage) {
      console.log(`[TandCScraper] Debug: Could not find T&C in DOM`);
      console.log(`[TandCScraper] Debug: Page text sample:`, (tandcMessage as any).pageTextSample);
      console.log(`[TandCScraper] Debug: Intercepted URLs:`, interceptedUrls.slice(0, 10));
    }

    // Method 4: Try to navigate through registration flow to get T&C
    // The T&C message might be shown in step 2 of the wizard
    try {
      // Try to proceed to terms page
      const continueButton = await page.locator('text=Continue').first();
      if (await continueButton.isVisible()) {
        // Enter a dummy address first to proceed
        const addressInput = await page.locator('input[placeholder*="address" i], input[type="text"]').first();
        if (await addressInput.isVisible()) {
          // Don't actually enter address, just look for T&C
          // The T&C might be on the next step
        }
      }

      // Check for T&C on current or next page
      const pageContent = await page.textContent('body');
      const tandcMatch = pageContent?.match(/terms[:\s]+(.+?)(?:\n\n|$)/i);
      if (tandcMatch && tandcMatch[1]) {
        const message = tandcMatch[1].trim();
        cachedTandCMessage = message;
        tandcMessageFetched = true;
        return { message };
      }
    } catch (e) {
      // Couldn't navigate, continue
    }

    // Fallback: Use a default message if we can't find it
    // This should match what the API would return
    const defaultMessage = 'I agree to the Terms and Conditions of the Midnight Network Scavenger Mine';
    
    // DEBUG: Get more info about the page for debugging
    try {
      const pageText = await page.textContent('body') || '';
      const visibleText = pageText.substring(0, 1000);
      console.warn('[TandCScraper] Could not extract T&C message from page, using default');
      console.warn(`[TandCScraper] Debug: Current URL: ${page.url()}`);
      console.warn(`[TandCScraper] Debug: Page text (first 500 chars): ${visibleText.substring(0, 500)}`);
      
      // Save debug info if DEBUG env var is set
      if (process.env.DEBUG || process.env.DEBUG_SCRAPING) {
        try {
          const fs = await import('fs');
          const path = await import('path');
          const debugDir = path.join(process.cwd(), 'logs', 'scraping-debug');
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
          }
          
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const debugFile = path.join(debugDir, `tandc-${timestamp}.html`);
          
          // Save HTML
          const html = await page.content();
          fs.writeFileSync(debugFile, html);
          console.warn(`[TandCScraper] Debug: Saved page HTML to ${debugFile}`);
          
          // Save screenshot
          try {
            const screenshotPath = path.join(debugDir, `tandc-${timestamp}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.warn(`[TandCScraper] Debug: Saved screenshot to ${screenshotPath}`);
          } catch (e) {
            // Screenshot might fail, continue
          }
        } catch (e) {
          // File operations might fail, continue
        }
      } else {
        console.warn(`[TandCScraper] Debug: To save HTML/screenshot, set DEBUG=1 or DEBUG_SCRAPING=1`);
      }
      
      // Try to find any text that might be related to terms
      const termsKeywords = ['terms', 'conditions', 'agree', 'accept', 'license', 'tandc'];
      for (const keyword of termsKeywords) {
        const matches = pageText.match(new RegExp(`[^.]{0,100}${keyword}[^.]{0,100}`, 'gi'));
        if (matches && matches.length > 0) {
          console.warn(`[TandCScraper] Debug: Found text with "${keyword}":`, matches[0].trim());
        }
      }
      
      // Check for JavaScript variables that might contain T&C
      try {
        const scripts = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script'));
          const scriptContents: string[] = [];
          scripts.forEach(script => {
            const content = script.textContent || script.innerHTML || '';
            if (content.includes('tandc') || content.includes('terms') || content.includes('TandC')) {
              scriptContents.push(content.substring(0, 500));
            }
          });
          return scriptContents;
        });
        if (scripts.length > 0) {
          console.warn(`[TandCScraper] Debug: Found ${scripts.length} scripts with T&C keywords`);
          scripts.forEach((script: string, idx: number) => {
            console.warn(`[TandCScraper] Debug: Script ${idx + 1} sample:`, script);
          });
        }
      } catch (e) {
        // Continue
      }
    } catch (e) {
      // Ignore debug errors
    }
    
    cachedTandCMessage = defaultMessage;
    tandcMessageFetched = true;
    return { message: defaultMessage };

  } catch (error: any) {
    console.error('[TandCScraper] Error fetching T&C message:', error.message);
    
    // Return default message on error
    if (!cachedTandCMessage) {
      cachedTandCMessage = 'I agree to the Terms and Conditions of the Midnight Network Scavenger Mine';
      tandcMessageFetched = true;
    }
    
    return { message: cachedTandCMessage! };
  }
}

/**
 * Get T&C message with retry logic
 */
export async function fetchTandCMessageWithRetry(maxRetries = 3): Promise<{ message: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchTandCMessage();
    } catch (error: any) {
      console.warn(`[TandCScraper] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt === maxRetries) {
        // Return default on final failure
        const defaultMessage = 'I agree to the Terms and Conditions of the Midnight Network Scavenger Mine';
        return { message: defaultMessage };
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  
  throw new Error('Failed to fetch T&C message after retries');
}

