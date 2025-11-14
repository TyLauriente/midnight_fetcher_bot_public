import fs from 'fs';
import path from 'path';
import { Lucid, toHex } from 'lucid-cardano';
import { encrypt, decrypt, EncryptedData } from './encryption';

const SECURE_DIR = path.join(process.cwd(), 'secure');
const SEED_FILE = path.join(SECURE_DIR, 'wallet-seed.json.enc');
const DERIVED_ADDRESSES_FILE = path.join(SECURE_DIR, 'derived-addresses.json');

export interface DerivedAddress {
  index: number;
  bech32: string;
  publicKeyHex: string;
  registered?: boolean;
}

export interface WalletInfo {
  seedPhrase: string;
  addresses: DerivedAddress[];
}

export class WalletManager {
  private mnemonic: string | null = null;
  private derivedAddresses: DerivedAddress[] = [];

  /**
   * Generate a new wallet with 24-word seed phrase
   */
  async generateWallet(password: string, count: number = 200): Promise<WalletInfo> {
    // Ensure secure directory exists
    if (!fs.existsSync(SECURE_DIR)) {
      fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }

    // Generate 24-word mnemonic using Lucid
    const tempLucid = await Lucid.new(undefined, 'Mainnet');
    this.mnemonic = tempLucid.utils.generateSeedPhrase();
    const words = this.mnemonic.split(' ');

    if (words.length !== 24) {
      throw new Error('Failed to generate 24-word mnemonic');
    }

    // Derive addresses
    await this.deriveAddresses(count);

    // Encrypt and save seed
    const encryptedData = encrypt(this.mnemonic, password);
    fs.writeFileSync(SEED_FILE, JSON.stringify(encryptedData, null, 2), { mode: 0o600 });

    // Save derived addresses
    fs.writeFileSync(
      DERIVED_ADDRESSES_FILE,
      JSON.stringify(this.derivedAddresses, null, 2),
      { mode: 0o600 }
    );

    return {
      seedPhrase: this.mnemonic,
      addresses: this.derivedAddresses,
    };
  }

  /**
   * Create a wallet using a user-provided 24-word mnemonic (for import)
   */
  async generateWalletFromMnemonic(mnemonic: string, password: string, count: number = 200): Promise<WalletInfo> {
    // Ensure secure directory exists
    if (!fs.existsSync(SECURE_DIR)) {
      fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }
    const words = mnemonic.trim().replace(/\s+/g, ' ').split(' ');
    if (words.length !== 24) {
      throw new Error('Provided seed phrase must be 24 words');
    }
    this.mnemonic = words.join(' ');
    await this.deriveAddresses(count);
    // Encrypt and save seed
    const encryptedData = encrypt(this.mnemonic, password);
    fs.writeFileSync(SEED_FILE, JSON.stringify(encryptedData, null, 2), { mode: 0o600 });
    // Save derived addresses
    fs.writeFileSync(
      DERIVED_ADDRESSES_FILE,
      JSON.stringify(this.derivedAddresses, null, 2),
      { mode: 0o600 }
    );
    return {
      seedPhrase: this.mnemonic,
      addresses: this.derivedAddresses,
    };
  }

