import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';
import { WalletManager } from '@/lib/wallet/manager';

/**
 * Check if the wallet is already unlocked (wallet is loaded in orchestrator)
 * This endpoint checks if:
 * 1. Mining is active (orchestrator is running with addresses loaded)
 * 2. Or if we can verify the default password works (wallet is unlocked via auto-startup)
 */
export async function GET() {
  try {
    // Check if mining orchestrator has addresses loaded (indicates wallet is unlocked)
    const stats = miningOrchestrator.getStats();
    const addressesData = miningOrchestrator.getAddressesData();
    
    // Primary check: Mining is active means wallet is definitely unlocked
    if (stats.active) {
      return NextResponse.json({
        unlocked: true,
        active: true,
        hasAddresses: true,
        addressCount: stats.totalAddresses || 0,
      });
    }
    
    // Secondary check: Try to verify if the default password works
    // This handles the case where auto-startup unlocked the wallet but mining hasn't started yet
    try {
      const defaultPassword = 'Rascalismydog@1';
      const walletManager = new WalletManager();
      
      if (!walletManager.walletExists()) {
        return NextResponse.json({
          unlocked: false,
          active: false,
          hasAddresses: false,
          addressCount: 0,
        });
      }
      
      // Try to load the wallet with the default password
      // If this succeeds, the wallet is unlocked (auto-startup script unlocked it)
      const addresses = await walletManager.loadWallet(defaultPassword);
      
      // If we can load the wallet, it means the default password works
      // The auto-startup script should have already unlocked it
      return NextResponse.json({
        unlocked: true,
        active: stats.active, // Mining may or may not be active yet
        hasAddresses: true,
        addressCount: addresses.length,
      });
    } catch (error) {
      // Default password doesn't work or wallet can't be loaded
      // Wallet is not unlocked
      return NextResponse.json({
        unlocked: false,
        active: false,
        hasAddresses: false,
        addressCount: 0,
      });
    }
  } catch (error: any) {
    // If there's an error, assume wallet is not unlocked
    return NextResponse.json({
      unlocked: false,
      active: false,
      hasAddresses: false,
      addressCount: 0,
    });
  }
}

