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
    // Navigate to the wizard/wallet page where T&C might be shown
    // The T&C message is typically shown during registration flow
    const walletUrl = `${BASE_URL}/wizard/wallet`;
    const page = await browserService.navigateTo(walletUrl);

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Method 1: Try to extract from registration flow
    // Click "Enter an address manually" if present
    try {
      const enterAddressButton = await page.locator('text=Enter an address manually').first();
      if (await enterAddressButton.isVisible()) {
        await enterAddressButton.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      // Button not found, continue
    }

    // Method 2: Look for T&C message in the DOM
    const tandcMessage = await page.evaluate(() => {
      // Check for T&C message in common selectors
      const selectors = [
        '[data-testid*="tandc"]',
        '[data-testid*="terms"]',
        '[class*="tandc"]',
        '[class*="terms"]',
        'text=/terms/i',
        'text=/conditions/i',
      ];

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const element of Array.from(elements)) {
            const text = element.textContent || '';
            // T&C messages are usually longer strings
            if (text.length > 50) {
              return text.trim();
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      // Check all text content for T&C pattern
      const allText = document.body.innerText || '';
      
      // Look for message that might be the T&C
      // T&C messages often start with specific patterns
      const tandcPatterns = [
        /terms\s+and\s+conditions[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
        /i\s+agree[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
        /accept[:\s]+(.+?)(?:\n\n|\r\n\r\n|$)/i,
      ];

      for (const pattern of tandcPatterns) {
        const match = allText.match(pattern);
        if (match && match[1]) {
          return match[1].trim();
        }
      }

      return null;
    });

    // Method 3: Try to intercept network requests for T&C
    let interceptedMessage: string | null = null;
    
    page.on('response', async (response: { url: () => string; json: () => Promise<any> }) => {
      const url = response.url();
      if (url.includes('/TandC') || url.includes('tandc') || url.includes('terms')) {
        try {
          const data = await response.json();
          if (data.message) {
            interceptedMessage = data.message;
          }
        } catch (e) {
          // Not JSON or invalid
        }
      }
    });

    // Wait for intercepted requests
    await page.waitForTimeout(2000);

    if (interceptedMessage) {
      cachedTandCMessage = interceptedMessage;
      tandcMessageFetched = true;
      return { message: interceptedMessage };
    }

    if (tandcMessage) {
      cachedTandCMessage = tandcMessage;
      tandcMessageFetched = true;
      return { message: tandcMessage };
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
        cachedTandCMessage = tandcMatch[1].trim();
        tandcMessageFetched = true;
        return { message: cachedTandCMessage };
      }
    } catch (e) {
      // Couldn't navigate, continue
    }

    // Fallback: Use a default message if we can't find it
    // This should match what the API would return
    const defaultMessage = 'I agree to the Terms and Conditions of the Midnight Network Scavenger Mine';
    
    console.warn('[TandCScraper] Could not extract T&C message from page, using default');
    
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

