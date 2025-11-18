/**
 * Blockchain Query Utility
 * 
 * Queries the Midnight mining API and Cardano blockchain to determine:
 * - Which addresses from a seed phrase are registered
 * - Total submissions/receipts per address
 * - Total NIGHT tokens collected
 * 
 * This works WITHOUT any local cache files - purely from blockchain/API queries.
 * 
 * OPTIMIZED: Queries Midnight API directly (BEST METHOD - queries source of truth!)
 * 
 * Three methods (in order of preference):
 * 1. Query Midnight API directly (OPTIMAL - queries the mining API that stores registration)
 * 2. Try stake key query (finds on-chain addresses - rewards, redemptions on Cardano)
 * 3. Fall back to address generation from seed (finds all possible addresses)
 * 
 * Mining registration is stored on the Midnight API (not Cardano blockchain),
 * so querying the Midnight API directly is the optimal method!
 */

import { WalletManager, DerivedAddress } from './manager';
import { StakeKeyQuery } from './stake-key-query';

export interface AddressRegistrationInfo {
  address: string;
  addressIndex: number;
  isRegistered: boolean;
  registrationChecked: boolean;
  error?: string;
}

export interface AddressSubmissionInfo {
  address: string;
  addressIndex: number;
  submissionCount: number;
  lastSubmissionTime?: string;
  challenges: string[];
}

export interface WalletMiningStats {
  totalAddressesChecked: number;
  registeredAddresses: AddressRegistrationInfo[];
  addressesWithSubmissions: AddressSubmissionInfo[];
  totalSubmissions: number;
  uniqueChallenges: string[];
  estimatedNIGHTTokens?: number; // If API provides this
}

export class BlockchainQuery {
  /**
   * Check if an address is registered by attempting to get its T&C
   * The registration endpoint behavior can indicate if address is registered
   */
  private static async checkAddressRegistration(address: string): Promise<boolean> {
    console.warn('[BlockchainQuery] Midnight HTTP API is retired; registration checks via API are skipped.');
    return false;
  }

  /**
   * Query the mining API for submission data for a specific address
   * Note: This depends on whether the API exposes this endpoint
   */
  private static async getAddressSubmissions(address: string): Promise<{
    count: number;
    lastSubmission?: string;
    challenges: string[];
  }> {
    console.warn(`[BlockchainQuery] Midnight submission API disabled; skipping submission lookup for ${address}.`);
    return { count: 0, challenges: [] };
  }

