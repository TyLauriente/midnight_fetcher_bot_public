/**
 * Registration Scraper
 * Simulates address registration through the website wizard
 * Replaces POST /register/{address}/{signature}/{pubKey} API call
 */

import { browserService } from './browser-service';
import { fetchTandCMessage } from './tandc-scraper';

const BASE_URL = 'https://sm.midnight.gd';

export interface RegistrationResult {
  success: boolean;
  message?: string;
  alreadyRegistered?: boolean;
}

/**
 * Register an address through the website UI
 * Navigates through the wizard flow: wallet → address → terms → registration
 */
export async function registerAddress(
  address: string,
  signature: string,
  publicKeyHex: string
): Promise<RegistrationResult> {
  try {
    // Step 1: Navigate to wallet selection page
    const walletUrl = `${BASE_URL}/wizard/wallet`;
    const page = await browserService.navigateTo(walletUrl);

    await page.waitForTimeout(2000);

    // Step 2: Click "Enter an address manually"
    try {
      const enterAddressButton = await page.locator('text=Enter an address manually').first();
      if (await enterAddressButton.isVisible({ timeout: 5000 })) {
        await enterAddressButton.click();
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      // Button might not be visible if we're already on the address entry page
      console.log('[RegistrationScraper] Enter address button not found, continuing...');
    }

    // Step 3: Enter address
    try {
      const addressInput = await page.locator('input[placeholder*="address" i], input[type="text"]').first();
      
      if (await addressInput.isVisible({ timeout: 5000 })) {
        await addressInput.fill(address);
        await page.waitForTimeout(500);

        // Step 4: Click Continue button
        const continueButton = await page.locator('text=Continue').first();
        if (await continueButton.isVisible({ timeout: 5000 })) {
          await continueButton.click();
          await page.waitForTimeout(2000);
        }
      } else {
        throw new Error('Address input not found');
      }
    } catch (e: any) {
      // Check if address input is not visible because we're past this step
      // Or check if address is already registered
      const pageText = await page.textContent('body');
      if (pageText?.toLowerCase().includes('already registered') ||
          pageText?.toLowerCase().includes('already exists')) {
        return {
          success: false,
          alreadyRegistered: true,
          message: 'Address is already registered',
        };
      }
      throw new Error(`Failed to enter address: ${e.message}`);
    }

    // Step 5: Accept Terms and Conditions (Step 2 of wizard)
    // This step might require signing the T&C message
    try {
      // Get T&C message
      const tandcResponse = await fetchTandCMessage();
      const tandcMessage = tandcResponse.message;

      // Look for terms acceptance checkbox or button
      const termsSelectors = [
        'text=/agree/i',
        'text=/accept/i',
        'input[type="checkbox"]',
        'button:has-text("Accept")',
        'button:has-text("Agree")',
        'button:has-text("Continue")',
      ];

      let termsAccepted = false;
      for (const selector of termsSelectors) {
        try {
          const element = await page.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            if (selector.includes('checkbox')) {
              // Check the checkbox
              await element.check();
            } else {
              // Click the button
              await element.click();
            }
            await page.waitForTimeout(1000);
            termsAccepted = true;
            break;
          }
        } catch (e) {
          // Element not found, try next selector
          continue;
        }
      }

      // If we found a continue button, click it to proceed
      const continueButton = await page.locator('text=Continue').first();
      if (await continueButton.isVisible({ timeout: 5000 }) && !termsAccepted) {
        await continueButton.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log('[RegistrationScraper] Could not find terms acceptance step, continuing...');
    }

    // Step 6: Wait for registration to complete
    // The page should navigate or show success/error message
    await page.waitForTimeout(3000);

    // Step 7: Check for success or error messages
    const pageText = await page.textContent('body');
    const currentUrl = page.url();

    // Check for success indicators
    if (pageText?.toLowerCase().includes('success') ||
        pageText?.toLowerCase().includes('registered') ||
        currentUrl.includes('/wizard/mine') ||
        currentUrl.includes('/wizard/terms')) {
      return {
        success: true,
        message: 'Address registered successfully',
      };
    }

    // Check for error indicators
    if (pageText?.toLowerCase().includes('already registered') ||
        pageText?.toLowerCase().includes('already exists') ||
        pageText?.toLowerCase().includes('duplicate')) {
      return {
        success: false,
        alreadyRegistered: true,
        message: 'Address is already registered',
      };
    }

    if (pageText?.toLowerCase().includes('error') ||
        pageText?.toLowerCase().includes('failed') ||
        pageText?.toLowerCase().includes('invalid')) {
      const errorMessage = pageText.match(/error[:\s]+(.+?)(?:\n|$)/i)?.[1] || 'Unknown error';
      return {
        success: false,
        message: errorMessage,
      };
    }

    // If we reached the mining page, registration was likely successful
    if (currentUrl.includes('/wizard/mine')) {
      return {
        success: true,
        message: 'Address registered successfully',
      };
    }

    // Unknown state - assume failure
    return {
      success: false,
      message: 'Unknown registration state',
    };

  } catch (error: any) {
    console.error('[RegistrationScraper] Error registering address:', error.message);
    
    // Check if error indicates already registered
    if (error.message?.toLowerCase().includes('already registered') ||
        error.message?.toLowerCase().includes('already exists')) {
      return {
        success: false,
        alreadyRegistered: true,
        message: error.message,
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

