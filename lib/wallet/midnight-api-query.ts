/**
 * Midnight API Query Utility
 * 
 * Queries the Midnight mining API to find registered addresses.
 * Since registration is stored on the Midnight blockchain/API, we can query it directly!
 * 
 * This is the OPTIMAL method for finding mining addresses - queries the source of truth.
 */

import axios from 'axios';
import { WalletManager } from './manager';
import { Lucid, toHex } from 'lucid-cardano';

const MINING_API_BASE = 'https://scavenger.prod.gd.midnighttge.io';

export interface MidnightAddressInfo {
  address: string;
  addressIndex: number;
  isRegistered: boolean;
  hasSubmissions: boolean;
  submissionCount?: number;
  lastSubmissionTime?: string;
}

export class MidnightApiQuery {
  private static tandcMessage: string | null = null;
  private static tandcMessageFetched: boolean = false;

  /**
   * Check if a single address is registered with the Midnight mining API
   * Returns both registration status and whether it was newly registered
   */
  private static async checkAddressRegistrationWithResult(
    address: string,
    mnemonic: string,
    addressIndex: number,
    allowNewRegistration: boolean = false
  ): Promise<{ isRegistered: boolean; wasNewlyRegistered: boolean }> {
    try {
      // OPTIMAL METHOD: Use signature verification
      // Get T&C message and sign it, then attempt registration
      // If "already registered", we know it's registered!
      
      // Get T&C message (use cached version if available)
      if (!this.tandcMessage || !this.tandcMessageFetched) {
        const tandcResponse = await axios.get(`${MINING_API_BASE}/TandC`, {
          timeout: 5000,
        });
        
        if (!tandcResponse.data || !tandcResponse.data.message) {
          throw new Error('T&C message not found');
        }
        
        this.tandcMessage = tandcResponse.data.message;
        this.tandcMessageFetched = true;
      }
      
      if (!this.tandcMessage) {
        throw new Error('T&C message is null');
      }
      
      const message = this.tandcMessage;
      
      // Sign message with this address's private key
      const lucid = await Lucid.new(undefined, 'Mainnet');
      lucid.selectWalletFromSeed(mnemonic, {
        accountIndex: addressIndex,
      });
      
      const payload = toHex(Buffer.from(message, 'utf8'));
      const signedMessage = await lucid.wallet.signMessage(address, payload);
      const signature = signedMessage.signature;
      
      // Extract public key
      const coseKey = signedMessage.key;
      const pubKeyHex = coseKey.slice(-64);
      
      if (!pubKeyHex || pubKeyHex.length !== 64) {
        throw new Error(`Failed to extract public key for address ${addressIndex}`);
      }
      
      // Attempt to register - if "already registered", address is registered!
      try {
        const registerUrl = `${MINING_API_BASE}/register/${address}/${signature}/${pubKeyHex}`;
        const response = await axios.post(registerUrl, {}, {
          timeout: 5000,
          validateStatus: () => true, // Don't throw on any status
        });
        
        // Check for "already registered" errors
        const errorMessage = response.data?.message || response.statusText || '';
        const statusCode = response.status;
        
        const isAlreadyRegistered =
          statusCode === 400 ||
          statusCode === 409 ||
          errorMessage.toLowerCase().includes('already registered') ||
          errorMessage.toLowerCase().includes('already exists') ||
          errorMessage.toLowerCase().includes('duplicate') ||
          errorMessage.toLowerCase().includes('registered');
        
        if (isAlreadyRegistered) {
          return { isRegistered: true, wasNewlyRegistered: false }; // Address was already registered!
        }
        
        // If we get 200/201, registration succeeded (address wasn't registered)
        // NOTE: This means we just registered a new address!
        if (response.status >= 200 && response.status < 300) {
          if (!allowNewRegistration) {
            console.warn(`[MidnightApiQuery] ⚠️  Address ${address} was NOT registered, but we just registered it!`);
            console.warn(`[MidnightApiQuery] Set allowNewRegistration=true if you want to register addresses.`);
          } else {
            console.log(`[MidnightApiQuery] Address ${address} was not registered, but we just registered it.`);
          }
          return { isRegistered: false, wasNewlyRegistered: true }; // Not registered before, but we just registered it
        }
        
        // Unknown response
        return { isRegistered: false, wasNewlyRegistered: false };
      } catch (error: any) {
        // Check error message for "already registered"
        const errorMessage = error?.response?.data?.message || error?.message || '';
        if (
          errorMessage.toLowerCase().includes('already registered') ||
          errorMessage.toLowerCase().includes('already exists') ||
          errorMessage.toLowerCase().includes('duplicate')
        ) {
          return { isRegistered: true, wasNewlyRegistered: false }; // Address is registered!
        }
        return { isRegistered: false, wasNewlyRegistered: false };
      }
    } catch (error: any) {
      console.warn(`[MidnightApiQuery] Error checking registration for ${address}:`, error.message);
      
      // Fallback: Try to query endpoint (if it exists)
      try {
        const response = await axios.get(`${MINING_API_BASE}/address/${address}`, {
          timeout: 5000,
          validateStatus: () => true,
        });
        
        if (response.status === 200) {
          const data = response.data;
          if (data?.registered !== undefined) {
            return { isRegistered: data.registered === true, wasNewlyRegistered: false };
          }
          return { isRegistered: true, wasNewlyRegistered: false }; // Assume registered if we get data
        }
      } catch (e) {
        // Endpoint doesn't exist
      }
      
      return { isRegistered: false, wasNewlyRegistered: false };
    }
  }

