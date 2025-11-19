/**
 * Solution Submitter
 * Handles submission of mining solutions with dev fee support
 */

import { devFeeManager } from './devfee';
import { submitSolutionWithRetry } from '@/lib/scraping/solution-submitter-scraper';

export interface Solution {
  challengeId: string;
  nonce: string;
  hash: string;
  addressIndex: number;
  bech32Address: string;
}

export class SolutionSubmitter {
  // API base no longer used - all submissions go through web scraping
  // private apiBase: string;

  constructor(apiBase: string) {
    // API base parameter kept for compatibility but not used
    // this.apiBase = apiBase;
  }

  /**
   * Submit a solution through website UI (web scraping)
   * Automatically applies dev fee if applicable
   */
  async submitSolution(
    solution: Solution,
    devAddressBech32?: string
  ): Promise<{ success: boolean; devFee: boolean; error?: string }> {
    // Check if this should be a dev fee submission
    const shouldApplyDevFee = devFeeManager.shouldApplyDevFee();
    const useDevWallet = shouldApplyDevFee && devAddressBech32;

    const targetAddress = useDevWallet ? devAddressBech32 : solution.bech32Address;

    try {
      console.log('[SolutionSubmitter] Submitting solution:', {
        challengeId: solution.challengeId,
        address: targetAddress,
        devFee: useDevWallet,
        nonce: solution.nonce,
        hashPrefix: solution.hash.slice(0, 16),
      });

      // Submit through website UI (web scraping)
      const result = await submitSolutionWithRetry(targetAddress, solution.challengeId, solution.nonce);

      if (result.success) {
        if (useDevWallet) {
          devFeeManager.markDevFeeApplied();
          console.log('[SolutionSubmitter] ✓ Dev fee solution submitted successfully');
        } else {
          console.log('[SolutionSubmitter] ✓ Solution submitted successfully');
        }

        return {
          success: true,
          devFee: !!useDevWallet,
        };
      } else {
        throw new Error(result.message || 'Submission failed');
      }
    } catch (error: any) {
      const errorMsg = error?.message || 'Unknown error';
      console.error('[SolutionSubmitter] ✗ Submission failed:', errorMsg);

      return {
        success: false,
        devFee: !!useDevWallet,
        error: errorMsg,
      };
    }
  }

  /**
   * Get dev fee stats
   */
  getDevFeeStats() {
    return devFeeManager.getStats();
  }
}