  /**
   * Load existing wallet from encrypted file
   */
  async loadWallet(password: string): Promise<DerivedAddress[]> {
    if (!fs.existsSync(SEED_FILE)) {
      throw new Error('No wallet found. Please create a new wallet first.');
    }

    // CRITICAL: Check if file is empty or read file content safely
    const seedFileContent = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (!seedFileContent || seedFileContent.length === 0) {
      throw new Error('Wallet seed file is empty or corrupted. Please create a new wallet.');
    }

    let encryptedData: EncryptedData;
    try {
      encryptedData = JSON.parse(seedFileContent);
    } catch (err: any) {
      throw new Error(`Failed to parse wallet seed file: ${err.message}. The file may be corrupted.`);
    }

    try {
      this.mnemonic = decrypt(encryptedData, password);
    } catch (err) {
      throw new Error('Failed to decrypt wallet. Incorrect password?');
    }

    // Load derived addresses if they exist, or regenerate if file is empty/corrupted
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      // CRITICAL: Check if file is empty before parsing
      const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
      if (!addressesFileContent || addressesFileContent.length === 0) {
        console.warn('[WalletManager] Derived addresses file is empty. Regenerating addresses...');
        // Regenerate addresses (default to 200 addresses)
        await this.deriveAddresses(200);
        // Save regenerated addresses to disk
        fs.writeFileSync(
          DERIVED_ADDRESSES_FILE,
          JSON.stringify(this.derivedAddresses, null, 2),
          { mode: 0o600 }
        );
        console.log(`[WalletManager] ✓ Regenerated ${this.derivedAddresses.length} addresses`);
        return this.derivedAddresses;
      }

      let parsedAddresses: DerivedAddress[];
      try {
        const parsed = JSON.parse(addressesFileContent);
        // Validate that we got an array
        if (!Array.isArray(parsed)) {
          throw new Error('File does not contain a valid array');
        }
        parsedAddresses = parsed as DerivedAddress[];
      } catch (err: any) {
        console.warn(`[WalletManager] Failed to parse derived addresses file: ${err.message}. Regenerating addresses...`);
        // Regenerate addresses if parsing fails or not an array
        await this.deriveAddresses(200);
        // Save regenerated addresses to disk
        fs.writeFileSync(
          DERIVED_ADDRESSES_FILE,
          JSON.stringify(this.derivedAddresses, null, 2),
          { mode: 0o600 }
        );
        console.log(`[WalletManager] ✓ Regenerated ${this.derivedAddresses.length} addresses`);
        return this.derivedAddresses;
      }

      // Use parsed addresses
      this.derivedAddresses = parsedAddresses;

      // Validate array is not empty
      if (this.derivedAddresses.length === 0) {
        console.warn('[WalletManager] Derived addresses array is empty. Regenerating addresses...');
        // Regenerate addresses if array is empty
        await this.deriveAddresses(200);
        // Save regenerated addresses to disk
        fs.writeFileSync(
          DERIVED_ADDRESSES_FILE,
          JSON.stringify(this.derivedAddresses, null, 2),
          { mode: 0o600 }
        );
        console.log(`[WalletManager] ✓ Regenerated ${this.derivedAddresses.length} addresses`);
        return this.derivedAddresses;
      }
    } else {
      console.warn('[WalletManager] Derived addresses file not found. Regenerating addresses...');
      // Regenerate addresses if file doesn't exist
      await this.deriveAddresses(200);
      // Save regenerated addresses to disk
      fs.writeFileSync(
        DERIVED_ADDRESSES_FILE,
        JSON.stringify(this.derivedAddresses, null, 2),
        { mode: 0o600 }
      );
      console.log(`[WalletManager] ✓ Regenerated ${this.derivedAddresses.length} addresses`);
    }