  /**
   * Query all registered addresses for a seed phrase WITHOUT using cache files
   * 
   * OPTIMIZED METHOD (uses stake key):
   * 1. Extract stake key from seed phrase
   * 2. Query Cardano blockchain for all addresses with that stake key
   * 3. Check which addresses are registered with mining API
   * 4. Query submission data for registered addresses
   * 
   * FALLBACK METHOD (if stake key query fails):
   * 1. Generate addresses from seed phrase (up to maxCount)
   * 2. Query the mining API to check which are registered
   * 3. Queries submission data for each registered address
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxCount - Maximum number of addresses to check if stake key method fails (default: 50,000)
   * @param batchSize - Number of addresses to check in parallel (default: 10)
   * @param progressCallback - Optional callback for progress updates
   * @param useStakeKey - Whether to use stake key method (default: true, much faster!)
   */
  static async queryRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 10,
    progressCallback?: (current: number, total: number, registered: number) => void,
    useStakeKey: boolean = true
  ): Promise<WalletMiningStats> {
    console.log(`[BlockchainQuery] Starting query for registered addresses...`);
    
    console.warn('[BlockchainQuery] Midnight HTTP API has been retired; skipping direct API-based registration discovery.');

    let allAddresses: DerivedAddress[] = [];
    let addressesToCheck: string[] = [];

    // METHOD 1: Try stake key approach (finds on-chain addresses only)
    // NOTE: This won't find mining-only addresses (off-chain registration)
    if (useStakeKey) {
      try {
        console.log(`[BlockchainQuery] Attempting stake key method (finds on-chain addresses only)...`);
        console.log(`[BlockchainQuery] ⚠️  NOTE: Mining registration is OFF-CHAIN, so mining-only addresses won't be found.`);
        const registeredInfo = await StakeKeyQuery.getRegisteredAddressesByStakeKey(mnemonic, true);
        
        if (registeredInfo.length > 0) {
          console.log(`[BlockchainQuery] ✅ Stake key method found ${registeredInfo.length} addresses with on-chain activity!`);
          console.log(`[BlockchainQuery] These are addresses that have had blockchain transactions (rewards, redemptions, etc.).`);
          
          // Convert to DerivedAddress format
          const onChainAddresses = registeredInfo.map(info => ({
            index: info.addressIndex,
            bech32: info.address,
            publicKeyHex: '', // Not needed for query
            registered: info.isRegistered,
          }));
          
          // Store on-chain addresses, but we still need to generate from seed for mining addresses
          allAddresses = onChainAddresses;
          addressesToCheck = registeredInfo.map(info => info.address);
          
          console.log(`[BlockchainQuery] Still generating addresses from seed to find mining-only addresses...`);
          // Continue to fallback to get mining addresses too
        } else {
          console.log(`[BlockchainQuery] Stake key method found no on-chain addresses.`);
          console.log(`[BlockchainQuery] This is expected if addresses were only used for mining (off-chain).`);
          console.log(`[BlockchainQuery] Falling back to address generation from seed phrase...`);
          useStakeKey = false; // Fall through to fallback method
        }
      } catch (error: any) {
        console.warn(`[BlockchainQuery] Stake key method failed: ${error.message}`);
        console.warn(`[BlockchainQuery] Falling back to address generation from seed phrase...`);
        useStakeKey = false; // Fall through to fallback method
      }
    }

    // METHOD 2: Fallback - Generate addresses from seed phrase
    if (!useStakeKey || allAddresses.length === 0) {
      console.log(`[BlockchainQuery] Using fallback method: generating up to ${maxCount} addresses from seed phrase...`);
      const walletManager = new WalletManager();
      const walletInfo = await walletManager.generateWalletFromMnemonic(mnemonic, 'temp', maxCount);
      allAddresses = walletInfo.addresses;
      addressesToCheck = allAddresses.map(a => a.bech32);
      console.log(`[BlockchainQuery] Generated ${allAddresses.length} addresses from seed phrase`);
    }

    const registeredAddresses: AddressRegistrationInfo[] = [];
    const addressesWithSubmissions: AddressSubmissionInfo[] = [];
    let totalSubmissions = 0;
    const uniqueChallenges = new Set<string>();

    // Process addresses in batches to avoid overwhelming the API
    for (let i = 0; i < allAddresses.length; i += batchSize) {
      const batch = allAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (addr) => {
        try {
          // Check if address is registered
          const isRegistered = await this.checkAddressRegistration(addr.bech32);
          
          const regInfo: AddressRegistrationInfo = {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered,
            registrationChecked: true,
          };

          if (isRegistered) {
            registeredAddresses.push(regInfo);

            // Query submission data for registered addresses
            const submissionData = await this.getAddressSubmissions(addr.bech32);
            
            if (submissionData.count > 0) {
              addressesWithSubmissions.push({
                address: addr.bech32,
                addressIndex: addr.index,
                submissionCount: submissionData.count,
                lastSubmissionTime: submissionData.lastSubmission,
                challenges: submissionData.challenges,
              });

              totalSubmissions += submissionData.count;
              submissionData.challenges.forEach(ch => uniqueChallenges.add(ch));
            }
          }

          return regInfo;
        } catch (error: any) {
          return {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered: false,
            registrationChecked: false,
            error: error.message,
          } as AddressRegistrationInfo;
        }
      });

      await Promise.all(batchPromises);

      // Progress callback
      if (progressCallback) {
        progressCallback(i + batch.length, allAddresses.length, registeredAddresses.length);
      }

      // Rate limiting: wait a bit between batches
      if (i + batchSize < allAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between batches
      }
    }

    console.log(`[BlockchainQuery] Query complete:`);
    console.log(`  - Total addresses checked: ${allAddresses.length}`);
    console.log(`  - Registered addresses: ${registeredAddresses.length}`);
    console.log(`  - Addresses with submissions: ${addressesWithSubmissions.length}`);
    console.log(`  - Total submissions: ${totalSubmissions}`);

    return {
      totalAddressesChecked: allAddresses.length,
      registeredAddresses,
      addressesWithSubmissions,
      totalSubmissions,
      uniqueChallenges: Array.from(uniqueChallenges),
    };
  }

  /**
   * Get a simple list of all registered addresses (for redemption tools)
   */
  static async getRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 10
  ): Promise<string[]> {
    const stats = await this.queryRegisteredAddresses(mnemonic, maxCount, batchSize);
    return stats.registeredAddresses
      .filter(a => a.isRegistered)
      .map(a => a.address);
  }

  /**
   * Get all addresses that have submissions (mined successfully)
   */
  static async getAddressesWithSubmissions(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 10
  ): Promise<string[]> {
    const stats = await this.queryRegisteredAddresses(mnemonic, maxCount, batchSize);
    return stats.addressesWithSubmissions.map(a => a.address);
  }
}

