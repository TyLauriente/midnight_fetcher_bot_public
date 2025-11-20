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
   * Import an existing wallet from a seed phrase
   */
  async importWallet(seedPhrase: string, password: string, count: number = 40): Promise<WalletInfo> {
    // Ensure secure directory exists
    if (!fs.existsSync(SECURE_DIR)) {
      fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }

    // Normalize seed phrase (trim and normalize whitespace)
    const normalizedSeedPhrase = seedPhrase.trim().replace(/\s+/g, ' ');
    const words = normalizedSeedPhrase.split(' ');

    // Validate word count
    if (words.length !== 24) {
      throw new Error('Seed phrase must contain exactly 24 words');
    }

    // Validate seed phrase by trying to use it with Lucid
    try {
      const tempLucid = await Lucid.new(undefined, 'Mainnet');
      tempLucid.selectWalletFromSeed(normalizedSeedPhrase, {
        accountIndex: 0,
      });
      // Try to get an address to verify the seed phrase is valid
      await tempLucid.wallet.address();
    } catch (err: any) {
      throw new Error(`Invalid seed phrase: ${err.message || 'Failed to validate seed phrase'}`);
    }

    this.mnemonic = normalizedSeedPhrase;

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
   * Derive addresses by index range (for consolidation view)
   * Requires password to decrypt seed phrase
   */
  async deriveAddressesByRange(password: string, startIndex: number, endIndex: number): Promise<DerivedAddress[]> {
    if (!fs.existsSync(SEED_FILE)) {
      throw new Error('No wallet found. Please create or import a wallet first.');
    }

    const encryptedData: EncryptedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

    try {
      const mnemonic = decrypt(encryptedData, password);
      this.mnemonic = mnemonic;
    } catch (err) {
      throw new Error('Failed to decrypt wallet. Incorrect password?');
    }

    const addresses: DerivedAddress[] = [];

    for (let i = startIndex; i <= endIndex; i++) {
      try {
        const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);
        addresses.push({
          index: i,
          bech32: address,
          publicKeyHex: pubKeyHex,
          registered: false, // Will be checked via API
        });
      } catch (err: any) {
        console.error(`Failed to derive address at index ${i}:`, err.message);
        throw err;
      }
    }

    return addresses;
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
}
