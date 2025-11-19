/**
 * Registration Scraper
 * Simulates address registration through the website wizard
 * Replaces POST /register/{address}/{signature}/{pubKey} API call
 * 
 * Flow:
 * 1. Navigate to /wizard/wallet
 * 2. Click "Enter an address manually"
 * 3. Enter address and click Continue
 * 4. Click Next on confirmation page
 * 5. Navigate to /wizard/t-c (Accept Token End User Terms)
 * 6. Extract T&C message from page
 * 7. Scroll down, check approval checkbox
 * 8. Click "Accept and sign" button
 * 9. Fill in signature and public key
 * 10. Click "Sign" button
 * 11. Wait for redirect to /wizard/mine
 */

import { browserService } from './browser-service';

const BASE_URL = 'https://sm.midnight.gd';

export interface RegistrationResult {
  success: boolean;
  message?: string;
  alreadyRegistered?: boolean;
}

/**
 * Register an address through the website UI
 * Follows the complete wizard flow from wallet selection to terms acceptance
 */
export async function registerAddress(
  address: string,
  signature: string,
  publicKeyHex: string
): Promise<RegistrationResult> {
  let page = null;
  
  try {
    // Step 1: Navigate to wallet selection page with fresh session
    // Each registration needs a clean session to avoid cookie/session conflicts
    console.log('[RegistrationScraper] Step 1: Navigating to wallet selection page with fresh session...');
    const walletUrl = `${BASE_URL}/wizard/wallet`;
    page = await browserService.navigateTo(walletUrl, { freshSession: true });
    await page.waitForTimeout(2000);

    // Check if we're already past step 1 (address already selected)
    const currentUrl = page.url();
    if (currentUrl.includes('/wizard/t-c')) {
      console.log('[RegistrationScraper] Already on terms page, skipping address entry');
      // Continue to terms acceptance
    } else if (currentUrl.includes('/wizard/mine')) {
      console.log('[RegistrationScraper] Already on mining page, address is registered');
      return {
        success: true,
        message: 'Address already registered',
        alreadyRegistered: true,
      };
    } else {
      // Step 2: Click "Enter an address manually" button
      console.log('[RegistrationScraper] Step 2: Clicking "Enter an address manually"...');
      try {
        // Wait for page to fully load
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        
        const enterAddressButton = page.locator('text=Enter an address manually').first();
        if (await enterAddressButton.isVisible({ timeout: 5000 })) {
          await enterAddressButton.click();
          // Wait for the page to transition to address entry view
          await page.waitForTimeout(2000);
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        } else {
          // Check if we're already on address entry page
          const pageText = await page.textContent('body') || '';
          const url = page.url();
          if (pageText.includes('Enter a Cardano address') || url.includes('/wizard/wallet')) {
            console.log('[RegistrationScraper] Already on address entry page');
          } else {
            console.log('[RegistrationScraper] Enter address button not visible, checking page state...');
          }
        }
      } catch (e: any) {
        // Button might not be visible if we're already on the address entry page
        console.log('[RegistrationScraper] Enter address button not found or clickable, checking page state...');
        await page.waitForTimeout(1000);
      }

      // Step 3: Enter address in the input field
      console.log('[RegistrationScraper] Step 3: Entering address...');
      try {
        // Wait for page to be ready
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        
        // Try multiple selectors to find address input
        const addressInputSelectors = [
          'input[placeholder*="Cardano address" i]',
          'input[placeholder*="address" i]',
          'input[type="text"]',
          'textarea',
        ];
        
        let addressInput = null;
        for (const selector of addressInputSelectors) {
          try {
            const inputs = await page.locator(selector).all();
            for (const input of inputs) {
              if (await input.isVisible({ timeout: 2000 })) {
                const placeholder = await input.getAttribute('placeholder') || '';
                const inputType = await input.getAttribute('type') || '';
                // Skip buttons and non-text inputs
                if (inputType === 'button' || inputType === 'submit') {
                  continue;
                }
                // Prefer inputs with address-related placeholders
                if (placeholder.toLowerCase().includes('address') || selector.includes('address')) {
                  addressInput = input;
                  break;
                } else if (!addressInput) {
                  // Fallback to first visible text input
                  addressInput = input;
                }
              }
            }
            if (addressInput) break;
          } catch (e) {
            continue;
          }
        }
        
        if (!addressInput) {
          // Debug: log page state
          const pageText = await page.textContent('body') || '';
          const url = page.url();
          console.error('[RegistrationScraper] Debug: Could not find address input');
          console.error(`[RegistrationScraper] Debug: Current URL: ${url}`);
          console.error(`[RegistrationScraper] Debug: Page text sample: ${pageText.substring(0, 300)}`);
          
          // Check if address is already set on the page
          if (pageText.includes(address.slice(0, 20))) {
            console.log('[RegistrationScraper] Address appears to be already entered');
            // Try to click Next/Continue anyway
            const continueButton = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
            if (await continueButton.isVisible({ timeout: 5000 }) && !(await continueButton.isDisabled())) {
              await continueButton.click();
              await page.waitForTimeout(3000);
            } else {
              throw new Error('Address input field not found and Continue button not available');
            }
          } else {
            throw new Error('Address input field not found - page may be in unexpected state');
          }
        } else {
          // Clear any existing value
          await addressInput.clear();
          await addressInput.fill(address);
          await page.waitForTimeout(1000);

          // Wait for address validation (the green checkmark)
          await page.waitForTimeout(2000);

          // Step 4: Click Continue button
          console.log('[RegistrationScraper] Step 4: Clicking Continue...');
          const continueButton = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
          if (await continueButton.isVisible({ timeout: 5000 }) && !(await continueButton.isDisabled())) {
            await continueButton.click();
            await page.waitForTimeout(3000);
            // Wait for redirect
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          } else {
            throw new Error('Continue button not found or disabled');
          }
        }
      } catch (e: any) {
        // Check if address is already registered
        const pageText = await page.textContent('body') || '';
        if (pageText?.toLowerCase().includes('already registered') ||
            pageText?.toLowerCase().includes('already exists') ||
            pageText?.toLowerCase().includes('already in use')) {
          return {
            success: false,
            alreadyRegistered: true,
            message: 'Address is already registered',
          };
        }
        throw new Error(`Failed to enter address: ${e.message}`);
      }

      // Step 5: Click Next on address confirmation page (if shown)
      // This will automatically redirect to the Terms and Conditions page
      console.log('[RegistrationScraper] Step 5: Confirming address and waiting for redirect to Terms page...');
      try {
        const nextButton = page.locator('button:has-text("Next")').first();
        if (await nextButton.isVisible({ timeout: 3000 }) && !(await nextButton.isDisabled())) {
          await nextButton.click();
          // Wait for redirect to Terms and Conditions page (/wizard/t-c)
          try {
            await page.waitForURL(/\/wizard\/t-c/, { timeout: 10000 });
            console.log('[RegistrationScraper] Redirected to Terms and Conditions page');
          } catch (e) {
            // May already be on terms page or redirect is taking longer
            await page.waitForTimeout(3000);
          }
        }
      } catch (e) {
        // May already be on terms page, check current URL
        const currentUrl = page.url();
        if (!currentUrl.includes('/wizard/t-c')) {
          console.log('[RegistrationScraper] Next button not found, checking if already on terms page...');
          await page.waitForTimeout(2000);
        }
      }
    }

    // Step 6: Wait for Terms and Conditions page to be ready
    // Page should have been redirected automatically from previous step
    console.log('[RegistrationScraper] Step 6: Waiting for Terms and Conditions page to load...');
    try {
      // Wait for the page to be on /wizard/t-c
      if (!page.url().includes('/wizard/t-c')) {
        await page.waitForURL(/\/wizard\/t-c/, { timeout: 10000 });
      }
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } catch (e) {
      // Page might already be loaded or still loading
      await page.waitForTimeout(2000);
    }

    // Step 7: Extract the T&C message from the page (for verification)
    console.log('[RegistrationScraper] Step 7: Extracting T&C message from page...');
    let tandcMessage = '';
    try {
      // The message is shown in a text area or pre tag with "Message to be signed" label
      const messageSelectors = [
        'textarea',
        'pre',
        '[data-testid*="message"]',
        'input[readonly]',
      ];

      for (const selector of messageSelectors) {
        try {
          const elements = await page.locator(selector).all();
          for (const element of elements) {
            const text = await element.textContent();
            if (text && text.length > 50 && (
              text.toLowerCase().includes('agree') ||
              text.toLowerCase().includes('terms') ||
              text.toLowerCase().includes('conditions')
            )) {
              tandcMessage = text.trim();
              console.log('[RegistrationScraper] Found T&C message:', tandcMessage.substring(0, 100) + '...');
              break;
            }
          }
          if (tandcMessage) break;
        } catch (e) {
          continue;
        }
      }

      // Also try to find it via label
      try {
        const messageLabel = page.locator('text=/Message to be signed/i').first();
        if (await messageLabel.isVisible({ timeout: 2000 })) {
          // Find the associated input/textarea
          const parent = await messageLabel.locator('..').first();
          const messageElement = await parent.locator('textarea, pre, input').first();
          if (await messageElement.isVisible({ timeout: 2000 })) {
            const text = await messageElement.textContent();
            if (text && text.length > 50) {
              tandcMessage = text.trim();
              console.log('[RegistrationScraper] Found T&C message via label:', tandcMessage.substring(0, 100) + '...');
            }
          }
        }
      } catch (e) {
        // Continue
      }
    } catch (e) {
      console.warn('[RegistrationScraper] Could not extract T&C message, continuing anyway...');
    }

    // Step 8: Scroll down and check the approval checkbox
    console.log('[RegistrationScraper] Step 8: Checking approval checkbox...');
    try {
      // Scroll to bottom to ensure checkbox is visible
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(1000);

      // Find and check the approval checkbox
      const checkboxSelectors = [
        'input[type="checkbox"]',
        '[role="checkbox"]',
        'input[aria-label*="agree" i]',
        'input[aria-label*="accept" i]',
      ];

      let checkboxChecked = false;
      for (const selector of checkboxSelectors) {
        try {
          const checkboxes = await page.locator(selector).all();
          for (const checkbox of checkboxes) {
            if (await checkbox.isVisible({ timeout: 2000 })) {
              const isChecked = await checkbox.isChecked();
              if (!isChecked) {
                await checkbox.check();
                await page.waitForTimeout(500);
                checkboxChecked = true;
                console.log('[RegistrationScraper] Checked approval checkbox');
                break;
              } else {
                checkboxChecked = true;
                console.log('[RegistrationScraper] Approval checkbox already checked');
                break;
              }
            }
          }
          if (checkboxChecked) break;
        } catch (e) {
          continue;
        }
      }

      if (!checkboxChecked) {
        console.warn('[RegistrationScraper] Could not find approval checkbox, continuing anyway...');
      }
    } catch (e) {
      console.warn('[RegistrationScraper] Could not check approval checkbox:', (e as Error).message);
    }

    // Step 9: Click "Accept and sign" button (if present, before signature entry)
    console.log('[RegistrationScraper] Step 9: Clicking Accept and sign...');
    try {
      const acceptButton = page.locator('button:has-text("Accept and sign"), button:has-text("Accept"), button:has-text("Agree")').first();
      if (await acceptButton.isVisible({ timeout: 3000 }) && !(await acceptButton.isDisabled())) {
        await acceptButton.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // Button might not be present if we're already on signature entry step
      console.log('[RegistrationScraper] Accept and sign button not found, may already be on signature step');
    }

    // Step 10: Fill in signature field
    console.log('[RegistrationScraper] Step 10: Entering signature...');
    try {
      // Find signature input field (usually a textarea or text input)
      const signatureSelectors = [
        'textarea[placeholder*="signature" i]',
        'input[placeholder*="signature" i]',
        'textarea',
        'input[type="text"]',
      ];

      let signatureFilled = false;
      for (let i = 0; i < signatureSelectors.length; i++) {
        try {
          const inputs = await page.locator(signatureSelectors[i]).all();
          // Usually the first textarea/input is the message, second is signature
          // Look for one that doesn't have the message content
          for (const input of inputs) {
            if (await input.isVisible({ timeout: 2000 })) {
              const placeholder = await input.getAttribute('placeholder') || '';
              const value = await input.inputValue();
              
              // Skip if it's the message field (already has content)
              if (value && value.length > 100 && value.includes('agree')) {
                continue;
              }
              
              // This should be the signature field
              if (placeholder.toLowerCase().includes('signature') || i > 0) {
                await input.fill(signature);
                await page.waitForTimeout(500);
                signatureFilled = true;
                console.log('[RegistrationScraper] Entered signature');
                break;
              }
            }
          }
          if (signatureFilled) break;
        } catch (e) {
          continue;
        }
      }

      if (!signatureFilled) {
        throw new Error('Could not find signature input field');
      }
    } catch (e: any) {
      throw new Error(`Failed to enter signature: ${e.message}`);
    }

    // Step 11: Fill in public key field
    console.log('[RegistrationScraper] Step 11: Entering public key...');
    try {
      // Find public key input field
      const pubKeySelectors = [
        'input[placeholder*="public key" i]',
        'input[placeholder*="Public key" i]',
        'input[type="text"]',
      ];

      let pubKeyFilled = false;
      const inputs = await page.locator('input[type="text"]').all();
      for (const input of inputs) {
        if (await input.isVisible({ timeout: 2000 })) {
          const placeholder = await input.getAttribute('placeholder') || '';
          const value = await input.inputValue();
          
          // Skip if it's already filled with signature
          if (value === signature) {
            continue;
          }
          
          // Skip if it's already filled
          if (value && value.length > 0) {
            continue;
          }
          
          // This should be the public key field
          if (placeholder.toLowerCase().includes('public key') || !pubKeyFilled) {
            await input.fill(publicKeyHex);
            await page.waitForTimeout(500);
            pubKeyFilled = true;
            console.log('[RegistrationScraper] Entered public key');
            break;
          }
        }
      }

      if (!pubKeyFilled) {
        throw new Error('Could not find public key input field');
      }
    } catch (e: any) {
      throw new Error(`Failed to enter public key: ${e.message}`);
    }

    // Step 12: Click Sign button
    console.log('[RegistrationScraper] Step 12: Clicking Sign button...');
    try {
      const signButton = page.locator('button:has-text("Sign")').first();
      if (await signButton.isVisible({ timeout: 5000 })) {
        // Check if button is enabled
        const isDisabled = await signButton.isDisabled();
        if (isDisabled) {
          // Wait a bit for validation to complete
          await page.waitForTimeout(2000);
        }
        
        await signButton.click();
        console.log('[RegistrationScraper] Clicked Sign button');
        
        // Wait for navigation or response
        await page.waitForTimeout(3000);
        
        // Wait for navigation to mining page
        try {
          await page.waitForURL(/\/wizard\/mine/, { timeout: 10000 });
          console.log('[RegistrationScraper] Successfully navigated to mining page');
        } catch (e) {
          // May already be on mining page or need more time
          await page.waitForTimeout(3000);
        }
      } else {
        throw new Error('Sign button not found');
      }
    } catch (e: any) {
      throw new Error(`Failed to click Sign button: ${e.message}`);
    }

    // Step 13: Verify we're on the mining page (success) or check for errors
    console.log('[RegistrationScraper] Step 13: Verifying registration success...');
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    const finalPageText = await page.textContent('body') || '';

    // Close the page to free resources since we used a fresh session
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (e) {
      // Ignore close errors
    }

    // Check for success (mining page)
    if (finalUrl.includes('/wizard/mine')) {
      console.log('[RegistrationScraper] ✓ Registration successful - on mining page');
      return {
        success: true,
        message: 'Address registered successfully',
      };
    }

    // Check for already registered error
    if (finalPageText.toLowerCase().includes('already registered') ||
        finalPageText.toLowerCase().includes('already exists') ||
        finalPageText.toLowerCase().includes('duplicate') ||
        finalPageText.toLowerCase().includes('already in use')) {
      return {
        success: false,
        alreadyRegistered: true,
        message: 'Address is already registered',
      };
    }

    // Check for other errors
    if (finalPageText.toLowerCase().includes('error') ||
        finalPageText.toLowerCase().includes('failed') ||
        finalPageText.toLowerCase().includes('invalid')) {
      const errorMatch = finalPageText.match(/error[:\s]+(.+?)(?:\n|$)/i);
      const errorMessage = errorMatch?.[1] || 'Unknown error during registration';
      return {
        success: false,
        message: errorMessage,
      };
    }

    // If we're still on terms page, registration might have failed
    if (finalUrl.includes('/wizard/t-c')) {
      return {
        success: false,
        message: 'Registration may have failed - still on terms page',
      };
    }

    // Unknown state - assume failure
    return {
      success: false,
      message: `Unknown registration state. Final URL: ${finalUrl}`,
    };

  } catch (error: any) {
    console.error('[RegistrationScraper] Error registering address:', error.message);
    
    // Close page on error
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (e) {
      // Ignore close errors
    }
    
    // Check if error indicates already registered
    if (error.message?.toLowerCase().includes('already registered') ||
        error.message?.toLowerCase().includes('already exists')) {
      return {
        success: false,
        alreadyRegistered: true,
        message: error.message,
      };
    }

    // Check if browser/page was closed
    if (error.message?.includes('Target page, context or browser has been closed') ||
        error.message?.includes('browser has been closed')) {
      return {
        success: false,
        message: 'Browser was closed during registration',
      };
    }

    return {
      success: false,
      message: error.message || 'Registration failed',
    };
  }
}

/**
 * Register address with retry logic
 */
export async function registerAddressWithRetry(
  address: string,
  signature: string,
  publicKeyHex: string,
  maxRetries = 3
): Promise<RegistrationResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[RegistrationScraper] Registration attempt ${attempt}/${maxRetries} for address ${address.slice(0, 20)}...`);
      
      const result = await registerAddress(address, signature, publicKeyHex);
      
      // If already registered, return immediately
      if (result.alreadyRegistered) {
        return result;
      }
      
      // If successful, return immediately
      if (result.success) {
        return result;
      }

      // If this was the last attempt, return the result
      if (attempt === maxRetries) {
        return result;
      }

      // Wait before retry
      console.log(`[RegistrationScraper] Registration failed, retrying in ${2 * attempt} seconds...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));

    } catch (error: any) {
      console.warn(`[RegistrationScraper] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      if (attempt === maxRetries) {
        return {
          success: false,
          message: error.message || 'Registration failed after retries',
        };
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }

  return {
    success: false,
    message: 'Registration failed after retries',
  };
}
