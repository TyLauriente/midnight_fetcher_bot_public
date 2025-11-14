import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { WalletManager } from '@/lib/wallet/manager';
import * as fs from 'fs';
import * as path from 'path';

export async function GET() {
  try {
    // Get all receipts first to build address list
    const receipts = receiptsLogger.readReceipts();

    // Count solutions per address and collect addresses from receipts (excluding dev fee)
    const solutionsByAddress = new Map<string, number>();
    const addressesByIndex = new Map<number, { bech32: string; solutions: number }>();

    receipts.forEach(receipt => {
      if (!receipt.isDevFee && receipt.addressIndex !== undefined) {
        const count = solutionsByAddress.get(receipt.address) || 0;
        solutionsByAddress.set(receipt.address, count + 1);

        // Track address info by index
        addressesByIndex.set(receipt.addressIndex, {
          bech32: receipt.address,
          solutions: count + 1
        });
      }
    });

    // Try to get additional data from orchestrator if mining is running
    const addressData = miningOrchestrator.getAddressesData();
    const currentChallengeId = addressData?.currentChallengeId || null;

    // Get all addresses from orchestrator (if mining is running) or try to load from wallet
    let allAddresses: Array<{ index: number; bech32: string; registered: boolean }> = [];
    
    if (addressData && addressData.addresses) {
      // Use addresses from orchestrator (already filtered by addressOffset)
      allAddresses = addressData.addresses.map((addr: any) => ({
        index: addr.index,
        bech32: addr.bech32,
        registered: addr.registered || false,
      }));
    } else {
      // Try to load addresses from wallet file (read-only, no password needed for derived addresses)
      try {
        // Use same directory detection logic as wallet manager
        const oldSecureDir = path.join(process.cwd(), 'secure');
        const newDataDir = path.join(
          process.env.USERPROFILE || process.env.HOME || process.cwd(),
          'Documents',
          'MidnightFetcherBot'
        );
        
        const oldDerivedAddressesFile = path.join(oldSecureDir, 'derived-addresses.json');
        const newDerivedAddressesFile = path.join(newDataDir, 'secure', 'derived-addresses.json');
        
        // Check old location first (for existing users)
        let addressesFile: string | null = null;
        if (fs.existsSync(oldDerivedAddressesFile)) {
          addressesFile = oldDerivedAddressesFile;
        } else if (fs.existsSync(newDerivedAddressesFile)) {
          addressesFile = newDerivedAddressesFile;
        }
        
        if (addressesFile) {
          const addressesData = JSON.parse(fs.readFileSync(addressesFile, 'utf8'));
          allAddresses = addressesData.map((addr: any) => ({
            index: addr.index,
            bech32: addr.bech32,
            registered: addr.registered || false,
          }));
        }
      } catch (error: any) {
        console.error('[API] Failed to load addresses from wallet file:', error.message);
      }
    }

    // Merge addresses: use all addresses from wallet/orchestrator, enrich with receipt data
    const enrichedAddresses = allAddresses.map(addr => {
      const receiptData = addressesByIndex.get(addr.index);
      const solutionCount = solutionsByAddress.get(addr.bech32) || 0;
      
      // If address has solutions, it must be registered
      const registered = addr.registered || solutionCount > 0;
      
      // Check if solved current challenge
      let solvedCurrentChallenge = false;
      if (addressData && currentChallengeId) {
        solvedCurrentChallenge = addressData.solvedAddressChallenges.get(addr.bech32)?.has(currentChallengeId) || false;
      }

      return {
        index: addr.index,
        bech32: addr.bech32,
        registered,
        solvedCurrentChallenge,
        totalSolutions: solutionCount,
      };
    }).sort((a, b) => a.index - b.index); // Sort by index

    // Calculate summary stats
    const summary = {
      totalAddresses: enrichedAddresses.length,
      registeredAddresses: enrichedAddresses.filter(a => a.registered).length,
      solvedCurrentChallenge: enrichedAddresses.filter(a => a.solvedCurrentChallenge).length,
    };

    return NextResponse.json({
      success: true,
      currentChallenge: currentChallengeId,
      addresses: enrichedAddresses,
      summary,
    });
  } catch (error: any) {
    console.error('[API] Addresses error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch address data' },
      { status: 500 }
    );
  }
}
