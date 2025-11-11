/**
 * Address Reconstructor
 * 
 * Utility to reconstruct which addresses were mined from a seed phrase.
 * 
 * TWO MODES:
 * 1. With receipts file(s) - Fast, accurate, requires local files
 * 2. Without cache files - Queries blockchain/API directly (slower but no files needed)
 * 
 * This is useful for redemption tools that need to know all addresses that were used for mining.
 */

import { WalletManager, DerivedAddress } from './manager';
import { receiptsLogger, Receipt } from '../storage/receipts-logger';
import { BlockchainQuery, WalletMiningStats } from './blockchain-query';
import * as fs from 'fs';
import * as path from 'path';

export interface MinedAddressInfo {
  address: string;
  addressIndex: number;
  solutionCount: number;
  firstSolutionTime?: string;
  lastSolutionTime?: string;
  challenges: string[]; // Unique challenge IDs this address solved
}

export interface AddressReconstructionResult {
  totalAddressesGenerated: number;
  addressesWithSolutions: MinedAddressInfo[];
  addressesWithoutSolutions: DerivedAddress[];
  receiptsFileExists: boolean;
  receiptsFileLocation: string;
}

export class AddressReconstructor {
  /**
   * Reconstruct all mined addresses from seed phrase and receipts
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxAddressCount - Maximum number of addresses to generate (should match what was configured during mining)
   * @param receiptsFilePath - Optional path to receipts file (defaults to storage/receipts.jsonl)
   * @returns Information about which addresses were mined
   */
  static async reconstructMinedAddresses(
    mnemonic: string,
    maxAddressCount: number,
    receiptsFilePath?: string
  ): Promise<AddressReconstructionResult> {
    // Generate all addresses from seed phrase
    const walletManager = new WalletManager();
    const walletInfo = await walletManager.generateWalletFromMnemonic(mnemonic, 'temp', maxAddressCount);
    const allAddresses = walletInfo.addresses;

    // Determine receipts file path
    const receiptsFile = receiptsFilePath || path.join(process.cwd(), 'storage', 'receipts.jsonl');
    const receiptsFileExists = fs.existsSync(receiptsFile);

    // Read receipts if file exists
    let receipts: Receipt[] = [];
    if (receiptsFileExists) {
      // If custom path provided, read directly
      if (receiptsFilePath) {
        try {
          const content = fs.readFileSync(receiptsFilePath, 'utf8');
          const lines = content.trim().split('\n').filter(line => line.length > 0);
          receipts = lines.map(line => {
            try {
              return JSON.parse(line);
            } catch (e) {
              return null;
            }
          }).filter(r => r !== null) as Receipt[];
        } catch (error) {
          console.error(`[AddressReconstructor] Failed to read receipts from ${receiptsFilePath}:`, error);
        }
      } else {
        // Use receiptsLogger singleton
        receipts = receiptsLogger.readReceipts();
      }
    }

    // Filter out dev fee receipts
    const userReceipts = receipts.filter(r => !r.isDevFee);

    // Build map of addresses with solutions
    const addressSolutionMap = new Map<string, {
      count: number;
      firstTime?: string;
      lastTime?: string;
      challenges: Set<string>;
    }>();

    userReceipts.forEach(receipt => {
      const addr = receipt.address;
      if (!addressSolutionMap.has(addr)) {
        addressSolutionMap.set(addr, {
          count: 0,
          challenges: new Set(),
        });
      }

      const info = addressSolutionMap.get(addr)!;
      info.count++;
      if (receipt.challenge_id) {
        info.challenges.add(receipt.challenge_id);
      }
      
      // Track first and last solution times
      if (!info.firstTime || receipt.ts < info.firstTime) {
        info.firstTime = receipt.ts;
      }
      if (!info.lastTime || receipt.ts > info.lastTime) {
        info.lastTime = receipt.ts;
      }
    });

    // Build result
    const addressesWithSolutions: MinedAddressInfo[] = [];
    const addressesWithoutSolutions: DerivedAddress[] = [];

    allAddresses.forEach(addr => {
      const solutionInfo = addressSolutionMap.get(addr.bech32);
      
      if (solutionInfo && solutionInfo.count > 0) {
        addressesWithSolutions.push({
          address: addr.bech32,
          addressIndex: addr.index,
          solutionCount: solutionInfo.count,
          firstSolutionTime: solutionInfo.firstTime,
          lastSolutionTime: solutionInfo.lastTime,
          challenges: Array.from(solutionInfo.challenges),
        });
      } else {
        addressesWithoutSolutions.push(addr);
      }
    });

    // Sort by address index
    addressesWithSolutions.sort((a, b) => a.addressIndex - b.addressIndex);
    addressesWithoutSolutions.sort((a, b) => a.index - b.index);

    return {
      totalAddressesGenerated: allAddresses.length,
      addressesWithSolutions,
      addressesWithoutSolutions,
      receiptsFileExists,
      receiptsFileLocation: receiptsFile,
    };
  }

