/**
 * Stake Key Query Utility
 * 
 * IMPORTANT LIMITATION: Stake key queries only find addresses that have been USED on-chain
 * (have had transactions, UTXOs, or smart contract interactions).
 * 
 * Mining registration is OFF-CHAIN (stored in mining API database, not on blockchain).
 * Therefore, stake key queries will NOT find addresses that were only registered for mining
 * and never had on-chain activity.
 * 
 * Use this for:
 * - Finding addresses that have received rewards (on-chain)
 * - Finding addresses that have redeemed tokens (on-chain)
 * - Finding addresses with any blockchain activity
 * 
 * Do NOT rely on this for:
 * - Finding addresses registered only for mining (off-chain)
 * - Finding addresses that never had transactions
 * 
 * For mining addresses, use address generation from seed phrase instead.
 */

import { Lucid } from 'lucid-cardano';
import axios from 'axios';
import { WalletManager } from './manager';

// Cardano blockchain explorer APIs (try multiple for reliability)
const BLOCKFROST_API = 'https://cardano-mainnet.blockfrost.io/api/v0';
const KOIOS_API = 'https://api.koios.rest/api/v0';
const CARDANOSCAN_API = 'https://api.cardanoscan.io/api/v1';

export interface StakeKeyInfo {
  stakeKey: string;
  addresses: string[];
  totalAddresses: number;
}

export interface RegisteredAddressInfo {
  address: string;
  addressIndex: number;
  isRegistered: boolean;
  hasSubmissions: boolean;
  submissionCount?: number;
}

export class StakeKeyQuery {
  /**
   * Extract stake key from a seed phrase
   * All addresses from the same seed phrase share the same stake key
   */
  static async getStakeKeyFromSeed(mnemonic: string): Promise<string> {
    // Derive the first address to get the stake key
    // All addresses from the same seed share the same stake key
    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(mnemonic, {
      accountIndex: 0, // Use account 0
    });

    const address = await lucid.wallet.address();
    
    // Extract stake key from address
    // Cardano addresses contain the stake key in their structure
    // For base addresses (addr1...), we can extract the stake key
    const stakeKey = await this.extractStakeKeyFromAddress(address);
    
    return stakeKey;
  }

  /**
   * Extract stake key from a Cardano address
   * Uses address inspection to get the stake key component
   */
  private static async extractStakeKeyFromAddress(address: string): Promise<string> {
    try {
      // Try using Lucid to get stake key
      // For base addresses, the stake key is embedded
      // We can use cardano-address library or derive it from the address structure
      
      // Alternative: Query a Cardano API to inspect the address
      // Blockfrost can provide address details including stake key
      const response = await axios.get(`${BLOCKFROST_API}/addresses/${address}`, {
        headers: {
          'project_id': process.env.BLOCKFROST_API_KEY || '', // Optional API key
        },
        validateStatus: () => true, // Don't throw on errors
      });

      if (response.status === 200 && response.data?.stake_address) {
        return response.data.stake_address;
      }
    } catch (error) {
      // Fallback: Extract from address structure
      console.warn('[StakeKeyQuery] Could not fetch stake key from API, using address structure');
    }

    // Fallback: Derive stake key from address using Lucid
    // For base addresses, we can extract the stake key portion
    // This is a simplified extraction - full implementation would use cardano-address library
    return await this.deriveStakeKeyFromAddress(address);
  }

  /**
   * Derive stake key from address structure
   * This is a fallback if API query fails
   */
  private static async deriveStakeKeyFromAddress(address: string): Promise<string> {
    // For now, we'll use a workaround:
    // Generate addresses from seed and extract stake key from the first one
    // The stake key is consistent across all addresses from the same seed
    
    // Note: Full implementation would use cardano-address library or similar
    // to properly extract stake key from address bech32 encoding
    
    // Temporary solution: Return a placeholder that indicates we need the address list
    // In practice, we'd use a proper Cardano library to extract this
    throw new Error('Stake key extraction requires cardano-address library or API access');
  }