  /**
   * Check if a single address is registered (simplified interface)
   */
  private static async checkAddressRegistration(
    address: string,
    mnemonic: string,
    addressIndex: number,
    allowNewRegistration: boolean = false
  ): Promise<boolean> {
    const result = await this.checkAddressRegistrationWithResult(
      address,
      mnemonic,
      addressIndex,
      allowNewRegistration
    );
    return result.isRegistered || result.wasNewlyRegistered;
  }

  /**
   * Get submissions/solutions for an address from Midnight API
   */
  private static async getAddressSubmissions(address: string): Promise<{
    count: number;
    lastSubmission?: string;
    challenges: string[];
  }> {
    const possibleEndpoints = [
      `${MINING_API_BASE}/address/${address}/submissions`,
      `${MINING_API_BASE}/address/${address}/solutions`,
      `${MINING_API_BASE}/solutions/${address}`,
      `${MINING_API_BASE}/address/${address}/history`,
    ];

    for (const endpoint of possibleEndpoints) {
      try {
        const response = await axios.get(endpoint, {
          timeout: 10000,
          validateStatus: () => true,
        });

        if (response.status === 200 && response.data) {
          const data = response.data;
          
          // Handle different response formats
          if (Array.isArray(data)) {
            return {
              count: data.length,
              lastSubmission: data.length > 0 ? data[data.length - 1]?.timestamp : undefined,
              challenges: [...new Set(data.map((s: any) => s.challenge_id || s.challengeId).filter(Boolean))],
            };
          }

          if (data.count !== undefined || data.submissions !== undefined || data.solutions !== undefined) {
            const submissions = data.submissions || data.solutions || [];
            return {
              count: data.count || submissions.length,
              lastSubmission: data.lastSubmission || (submissions.length > 0 ? submissions[submissions.length - 1]?.timestamp : undefined),
              challenges: data.challenges || [...new Set(submissions.map((s: any) => s.challenge_id || s.challengeId).filter(Boolean))],
            };
          }
        }
      } catch (error) {
        // Endpoint doesn't exist, try next one
        continue;
      }
    }

    // No endpoint found
    return {
      count: 0,
      challenges: [],
    };
  }