  /**
   * Get a simple list of all addresses that have solutions (for redemption tools)
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxAddressCount - Maximum number of addresses to check
   * @param receiptsFilePath - Optional path to receipts file (if not provided, queries blockchain)
   * @param useBlockchain - If true and no receipts file, queries blockchain/API instead
   * @returns Array of bech32 addresses that have solutions
   */
  static async getMinedAddresses(
    mnemonic: string,
    maxAddressCount: number,
    receiptsFilePath?: string,
    useBlockchain: boolean = true
  ): Promise<string[]> {
    // If receipts file provided, use it
    if (receiptsFilePath && fs.existsSync(receiptsFilePath)) {
      const result = await this.reconstructMinedAddresses(mnemonic, maxAddressCount, receiptsFilePath);
      return result.addressesWithSolutions.map(a => a.address);
    }

    // If no receipts file but blockchain query enabled, use blockchain
    if (useBlockchain) {
      console.log('[AddressReconstructor] No receipts file found, querying blockchain/API...');
      return await BlockchainQuery.getAddressesWithSubmissions(mnemonic, maxAddressCount);
    }

    // Fallback: return empty if no receipts and blockchain disabled
    console.warn('[AddressReconstructor] No receipts file and blockchain query disabled - cannot determine mined addresses');
    return [];
  }

  /**
   * Reconstruct mined addresses WITHOUT any cache files (pure blockchain query)
   * 
   * @param mnemonic - 24-word seed phrase
   * @param maxAddressCount - Maximum number of addresses to check
   * @param batchSize - Number of addresses to query in parallel (default: 10)
   * @param progressCallback - Optional progress callback
   * @returns Complete mining stats from blockchain/API
   */
  static async reconstructFromBlockchain(
    mnemonic: string,
    maxAddressCount: number,
    batchSize: number = 10,
    progressCallback?: (current: number, total: number, registered: number) => void
  ): Promise<WalletMiningStats> {
    return await BlockchainQuery.queryRegisteredAddresses(
      mnemonic,
      maxAddressCount,
      batchSize,
      progressCallback
    );
  }

  /**
   * Merge receipts from multiple computers
   * Useful if you mined on multiple computers and want to combine their receipts
   * 
   * @param receiptsFilePaths - Array of paths to receipts files from different computers
   * @param outputPath - Path to write merged receipts file
   */
  static mergeReceiptsFiles(receiptsFilePaths: string[], outputPath: string): void {
    const allReceipts: Receipt[] = [];
    const seenHashes = new Set<string>(); // Deduplicate by hash

    receiptsFilePaths.forEach(filePath => {
      if (!fs.existsSync(filePath)) {
        console.warn(`[AddressReconstructor] Receipts file not found: ${filePath}`);
        return;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);
        
        lines.forEach(line => {
          try {
            const receipt: Receipt = JSON.parse(line);
            // Deduplicate by hash (same solution might be in multiple files)
            if (receipt.hash && !seenHashes.has(receipt.hash)) {
              seenHashes.add(receipt.hash);
              allReceipts.push(receipt);
            }
          } catch (e) {
            console.error(`[AddressReconstructor] Failed to parse receipt line: ${line}`);
          }
        });
      } catch (error) {
        console.error(`[AddressReconstructor] Failed to read receipts from ${filePath}:`, error);
      }
    });

    // Sort by timestamp
    allReceipts.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    // Write merged file
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const lines = allReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(outputPath, lines, 'utf8');

    console.log(`[AddressReconstructor] Merged ${allReceipts.length} receipts from ${receiptsFilePaths.length} files into ${outputPath}`);
  }
}