  /**
   * Query Cardano blockchain for all addresses with a given stake key
   * Uses Blockfrost, Koios, or Cardanoscan APIs
   */
  static async getAddressesByStakeKey(stakeKey: string): Promise<string[]> {
    const addresses: string[] = [];
    const seen = new Set<string>();

    // Try Blockfrost API first
    try {
      const blockfrostAddrs = await this.queryBlockfrostStakeKey(stakeKey);
      blockfrostAddrs.forEach(addr => {
        if (!seen.has(addr)) {
          seen.add(addr);
          addresses.push(addr);
        }
      });
    } catch (error) {
      console.warn('[StakeKeyQuery] Blockfrost query failed:', error);
    }

    // Try Koios API
    try {
      const koiosAddrs = await this.queryKoiosStakeKey(stakeKey);
      koiosAddrs.forEach(addr => {
        if (!seen.has(addr)) {
          seen.add(addr);
          addresses.push(addr);
        }
      });
    } catch (error) {
      console.warn('[StakeKeyQuery] Koios query failed:', error);
    }

    // Try Cardanoscan API
    try {
      const cardanoscanAddrs = await this.queryCardanoscanStakeKey(stakeKey);
      cardanoscanAddrs.forEach(addr => {
        if (!seen.has(addr)) {
          seen.add(addr);
          addresses.push(addr);
        }
      });
    } catch (error) {
      console.warn('[StakeKeyQuery] Cardanoscan query failed:', error);
    }

    return addresses;
  }

  /**
   * Query Blockfrost API for addresses by stake key
   */
  private static async queryBlockfrostStakeKey(stakeKey: string): Promise<string[]> {
    const addresses: string[] = [];
    let page = 1;
    const pageSize = 100;

    try {
      while (true) {
        const response = await axios.get(`${BLOCKFROST_API}/accounts/${stakeKey}/addresses`, {
          params: {
            page: page,
            count: pageSize,
          },
          headers: {
            'project_id': process.env.BLOCKFROST_API_KEY || '',
          },
          validateStatus: () => true,
        });

        if (response.status !== 200) {
          break;
        }

        const data = response.data;
        if (!data || data.length === 0) {
          break;
        }

        data.forEach((item: any) => {
          if (item.address) {
            addresses.push(item.address);
          }
        });

        // Check if there are more pages
        if (data.length < pageSize) {
          break;
        }

        page++;
      }
    } catch (error: any) {
      console.error('[StakeKeyQuery] Blockfrost error:', error.message);
    }

    return addresses;
  }

  /**
   * Query Koios API for addresses by stake key
   */
  private static async queryKoiosStakeKey(stakeKey: string): Promise<string[]> {
    try {
      const response = await axios.post(`${KOIOS_API}/account_addresses`, {
        stake_addresses: [stakeKey],
      }, {
        validateStatus: () => true,
      });

      if (response.status === 200 && response.data && response.data.length > 0) {
        return response.data[0].addresses || [];
      }
    } catch (error: any) {
      console.error('[StakeKeyQuery] Koios error:', error.message);
    }

    return [];
  }

  /**
   * Query Cardanoscan API for addresses by stake key
   */
  private static async queryCardanoscanStakeKey(stakeKey: string): Promise<string[]> {
    const addresses: string[] = [];
    let page = 1;

    try {
      while (true) {
        const response = await axios.get(`${CARDANOSCAN_API}/rewardAccount/addresses`, {
          params: {
            rewardAddress: stakeKey,
            pageNo: page,
          },
          validateStatus: () => true,
        });

        if (response.status !== 200 || !response.data || !response.data.data) {
          break;
        }

        const data = response.data.data;
        if (data.length === 0) {
          break;
        }

        data.forEach((item: any) => {
          if (item.address) {
            addresses.push(item.address);
          }
        });

        // Check if there are more pages
        if (!response.data.hasNextPage) {
          break;
        }

        page++;
      }
    } catch (error: any) {
      console.error('[StakeKeyQuery] Cardanoscan error:', error.message);
    }

    return addresses;
  }