    return this.derivedAddresses;
  }

  /**
   * Check if wallet exists
   */
  walletExists(): boolean {
    return fs.existsSync(SEED_FILE);
  }

  /**
   * Derive addresses from mnemonic
   */
  private async deriveAddresses(count: number): Promise<void> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    this.derivedAddresses = [];

    for (let i = 0; i < count; i++) {
      try {
        const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);

        this.derivedAddresses.push({
          index: i,
          bech32: address,
          publicKeyHex: pubKeyHex,
          registered: false,
        });
      } catch (err: any) {
        console.error(`Failed to derive address at index ${i}:`, err.message);
        throw err;
      }
    }
  }

  /**
   * Derive a single address at specific index
   */
  private async deriveAddressAtIndex(index: number): Promise<{ address: string; pubKeyHex: string }> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: index,
    });

    const address = await lucid.wallet.address();

    // Get public key by signing a test message
    const testPayload = toHex(Buffer.from('test', 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(address, testPayload);

    // Extract 32-byte public key from COSE_Key structure
    const coseKey = signedMessage.key;
    const pubKeyHex = coseKey.slice(-64);

    if (!pubKeyHex || pubKeyHex.length !== 64) {
      throw new Error(`Failed to extract valid public key for index ${index}`);
    }

    return { address, pubKeyHex };
  }

  /**
   * Sign a message with specific address
   */
  async signMessage(addressIndex: number, message: string): Promise<string> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const addr = this.derivedAddresses.find(a => a.index === addressIndex);
    if (!addr) {
      throw new Error(`Address not found for index ${addressIndex}`);
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: addressIndex,
    });

    const payload = toHex(Buffer.from(message, 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(addr.bech32, payload);

    return signedMessage.signature;
  }

  /**
   * Get all derived addresses
   */
  getDerivedAddresses(): DerivedAddress[] {
    return this.derivedAddresses;
  }

  /**
   * Get public key for specific address index
   */
  getPubKeyHex(index: number): string {
    const addr = this.derivedAddresses.find(a => a.index === index);
    if (!addr) {
      throw new Error(`Address not found for index ${index}`);
    }
    return addr.publicKeyHex;
  }

  /**
   * Check if an address is registered in persistent storage
   * This is a lightweight check that reads directly from disk without loading the full wallet
   */
  isAddressRegistered(index: number): boolean {
    if (!fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      return false;
    }
    
    try {
      const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
      if (!addressesFileContent || addressesFileContent.length === 0) {
        return false;
      }
      
      const addresses: DerivedAddress[] = JSON.parse(addressesFileContent);
      if (!Array.isArray(addresses)) {
        return false;
      }
      
      const addr = addresses.find(a => a.index === index);
      return addr?.registered === true;
    } catch (err: any) {
      console.warn(`[WalletManager] Failed to check registration status for address ${index}: ${err.message}`);
      // Fallback to in-memory check
      const inMemoryAddr = this.derivedAddresses.find(a => a.index === index);
      return inMemoryAddr?.registered === true;
    }
  }

  markAddressRegistered(index: number): void {
    // Reload addresses from disk to ensure we have the latest state
    let addresses: DerivedAddress[] = [];
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      try {
        const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
        if (addressesFileContent && addressesFileContent.length > 0) {
          addresses = JSON.parse(addressesFileContent);
          if (!Array.isArray(addresses)) {
            throw new Error('Derived addresses file does not contain a valid array');
          }
        } else {
          throw new Error('Derived addresses file is empty');
        }
      } catch (err: any) {
        console.warn(`[WalletManager] Failed to reload addresses for registration: ${err.message}`);
        addresses = this.derivedAddresses;
      }
    } else {
      addresses = this.derivedAddresses;
    }
    
    // Find and update the address
    const addr = addresses.find(a => a.index === index);
    if (addr) {
      addr.registered = true;
      // Update in-memory list too
      const inMemoryAddr = this.derivedAddresses.find(a => a.index === index);
      if (inMemoryAddr) {
        inMemoryAddr.registered = true;
      }
      
      // Save updated addresses to disk
      fs.writeFileSync(
        DERIVED_ADDRESSES_FILE,
        JSON.stringify(addresses, null, 2),
        { mode: 0o600 }
      );
      
      // Update in-memory list to match disk
      this.derivedAddresses = addresses;
    } else {
      console.warn(`[WalletManager] Address ${index} not found when marking as registered`);
    }
  }

  /**
   * Expands the derived addresses of the wallet to a newCount.
   * Only adds addresses; never alters or removes ones with registered=true
   */
  async expandAddresses(password: string, newCount: number): Promise<void> {
    if (!fs.existsSync(SEED_FILE)) throw new Error('No wallet found');
    
    // CRITICAL: Check if file is empty before parsing
    const seedFileContent = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (!seedFileContent || seedFileContent.length === 0) {
      throw new Error('Wallet seed file is empty or corrupted.');
    }

    let encryptedData: EncryptedData;
    try {
      encryptedData = JSON.parse(seedFileContent);
    } catch (err: any) {
      throw new Error(`Failed to parse wallet seed file: ${err.message}`);
    }

    this.mnemonic = decrypt(encryptedData, password);
    if (!this.mnemonic) throw new Error('Mnemonic decrypt failed');
    
    // Load existing addresses
    let addresses: DerivedAddress[] = [];
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
      if (addressesFileContent && addressesFileContent.length > 0) {
        try {
          addresses = JSON.parse(addressesFileContent);
          if (!Array.isArray(addresses)) {
            throw new Error('Derived addresses file does not contain a valid array');
          }
        } catch (err: any) {
          console.warn(`[WalletManager] Failed to parse existing addresses file: ${err.message}. Starting fresh.`);
          addresses = [];
        }
      }
    }
    // CRITICAL: Validate existing addresses have correct indices before expanding
    // This prevents corruption when expanding
    if (addresses.length > 0) {
      // Check for missing or duplicate indices
      const indices = new Set(addresses.map(a => a.index));
      const maxIndex = Math.max(...addresses.map(a => a.index));
      
      // Verify indices are sequential starting from 0
      let hasGaps = false;
      let hasDuplicates = false;
      const indexCounts = new Map<number, number>();
      
      for (const addr of addresses) {
        const count = (indexCounts.get(addr.index) || 0) + 1;
        indexCounts.set(addr.index, count);
        if (count > 1) hasDuplicates = true;
      }
      
      for (let i = 0; i < addresses.length; i++) {
        if (!indices.has(i)) {
          hasGaps = true;
          break;
        }
      }
      
      if (hasGaps || hasDuplicates || maxIndex >= addresses.length) {
        console.warn(`[WalletManager] ⚠️  Address file has invalid indices (gaps: ${hasGaps}, duplicates: ${hasDuplicates}, maxIndex: ${maxIndex}). Regenerating from scratch...`);
        // Regenerate all addresses from scratch to fix corruption
        addresses = [];
        await this.deriveAddresses(newCount);
        addresses = this.derivedAddresses;
      } else {
        // Indices are valid, just add missing addresses
        const toAdd = newCount - addresses.length;
        if (toAdd <= 0) {
          // Nothing to add, but ensure we have the correct count
          this.derivedAddresses = addresses;
          return;
        }
        
        // Add missing addresses starting from the current length
        for (let i = addresses.length; i < newCount; i++) {
          const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);
          addresses.push({
            index: i,
            bech32: address,
            publicKeyHex: pubKeyHex,
            registered: false,
          });
        }
      }
    } else {
      // No existing addresses, generate all from scratch
      await this.deriveAddresses(newCount);
      addresses = this.derivedAddresses;
    }
    
    // CRITICAL: Final validation - ensure all addresses have correct sequential indices
    const finalIndices = addresses.map(a => a.index).sort((a, b) => a - b);
    for (let i = 0; i < addresses.length; i++) {
      if (finalIndices[i] !== i) {
        console.error(`[WalletManager] ❌ CRITICAL: Address validation failed after expansion. Index ${finalIndices[i]} at position ${i}, expected ${i}`);
        throw new Error(`Address expansion failed: Invalid address indices detected. Expected sequential indices 0-${addresses.length - 1}, but found index ${finalIndices[i]} at position ${i}.`);
      }
    }
    
    fs.writeFileSync(DERIVED_ADDRESSES_FILE, JSON.stringify(addresses, null, 2), { mode: 0o600 });
    this.derivedAddresses = addresses;
  }

  /**
   * Truncates derived addresses to newCount (cannot remove any with registered=true)
   */
  async truncateAddresses(newCount: number): Promise<void> {
    if (!fs.existsSync(DERIVED_ADDRESSES_FILE)) throw new Error('Addresses file missing');
    
    // CRITICAL: Check if file is empty before parsing
    const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
    if (!addressesFileContent || addressesFileContent.length === 0) {
      throw new Error('Derived addresses file is empty or corrupted.');
    }

    let addresses: DerivedAddress[];
    try {
      addresses = JSON.parse(addressesFileContent);
      if (!Array.isArray(addresses)) {
        throw new Error('Derived addresses file does not contain a valid array');
      }
    } catch (err: any) {
      throw new Error(`Failed to parse derived addresses file: ${err.message}`);
    }
    const numRegistered = addresses.filter((a) => a.registered).length;
    if (newCount < numRegistered) throw new Error(`Cannot truncate below ${numRegistered} registered addresses`);
    addresses = addresses.slice(0, newCount);
    fs.writeFileSync(DERIVED_ADDRESSES_FILE, JSON.stringify(addresses, null, 2), { mode: 0o600 });
    this.derivedAddresses = addresses;
  }

  /**
   * Fill in any missing indices from 0..targetCount-1 in derived addresses (with retries).
   */
  async fillMissingAddresses(password: string, targetCount: number): Promise<number> {
    if (!fs.existsSync(SEED_FILE)) throw new Error('No wallet found');
    
    // CRITICAL: Check if file is empty before parsing
    const seedFileContent = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (!seedFileContent || seedFileContent.length === 0) {
      throw new Error('Wallet seed file is empty or corrupted.');
    }

    let encryptedData: EncryptedData;
    try {
      encryptedData = JSON.parse(seedFileContent);
    } catch (err: any) {
      throw new Error(`Failed to parse wallet seed file: ${err.message}`);
    }

    this.mnemonic = decrypt(encryptedData, password);
    if (!this.mnemonic) throw new Error('Mnemonic decrypt failed');
    
    let addresses: DerivedAddress[] = [];
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      const addressesFileContent = fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8').trim();
      if (addressesFileContent && addressesFileContent.length > 0) {
        try {
          addresses = JSON.parse(addressesFileContent);
          if (!Array.isArray(addresses)) {
            throw new Error('Derived addresses file does not contain a valid array');
          }
        } catch (err: any) {
          console.warn(`[WalletManager] Failed to parse existing addresses file: ${err.message}. Starting fresh.`);
          addresses = [];
        }
      }
    }
    // Fill missing indices
    const indexMap = new Map<number, DerivedAddress>();
    for (const addr of addresses) {
      indexMap.set(addr.index, addr);
    }
    let changed = false;
    for (let i = 0; i < targetCount; i++) {
      if (!indexMap.has(i)) {
        // Attempt with retries
        let success = false;
        let addressObj: DerivedAddress | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);
            addressObj = {
              index: i,
              bech32: address,
              publicKeyHex: pubKeyHex,
              registered: false,
            };
            success = true;
            break;
          } catch (err) {
            console.error(`Retry ${attempt+1}: Failed to derive address at index ${i}:`, (err as Error).message);
          }
        }
        if (success && addressObj) {
          indexMap.set(i, addressObj);
          changed = true;
        } else {
          throw new Error(`Could not derive address at index ${i} after 3 attempts.`);
        }
      }
    }
    if (changed) {
      // Resort and save
      const fullArr: DerivedAddress[] = Array.from(indexMap.values()).sort((a, b) => a.index - b.index);
      fs.writeFileSync(DERIVED_ADDRESSES_FILE, JSON.stringify(fullArr, null, 2), { mode: 0o600 });
      this.derivedAddresses = fullArr;
      return fullArr.length;
    }
    // No change (nothing was missing)
    this.derivedAddresses = addresses.sort((a, b) => a.index - b.index);
    return addresses.length;
  }
}
