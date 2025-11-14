/**
 * Server-side auto-startup logic for mining
 * 
 * This module runs when the Next.js server starts and automatically:
 * 1. Waits for the hash server to be ready
 * 2. Checks if a wallet exists
 * 3. Tries to unlock with the default password
 * 4. Starts mining automatically if the password works
 * 
 * This ensures mining starts automatically without requiring the web UI to be opened.
 */

import { miningOrchestrator } from './orchestrator';
import { WalletManager } from '@/lib/wallet/manager';
import { ConfigManager } from './config-manager';
import axios from 'axios';

const DEFAULT_PASSWORD = 'Rascalismydog@1';
// Use the same environment variable as hash engine for consistency
const HASH_SERVER_URL = process.env.HASH_SERVICE_URL || process.env.HASH_SERVER_URL || 'http://127.0.0.1:9001';
let autoStartupAttempted = false;

/**
 * Wait for hash server to be ready
 */
async function waitForHashServer(maxRetries: number = 30, retryDelay: number = 2000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(`${HASH_SERVER_URL}/health`, {
        timeout: 5000,
      });
      if (response.status === 200) {
        console.log('[Auto-startup-server] Hash server is ready!');
        return true;
      }
    } catch (error) {
      // Hash server not ready yet, continue waiting
    }
    
    if (i < maxRetries - 1) {
      console.log(`[Auto-startup-server] Waiting for hash server... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  console.error('[Auto-startup-server] Hash server failed to start within timeout period');
  return false;
}

/**
 * Auto-start mining if the default password works
 * This function is called when the Next.js server starts
 */
export async function autoStartMining(): Promise<void> {
  // Prevent multiple startup attempts
  if (autoStartupAttempted) {
    console.log('[Auto-startup-server] Auto-startup already attempted, skipping...');
    return;
  }
  autoStartupAttempted = true;

  console.log('');
  console.log('==============================================================================');
  console.log('                    Server-Side Auto-Startup');
  console.log('==============================================================================');
  console.log('');

  try {
    // Wait for hash server to be ready (required for mining)
    console.log('[Auto-startup-server] Waiting for hash server to be ready...');
    const hashServerReady = await waitForHashServer(30, 2000); // Wait up to 60 seconds
    if (!hashServerReady) {
      console.error('[Auto-startup-server] Hash server is not ready. Skipping auto-startup.');
      console.error('[Auto-startup-server] Mining will not start automatically. Please start the hash server and try again.');
      return;
    }

    // Wait a bit more for everything to initialize
    console.log('[Auto-startup-server] Waiting for services to initialize...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if wallet exists
    const walletManager = new WalletManager();
    if (!walletManager.walletExists()) {
      console.log('[Auto-startup-server] No wallet found. Skipping auto-startup.');
      return;
    }

    console.log('[Auto-startup-server] Wallet found. Checking if default password works...');

    // Try to unlock wallet with default password
    try {
      await walletManager.loadWallet(DEFAULT_PASSWORD);
      console.log('[Auto-startup-server] Default password is correct!');
    } catch (error: any) {
      console.log('[Auto-startup-server] Default password is incorrect. Skipping auto-startup.');
      console.log('[Auto-startup-server] User will need to manually unlock the wallet via the web UI.');
      return;
    }

    // Check if mining is already active
    const stats = miningOrchestrator.getStats();
    if (stats.active) {
      console.log('[Auto-startup-server] Mining is already active. Skipping auto-startup.');
      return;
    }

    // Get saved configuration - CRITICAL: Load fresh from disk to ensure we have latest values
    const config = ConfigManager.loadConfig();
    console.log('[Auto-startup-server] Loaded config from disk:', JSON.stringify(config, null, 2));
    
    // CRITICAL: Don't pass addressOffset to reinitialize - let it read from config instead
    // This prevents auto-startup from writing to the config file
    // The start() method will read addressOffset from config automatically when undefined is passed
    console.log('[Auto-startup-server] Starting mining automatically with previous settings...');
    console.log(`[Auto-startup-server] Configuration to use (from config file):`);
    console.log(`[Auto-startup-server]   - Address offset: ${config.addressOffset ?? 0} (will be read from config, not passed)`);
    console.log(`[Auto-startup-server]   - Worker threads: ${config.workerThreads ?? 11}`);
    console.log(`[Auto-startup-server]   - Batch size: ${config.batchSize ?? 850}`);

    // CRITICAL: Pass undefined for addressOffset so start() reads from config instead of writing to it
    // This ensures we never modify the config file during auto-startup
    try {
      console.log(`[Auto-startup-server] Calling reinitialize with password (addressOffset=undefined, will read from config)...`);
      await miningOrchestrator.reinitialize(DEFAULT_PASSWORD, undefined);
      console.log('');
      console.log('==============================================================================');
      console.log('                    Auto-Startup Complete!');
      console.log('==============================================================================');
      console.log('');
      console.log('Wallet unlocked and mining started automatically.');
      console.log('Mining is running in the background - no web UI required.');
      console.log('You can access the web UI at http://localhost:3001 to monitor progress.');
      console.log('');
      
      // Mark mining as active in config
      ConfigManager.setMiningActive(true);
    } catch (error: any) {
      console.error('[Auto-startup-server] Failed to start mining automatically:', error.message);
      console.error('[Auto-startup-server] Error details:', error);
      console.error('[Auto-startup-server] Wallet is unlocked. You can start mining manually via the web UI.');
    }
  } catch (error: any) {
    console.error('[Auto-startup-server] Error during auto-startup:', error.message);
    console.error('[Auto-startup-server] Error stack:', error.stack);
    // Don't throw - allow server to continue even if auto-startup fails
  }
}

