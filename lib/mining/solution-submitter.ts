/**
 * Solution Submitter
 * Handles submission of mining solutions with dev fee support
 */

import { devFeeManager } from './devfee';
import { chainTransport } from './chain-transport';

export interface Solution {
  challengeId: string;
  nonce: string;
  hash: string;
  addressIndex: number;
  bech32Address: string;
}

export class SolutionSubmitter {
  constructor(private transport = chainTransport) {}

  /**
   * Submit a solution
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

      await this.transport.submitSolution(targetAddress, solution.challengeId, solution.nonce, solution.hash);

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
    } catch (error: any) {
      const errorMsg = error.message || 'Unknown submission error';
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