  /**
   * Get all registered addresses for a seed phrase using stake key
   * 
   * ⚠️ IMPORTANT: This method only finds addresses with ON-CHAIN activity.
   * Mining registration is OFF-CHAIN, so mining-only addresses won't be found.
   * 
   * For mining addresses, use address generation from seed phrase instead.
   * This method is best for finding addresses that have received rewards or redeemed tokens.
   */
  static async getRegisteredAddressesByStakeKey(
    mnemonic: string,
    checkMiningApi: boolean = true
  ): Promise<RegisteredAddressInfo[]> {
    console.log('[StakeKeyQuery] Getting stake key from seed phrase...');
    console.log('[StakeKeyQuery] ⚠️  NOTE: This only finds addresses with ON-CHAIN activity.');
    console.log('[StakeKeyQuery] Mining registration is OFF-CHAIN and won\'t be found here.');
    
    // Method 1: Try to get stake key from blockchain (requires API)
    let stakeKey: string | null = null;
    let blockchainAddresses: string[] = [];

    try {
      // Generate first address to get stake key
      const walletManager = new WalletManager();
      const walletInfo = await walletManager.generateWalletFromMnemonic(mnemonic, 'temp', 1);
      const firstAddress = walletInfo.addresses[0].bech32;

      // Try to get stake key from address via API
      try {
        const response = await axios.get(`${BLOCKFROST_API}/addresses/${firstAddress}`, {
          headers: {
            'project_id': process.env.BLOCKFROST_API_KEY || '',
          },
          validateStatus: () => true,
        });

        if (response.status === 200 && response.data?.stake_address) {
          const retrievedStakeKey = response.data.stake_address;
          stakeKey = retrievedStakeKey;
          console.log(`[StakeKeyQuery] Found stake key: ${retrievedStakeKey}`);
          
          // Query blockchain for all addresses with this stake key
          // NOTE: This only returns addresses that have had ON-CHAIN transactions
          console.log('[StakeKeyQuery] Querying blockchain for addresses with on-chain activity...');
          blockchainAddresses = await this.getAddressesByStakeKey(retrievedStakeKey);
          console.log(`[StakeKeyQuery] Found ${blockchainAddresses.length} addresses with on-chain activity`);
          
          if (blockchainAddresses.length === 0) {
            console.warn('[StakeKeyQuery] No addresses found with on-chain activity.');
            console.warn('[StakeKeyQuery] This is normal if addresses were only used for mining (off-chain).');
            console.warn('[StakeKeyQuery] Use address generation from seed phrase for mining addresses.');
          }
        }
      } catch (error) {
        console.warn('[StakeKeyQuery] Could not get stake key from API');
        console.warn('[StakeKeyQuery] Falling back to address generation from seed phrase');
      }
    } catch (error) {
      console.error('[StakeKeyQuery] Error getting stake key:', error);
    }

    // Method 2: If blockchain query returned no addresses, this is expected for mining-only addresses
    // Don't fall back to address generation here - that's handled by BlockchainQuery class
    if (blockchainAddresses.length === 0) {
      console.log('[StakeKeyQuery] No on-chain addresses found. This is expected for mining-only addresses.');
      console.log('[StakeKeyQuery] Returning empty array - use address generation from seed for mining addresses.');
      return [];
    }

    // Method 3: Check which addresses are registered with mining API
    const registeredAddresses: RegisteredAddressInfo[] = [];

    if (checkMiningApi) {
      console.warn('[StakeKeyQuery] Midnight HTTP API has been retired; skipping mining API registration checks.');
    } else {
      // Just return all addresses from blockchain
      blockchainAddresses.forEach((address, index) => {
        registeredAddresses.push({
          address,
          addressIndex: index,
          isRegistered: true, // Assume registered if from blockchain
          hasSubmissions: false,
        });
      });
    }

    console.log(`[StakeKeyQuery] Found ${registeredAddresses.length} registered addresses`);
    return registeredAddresses;
  }
}

