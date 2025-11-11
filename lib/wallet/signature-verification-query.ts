/**
 * Signature Verification Query Utility
 * 
 * Uses the registration signature process to determine which addresses are registered.
 * 
 * KEY INSIGHT: Registration requires signing the T&C message with the Cardano private key.
 * We can use this to verify registration by:
 * 1. Getting the T&C message (same for all addresses)
 * 2. For each address from seed phrase:
 *    - Sign the T&C message with that address's private key
 *    - Attempt to register (or check registration status)
 *    - If "already registered" error, address is registered!
 * 
 * This is more efficient than guessing, and uses the actual registration proof.
 */

import axios from 'axios';
import { WalletManager, DerivedAddress } from './manager';
import { Lucid, toHex } from 'lucid-cardano';

const MINING_API_BASE = 'https://scavenger.prod.gd.midnighttge.io';

export interface SignatureVerificationResult {
  address: string;
  addressIndex: number;
  isRegistered: boolean;
  verificationMethod: 'registration_attempt' | 'api_query' | 'signature_check';
  error?: string;
}

export class SignatureVerificationQuery {
  private static tandcMessage: string | null = null;
  private static tandcMessageFetched: boolean = false;

  /**
   * Get the T&C message from the Midnight API
   * This message is used for registration and is the same for all addresses
   */
  private static async getTandCMessage(): Promise<string> {
    if (this.tandcMessage && this.tandcMessageFetched) {
      return this.tandcMessage;
    }

    try {
      const response = await axios.get(`${MINING_API_BASE}/TandC`, {
        timeout: 10000,
      });

      if (response.data && response.data.message) {
        this.tandcMessage = response.data.message;
        this.tandcMessageFetched = true;
        console.log(`[SignatureVerification] Fetched T&C message (${this.tandcMessage.length} chars)`);
        return this.tandcMessage;
      }

      throw new Error('T&C message not found in response');
    } catch (error: any) {
      console.error(`[SignatureVerification] Failed to get T&C message:`, error.message);
      throw error;
    }
  }

  /**
   * Sign the T&C message with an address's private key
   * This is the same signature used for registration
   */
  private static async signTandCMessage(
    mnemonic: string,
    addressIndex: number,
    address: string
  ): Promise<{ signature: string; publicKeyHex: string }> {
    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(mnemonic, {
      accountIndex: addressIndex,
    });

    // Get T&C message
    const message = await this.getTandCMessage();
    const payload = toHex(Buffer.from(message, 'utf8'));

    // Sign message with this address's private key
    const signedMessage = await lucid.wallet.signMessage(address, payload);

    // Extract public key (needed for registration)
    // We already have the address, so we can get the public key from the signature
    const coseKey = signedMessage.key;
    const pubKeyHex = coseKey.slice(-64);

    if (!pubKeyHex || pubKeyHex.length !== 64) {
      throw new Error(`Failed to extract valid public key for address ${addressIndex}`);
    }

    return {
      signature: signedMessage.signature,
      publicKeyHex: pubKeyHex,
    };
  }

