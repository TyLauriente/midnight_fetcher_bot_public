import fs from 'fs';
import path from 'path';
import { Lucid, toHex } from 'lucid-cardano';
import { encrypt, decrypt, EncryptedData } from './encryption';

// Determine data directory: Check installation folder first (for existing users),
// then fall back to Documents folder (for new users and easier updates)
function determineDataDirectory(): string {
  const oldSecureDir = path.join(process.cwd(), 'secure');
  const newDataDir = path.join(
    process.env.USERPROFILE || process.env.HOME || process.cwd(),
    'Documents',
    'MidnightFetcherBot'
  );

  // Check if wallet exists in old location (installation folder)
  const oldWalletFile = path.join(oldSecureDir, 'wallet-seed.json.enc');
  if (fs.existsSync(oldWalletFile)) {
    console.log(`[Wallet] Found existing wallet in installation folder`);
    console.log(`[Wallet] Using: ${path.join(process.cwd(), 'secure')}`);
    return process.cwd();
  }

  // Otherwise use Documents folder (new default)
  console.log(`[Wallet] Using Documents folder: ${newDataDir}`);
  return newDataDir;
}

const DATA_DIR = determineDataDirectory();
const SECURE_DIR = path.join(DATA_DIR, 'secure');
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
  async generateWallet(password: string, count: number = 40): Promise<WalletInfo> {
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
   * Load existing wallet from encrypted file
   */
  async loadWallet(password: string): Promise<DerivedAddress[]> {
    if (!fs.existsSync(SEED_FILE)) {
      throw new Error('No wallet found. Please create a new wallet first.');
    }

    const encryptedData: EncryptedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

    try {
      this.mnemonic = decrypt(encryptedData, password);
    } catch (err) {
      throw new Error('Failed to decrypt wallet. Incorrect password?');
    }

    // Load derived addresses if they exist
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      this.derivedAddresses = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));
    } else {
      throw new Error('Derived addresses file not found. Wallet may be corrupted.');
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
   * Mark address as registered
   */
  markAddressRegistered(index: number): void {
    const addr = this.derivedAddresses.find(a => a.index === index);
    if (addr) {
      addr.registered = true;
      // Save updated addresses
      fs.writeFileSync(
        DERIVED_ADDRESSES_FILE,
        JSON.stringify(this.derivedAddresses, null, 2),
        { mode: 0o600 }
      );
    }
  }

  /**
   * Create donation signature for consolidating rewards
   * Signs the message: "donate_to:{destinationAddress}"
   */
  async makeDonationSignature(addressIndex: number, sourceAddress: string, destinationAddress: string): Promise<string> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const addr = this.derivedAddresses.find(a => a.index === addressIndex);
    if (!addr) {
      throw new Error(`Address not found for index ${addressIndex}`);
    }

    if (addr.bech32 !== sourceAddress) {
      throw new Error(`Address mismatch: expected ${addr.bech32}, got ${sourceAddress}`);
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: addressIndex,
    });

    const message = `Assign accumulated Scavenger rights to: ${destinationAddress}`;
    const payload = toHex(Buffer.from(message, 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(sourceAddress, payload);

    return signedMessage.signature;
  }
  /**
   * Expands the derived addresses of the wallet to a newCount.
   * Only adds addresses; never alters or removes ones with registered=true
   */
  async expandAddresses(password: string, newCount: number): Promise<void> {
    if (!fs.existsSync(SEED_FILE)) throw new Error('No wallet found');
    const encryptedData: EncryptedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    this.mnemonic = decrypt(encryptedData, password);
    if (!this.mnemonic) throw new Error('Mnemonic decrypt failed');
    // Load existing addresses
    let addresses: DerivedAddress[] = [];
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      addresses = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));
    }
    // Add up to newCount
    const toAdd = newCount - addresses.length;
    if (toAdd <= 0) return; // Nothing to do
    for (let i = addresses.length; i < newCount; i++) {
      const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);
      addresses.push({
        index: i,
        bech32: address,
        publicKeyHex: pubKeyHex,
        registered: false,
      });
    }
    fs.writeFileSync(DERIVED_ADDRESSES_FILE, JSON.stringify(addresses, null, 2), { mode: 0o600 });
    this.derivedAddresses = addresses;
  }

  /**
   * Truncates derived addresses to newCount (cannot remove any with registered=true)
   */
  async truncateAddresses(newCount: number): Promise<void> {
    if (!fs.existsSync(DERIVED_ADDRESSES_FILE)) throw new Error('Addresses file missing');
    let addresses: DerivedAddress[] = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));
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
    const encryptedData: EncryptedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    this.mnemonic = decrypt(encryptedData, password);
    if (!this.mnemonic) throw new Error('Mnemonic decrypt failed');
    let addresses: DerivedAddress[] = [];
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      addresses = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));
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