  /**
   * Query Midnight API for all registered addresses from a seed phrase
   * 
   * OPTIMAL METHOD: Uses signature verification (attempts registration)
   * - Signs T&C message with each address's private key
   * - Attempts to register each address
   * - If "already registered" error, address is registered!
   * 
   * This is the most reliable method since it uses the actual registration process.
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxCount - Maximum number of addresses to check (default: 50,000)
   * @param batchSize - Number of addresses to check in parallel (default: 5, lower to avoid rate limits)
   * @param progressCallback - Optional progress callback
   * @param actuallyRegister - If false, detects registration without registering new addresses (default: false)
   */
  static async queryRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 5, // Lower batch size for registration endpoint rate limits
    progressCallback?: (current: number, total: number, registered: number) => void,
    actuallyRegister: boolean = false // If false, we detect registration without actually registering
  ): Promise<MidnightAddressInfo[]> {
    console.log(`[MidnightApiQuery] Querying Midnight API for registered addresses...`);
    console.log(`[MidnightApiQuery] Using signature verification method (most reliable!)`);
    console.log(`[MidnightApiQuery] This signs the T&C message and attempts registration to detect registered addresses!`);

    // Generate all addresses from seed phrase
    const walletManager = new WalletManager();
    const walletInfo = await walletManager.generateWalletFromMnemonic(mnemonic, 'temp', maxCount);
    const allAddresses = walletInfo.addresses;

    console.log(`[MidnightApiQuery] Generated ${allAddresses.length} addresses from seed phrase`);
    console.log(`[MidnightApiQuery] Checking registration using signature verification...`);

    // Get T&C message once (same for all addresses)
    // Cache it to avoid fetching multiple times
    if (!this.tandcMessage || !this.tandcMessageFetched) {
      try {
        const tandcResponse = await axios.get(`${MINING_API_BASE}/TandC`, {
          timeout: 10000,
        });
        if (!tandcResponse.data || !tandcResponse.data.message) {
          throw new Error('T&C message not found in response');
        }
        this.tandcMessage = tandcResponse.data.message;
        this.tandcMessageFetched = true;
        if (this.tandcMessage) {
          console.log(`[MidnightApiQuery] Got T&C message: "${this.tandcMessage.substring(0, 50)}..."`);
        }
      } catch (error: any) {
        throw new Error(`Failed to get T&C message: ${error.message}`);
      }
    }
    
    if (!this.tandcMessage) {
      throw new Error('T&C message is null after fetch');
    }

    const registeredAddresses: MidnightAddressInfo[] = [];
    let checkedCount = 0;
    let newlyRegisteredCount = 0; // Track addresses we just registered

    // Process addresses in batches (smaller batches for registration endpoint)
    for (let i = 0; i < allAddresses.length; i += batchSize) {
      const batch = allAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (addr) => {
        try {
          // Check if address is registered using signature verification
          const registrationResult = await this.checkAddressRegistrationWithResult(
            addr.bech32,
            mnemonic,
            addr.index,
            actuallyRegister
          );
          
          const isRegistered = registrationResult.isRegistered;
          const wasNewlyRegistered = registrationResult.wasNewlyRegistered;
          
          if (wasNewlyRegistered) {
            newlyRegisteredCount++;
            if (!actuallyRegister) {
              console.warn(`[MidnightApiQuery] ⚠️  Address ${addr.index} was not registered, but we just registered it!`);
              console.warn(`[MidnightApiQuery] Set actuallyRegister=true if you want to register addresses.`);
            }
          }
          
          if (isRegistered || wasNewlyRegistered) {
            // Get submission data for registered addresses
            const submissionData = await this.getAddressSubmissions(addr.bech32);
            
            registeredAddresses.push({
              address: addr.bech32,
              addressIndex: addr.index,
              isRegistered: true, // Consider it registered if it was newly registered
              hasSubmissions: submissionData.count > 0,
              submissionCount: submissionData.count,
              lastSubmissionTime: submissionData.lastSubmission,
            });
          }

          checkedCount++;
          
          // Progress callback
          if (progressCallback && checkedCount % batchSize === 0) {
            progressCallback(checkedCount, allAddresses.length, registeredAddresses.length);
          }

          return {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered: isRegistered || wasNewlyRegistered,
          };
        } catch (error: any) {
          console.error(`[MidnightApiQuery] Error checking address ${addr.index}:`, error.message);
          checkedCount++;
          return {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered: false,
          };
        }
      });

      await Promise.all(batchPromises);

      // Rate limiting: wait longer between batches for registration endpoint
      // Registration endpoint typically has 1.5s rate limit per address
      if (i + batchSize < allAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between batches
      }

      // Log progress every 50 addresses
      if (i % 50 === 0 && i > 0) {
        console.log(`[MidnightApiQuery] Checked ${i}/${allAddresses.length} addresses, found ${registeredAddresses.length} registered (${newlyRegisteredCount} newly registered)`);
      }
    }

    console.log(`[MidnightApiQuery] Query complete:`);
    console.log(`[MidnightApiQuery]   - Total addresses checked: ${allAddresses.length}`);
    console.log(`[MidnightApiQuery]   - Registered addresses: ${registeredAddresses.length}`);
    console.log(`[MidnightApiQuery]   - Addresses with submissions: ${registeredAddresses.filter(a => a.hasSubmissions).length}`);

    return registeredAddresses;
  }

  /**
   * Get a simple list of all registered addresses (for redemption tools)
   */
  static async getRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 10
  ): Promise<string[]> {
    const addresses = await this.queryRegisteredAddresses(mnemonic, maxCount, batchSize);
    return addresses.filter(a => a.isRegistered).map(a => a.address);
  }

  /**
   * Try to discover available endpoints on the Midnight API
   * This can help us find endpoints that list registered addresses
   */
  static async discoverEndpoints(): Promise<string[]> {
    console.log('[MidnightApiQuery] Discovering available endpoints on Midnight API...');
    
    const discoveredEndpoints: string[] = [];
    const commonPaths = [
      '/addresses',
      '/registered',
      '/registrations',
      '/wallet/addresses',
      '/mining/addresses',
      '/api/addresses',
      '/api/registered',
    ];

    for (const path of commonPaths) {
      try {
        const response = await axios.get(`${MINING_API_BASE}${path}`, {
          timeout: 5000,
          validateStatus: () => true,
        });

        if (response.status === 200 || response.status === 401 || response.status === 403) {
          // 200 = exists, 401/403 = exists but requires auth
          discoveredEndpoints.push(path);
          console.log(`[MidnightApiQuery] Found endpoint: ${path} (status: ${response.status})`);
        }
      } catch (error) {
        // Endpoint doesn't exist
      }
    }

    return discoveredEndpoints;
  }
}