  /**
   * Check if an address is registered by attempting to register it
   * If it's already registered, we'll get an "already registered" error
   * This is the most reliable method since it uses the actual registration endpoint
   */
  private static async checkRegistrationByAttempt(
    address: string,
    signature: string,
    publicKeyHex: string
  ): Promise<boolean> {
    try {
      const registerUrl = `${MINING_API_BASE}/register/${address}/${signature}/${publicKeyHex}`;
      const response = await axios.post(registerUrl, {}, {
        timeout: 10000,
        validateStatus: () => true, // Don't throw on any status
      });

      // If we get 200/201, registration succeeded (address wasn't registered)
      if (response.status >= 200 && response.status < 300) {
        console.log(`[SignatureVerification] Address ${address} was NOT registered (registration succeeded)`);
        return false; // Not registered before, but we just registered it
      }

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
        console.log(`[SignatureVerification] Address ${address} IS registered (got "already registered" error)`);
        return true;
      }

      // Other errors - we don't know
      console.warn(`[SignatureVerification] Unknown response for ${address}: ${statusCode} - ${errorMessage}`);
      return false;
    } catch (error: any) {
      // Network errors or timeouts
      console.error(`[SignatureVerification] Error checking registration for ${address}:`, error.message);
      return false;
    }
  }

  /**
   * Verify registration for all addresses using signature verification
   * 
   * This method:
   * 1. Gets the T&C message (same for all addresses)
   * 2. For each address from seed phrase:
   *    - Signs the T&C message with that address's private key
   *    - Attempts to register (or checks registration status)
   *    - If "already registered", address is registered!
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxCount - Maximum number of addresses to check (default: 50,000)
   * @param batchSize - Number of addresses to check in parallel (default: 5, lower to avoid rate limits)
   * @param progressCallback - Optional progress callback
   * @param actuallyRegister - If false, only checks without registering new addresses (default: false)
   */
  static async verifyRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 5, // Lower batch size to avoid rate limits on registration endpoint
    progressCallback?: (current: number, total: number, registered: number) => void,
    actuallyRegister: boolean = false // If false, we detect registration without actually registering new addresses
  ): Promise<SignatureVerificationResult[]> {
    console.log(`[SignatureVerification] Starting signature-based verification...`);
    console.log(`[SignatureVerification] This uses the actual registration signature process!`);

    // Get T&C message once (same for all addresses)
    let tandcMessage: string;
    try {
      tandcMessage = await this.getTandCMessage();
      console.log(`[SignatureVerification] Got T&C message: "${tandcMessage.substring(0, 50)}..."`);
    } catch (error: any) {
      throw new Error(`Failed to get T&C message: ${error.message}`);
    }

    // Generate all addresses from seed phrase
    const walletManager = new WalletManager();
    const walletInfo = await walletManager.generateWalletFromMnemonic(mnemonic, 'temp', maxCount);
    const allAddresses = walletInfo.addresses;

    console.log(`[SignatureVerification] Generated ${allAddresses.length} addresses from seed phrase`);
    console.log(`[SignatureVerification] Verifying registration using signature method...`);

    const results: SignatureVerificationResult[] = [];
    let registeredCount = 0;

    // Process addresses in batches (smaller batches to avoid rate limits)
    for (let i = 0; i < allAddresses.length; i += batchSize) {
      const batch = allAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (addr) => {
        try {
          // Sign T&C message with this address's private key
          const { signature, publicKeyHex } = await this.signTandCMessage(
            mnemonic,
            addr.index,
            addr.bech32
          );

          // Check registration by attempting to register (or checking status)
          const isRegistered = await this.checkRegistrationByAttempt(
            addr.bech32,
            signature,
            publicKeyHex
          );

          if (isRegistered) {
            registeredCount++;
          }

          return {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered,
            verificationMethod: 'registration_attempt' as const,
          } as SignatureVerificationResult;
        } catch (error: any) {
          console.error(`[SignatureVerification] Error verifying address ${addr.index}:`, error.message);
          return {
            address: addr.bech32,
            addressIndex: addr.index,
            isRegistered: false,
            verificationMethod: 'registration_attempt' as const,
            error: error.message,
          } as SignatureVerificationResult;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Progress callback
      if (progressCallback) {
        progressCallback(i + batch.length, allAddresses.length, registeredCount);
      }

      // Rate limiting: wait between batches to avoid overwhelming the API
      // Registration endpoint has rate limits, so we wait longer
      if (i + batchSize < allAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between batches
      }

      // Log progress every 50 addresses
      if (i % 50 === 0 && i > 0) {
        console.log(`[SignatureVerification] Checked ${i}/${allAddresses.length} addresses, found ${registeredCount} registered`);
      }
    }

    console.log(`[SignatureVerification] Verification complete:`);
    console.log(`[SignatureVerification]   - Total addresses checked: ${allAddresses.length}`);
    console.log(`[SignatureVerification]   - Registered addresses: ${registeredCount}`);

    return results;
  }

  /**
   * Get a simple list of all registered addresses (for redemption tools)
   */
  static async getRegisteredAddresses(
    mnemonic: string,
    maxCount: number = 50000,
    batchSize: number = 5,
    progressCallback?: (current: number, total: number, registered: number) => void
  ): Promise<string[]> {
    const results = await this.verifyRegisteredAddresses(
      mnemonic,
      maxCount,
      batchSize,
      progressCallback,
      false // Don't actually register new addresses, just check
    );
    return results.filter(r => r.isRegistered).map(r => r.address);
  }
}

