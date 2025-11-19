/**
 * Solution Submitter Scraper
 * Simulates solution submission through the website UI
 * Replaces POST /solution/{address}/{challenge_id}/{nonce} API call
 */

import { browserService } from './browser-service';

const MINING_URL = 'https://sm.midnight.gd/wizard/mine';

export interface SolutionSubmissionResult {
  success: boolean;
  message?: string;
  cryptoReceipt?: string;
}

/**
 * Submit a solution through the website UI
 * Navigates to mining page and simulates solution submission
 */
export async function submitSolution(
  address: string,
  challengeId: string,
  nonce: string
): Promise<SolutionSubmissionResult> {
  try {
    // Navigate to mining page
    const page = await browserService.navigateTo(MINING_URL);

    await page.waitForTimeout(2000);

    // Check if we're on the mining page
    const currentUrl = page.url();
    if (!currentUrl.includes('/wizard/mine')) {
      // Try to navigate to mine page
      await page.goto(MINING_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    // Method 1: Try to find solution submission form/button
    // The website might have a form to submit solutions
    let submitted = false;

    try {
      // Look for submit button or form related to solutions
      const submitSelectors = [
        'button:has-text("Submit")',
        'button:has-text("Submit Solution")',
        'button[type="submit"]',
        'form button',
        '[data-testid*="submit"]',
        '[class*="submit"]',
      ];

      for (const selector of submitSelectors) {
        try {
          const submitButton = await page.locator(selector).first();
          if (await submitButton.isVisible({ timeout: 2000 })) {
            // If there's an input for nonce, fill it first
            const nonceInput = await page.locator('input[placeholder*="nonce" i], input[type="text"]').first();
            if (await nonceInput.isVisible({ timeout: 1000 })) {
              await nonceInput.fill(nonce);
              await page.waitForTimeout(500);
            }

            await submitButton.click();
            await page.waitForTimeout(2000);
            submitted = true;
            break;
          }
        } catch (e) {
          // Element not found, try next selector
          continue;
        }
      }
    } catch (e) {
      console.log('[SolutionSubmitterScraper] Could not find submit button via selectors');
    }

    // Method 2: Try to trigger submission via JavaScript
    // The website might use JavaScript to submit solutions
    if (!submitted) {
      try {
        const submissionResult = await page.evaluate((nonce, challengeId, address) => {
          // Look for solution submission function in window
          const win = window as any;

          // Check for React components that might handle submission
          if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
            // Try to find submission handler in React tree
            // This is a fallback approach
          }

          // Try to find and call submission function
          if (win.submitSolution) {
            try {
              return win.submitSolution(nonce, challengeId, address);
            } catch (e) {
              return { error: (e as Error).message };
            }
          }

          // Try to trigger form submission
          const forms = document.querySelectorAll('form');
          for (const form of Array.from(forms)) {
            const formData = new FormData(form);
            formData.set('nonce', nonce);
            formData.set('challengeId', challengeId);
            formData.set('address', address);

            // Trigger submit event
            const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(submitEvent);

            return { submitted: true };
          }

          return { error: 'No submission method found' };
        }, nonce, challengeId, address);

        if (submissionResult && !(submissionResult as any).error) {
          submitted = true;
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        console.log('[SolutionSubmitterScraper] Could not trigger submission via JavaScript');
      }
    }

    // Method 3: Intercept network requests
    // The website might make API calls that we can intercept and verify
    let interceptedResponse: any = null;

    page.on('response', async (response: { url: () => string; status: () => number; json: () => Promise<any>; text: () => Promise<string> }) => {
      const url = response.url();
      if (url.includes('/solution') || url.includes('submit')) {
        try {
          const data = await response.json();
          interceptedResponse = {
            status: response.status(),
            data,
          };
        } catch (e) {
          // Not JSON or invalid
          interceptedResponse = {
            status: response.status(),
            text: await response.text(),
          };
        }
      }
    });

    // Wait for intercepted response
    if (submitted) {
      await page.waitForTimeout(3000);
    }

    // Method 4: Check page for success/error messages
    const pageText = await page.textContent('body');
    
    // Check for success indicators
    if (pageText?.toLowerCase().includes('success') ||
        pageText?.toLowerCase().includes('solution submitted') ||
        pageText?.toLowerCase().includes('accepted')) {
      
      // Try to extract crypto receipt if present
      const cryptoReceiptMatch = pageText.match(/crypto[_\s]?receipt[:\s]+([a-zA-Z0-9]+)/i);
      const cryptoReceipt = cryptoReceiptMatch ? cryptoReceiptMatch[1] : undefined;

      return {
        success: true,
        message: 'Solution submitted successfully',
        cryptoReceipt,
      };
    }

    // Check for error indicators
    if (pageText?.toLowerCase().includes('error') ||
        pageText?.toLowerCase().includes('failed') ||
        pageText?.toLowerCase().includes('rejected') ||
        pageText?.toLowerCase().includes('invalid')) {
      const errorMessage = pageText.match(/error[:\s]+(.+?)(?:\n|$)/i)?.[1] || 
                          pageText.match(/failed[:\s]+(.+?)(?:\n|$)/i)?.[1] ||
                          'Unknown error';
      return {
        success: false,
        message: errorMessage,
      };
    }

    // Check intercepted response
    if (interceptedResponse) {
      if (interceptedResponse.status >= 200 && interceptedResponse.status < 300) {
        return {
          success: true,
          message: 'Solution submitted successfully',
          cryptoReceipt: interceptedResponse.data?.crypto_receipt,
        };
      } else {
        return {
          success: false,
          message: interceptedResponse.data?.message || `Submission failed with status ${interceptedResponse.status}`,
        };
      }
    }

    // If we submitted but got no clear response, assume success if no errors
    if (submitted) {
      return {
        success: true,
        message: 'Solution submitted (status unknown)',
      };
    }

    // If we couldn't submit, return failure
    return {
      success: false,
      message: 'Could not find submission method',
    };

  } catch (error: any) {
    console.error('[SolutionSubmitterScraper] Error submitting solution:', error.message);
    
    return {
      success: false,
      message: error.message || 'Solution submission failed',
    };
  }
}

/**
 * Submit solution with retry logic
 */
export async function submitSolutionWithRetry(
  address: string,
  challengeId: string,
  nonce: string,
  maxRetries = 3
): Promise<SolutionSubmissionResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await submitSolution(address, challengeId, nonce);
      
      // If successful, return immediately
      if (result.success) {
        return result;
      }

      // If this was the last attempt, return the result
      if (attempt === maxRetries) {
        return result;
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));

    } catch (error: any) {
      console.warn(`[SolutionSubmitterScraper] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt === maxRetries) {
        return {
          success: false,
          message: error.message || 'Solution submission failed after retries',
        };
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }

  return {
    success: false,
    message: 'Solution submission failed after retries',
  };
}

