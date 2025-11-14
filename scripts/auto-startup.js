#!/usr/bin/env node
/**
 * Auto-startup script for Midnight Fetcher Bot
 * 
 * This script runs after Next.js starts and automatically:
 * 1. Checks if the default password works
 * 2. If it works, unlocks the wallet
 * 3. Starts mining with previous settings
 * 
 * This allows the app to start mining automatically without requiring
 * the web UI to be opened.
 */

const DEFAULT_PASSWORD = 'Rascalismydog@1';
const API_BASE_URL = 'http://localhost:3001';
const MAX_RETRIES = 30; // Wait up to 5 minutes (30 * 10 seconds)
const RETRY_DELAY = 10000; // 10 seconds

/**
 * Wait for Next.js to be ready by checking the API health
 */
async function waitForNextJs() {
  console.log('[Auto-startup] Waiting for Next.js to be ready...');
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/wallet/status`);
      if (response.ok) {
        console.log('[Auto-startup] Next.js is ready!');
        return true;
      }
    } catch (error) {
      // Server not ready yet, continue waiting
    }
    
    if (i < MAX_RETRIES - 1) {
      console.log(`[Auto-startup] Waiting for Next.js... (${i + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  
  console.error('[Auto-startup] Next.js failed to start within timeout period');
  return false;
}

/**
 * Check if wallet exists
 */
async function checkWalletExists() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/wallet/status`);
    if (!response.ok) {
      return false;
    }
    const data = await response.json();
    return data.exists === true;
  } catch (error) {
    console.error('[Auto-startup] Error checking wallet status:', error.message);
    return false;
  }
}

/**
 * Try to unlock wallet with default password
 */
async function unlockWallet(password) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/wallet/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('[Auto-startup] Wallet unlocked successfully!');
      return true;
    } else {
      const data = await response.json();
      console.log(`[Auto-startup] Failed to unlock wallet: ${data.error || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.error('[Auto-startup] Error unlocking wallet:', error.message);
    return false;
  }
}

/**
 * Get mining status and configuration
 */
async function getMiningStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/mining/status`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Auto-startup] Error getting mining status:', error.message);
    return null;
  }
}

/**
 * Get auto-resume configuration (not used in default password flow, but kept for reference)
 */
async function getAutoResumeConfig() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/mining/auto-resume`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Auto-startup] Error getting auto-resume config:', error.message);
    return null;
  }
}

/**
 * Start mining with saved settings
 */
async function startMining(password, addressOffset = 0) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/mining/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, addressOffset }),
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('[Auto-startup] Mining started successfully!');
      console.log(`[Auto-startup] Address offset: ${data.addressOffset || 0}`);
      return true;
    } else {
      const data = await response.json();
      console.error(`[Auto-startup] Failed to start mining: ${data.error || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.error('[Auto-startup] Error starting mining:', error.message);
    return false;
  }
}

/**
 * Main startup logic
 */
async function main() {
  console.log('==============================================================================');
  console.log('                    Midnight Fetcher Bot - Auto Startup');
  console.log('==============================================================================');
  console.log('');
  
  // Wait for Next.js to be ready
  const nextJsReady = await waitForNextJs();
  if (!nextJsReady) {
    console.error('[Auto-startup] Failed to connect to Next.js server');
    process.exit(1);
  }
  
  // Wait a bit more for everything to initialize
  console.log('[Auto-startup] Waiting for services to initialize...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Check if wallet exists
  console.log('[Auto-startup] Checking if wallet exists...');
  const walletExists = await checkWalletExists();
  if (!walletExists) {
    console.log('[Auto-startup] No wallet found. Skipping auto-startup.');
    process.exit(0);
  }
  
  console.log('[Auto-startup] Wallet found. Attempting to unlock with default password...');
  
  // Try to unlock wallet with default password
  const unlocked = await unlockWallet(DEFAULT_PASSWORD);
  if (!unlocked) {
    console.log('[Auto-startup] Default password is incorrect. Skipping auto-startup.');
    console.log('[Auto-startup] User will need to manually unlock the wallet via the web UI.');
    process.exit(0);
  }
  
  console.log('[Auto-startup] Default password is correct!');
  
  // Always start mining automatically if default password works
  // This matches the user's requirement: "we'll also auto-start mining with the previous settings"
  console.log('[Auto-startup] Starting mining automatically with previous settings...');
  
  // Get saved configuration from mining status
  const miningStatus = await getMiningStatus();
  const addressOffset = miningStatus?.config?.addressOffset || 0;
  
  console.log(`[Auto-startup] Starting mining with address offset: ${addressOffset}`);
  
  // Start mining
  const miningStarted = await startMining(DEFAULT_PASSWORD, addressOffset);
  if (!miningStarted) {
    console.error('[Auto-startup] Failed to start mining automatically.');
    console.error('[Auto-startup] Wallet is unlocked. You can start mining manually via the web UI.');
    process.exit(0); // Don't exit with error - wallet is unlocked, user can start manually
  }
  
  console.log('');
  console.log('==============================================================================');
  console.log('                    Auto-startup Complete!');
  console.log('==============================================================================');
  console.log('');
  console.log('Wallet unlocked and mining started automatically.');
  console.log('You can access the web UI at http://localhost:3001');
  console.log('');
  
  // Exit successfully
  process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('[Auto-startup] Unhandled rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[Auto-startup] Uncaught exception:', error);
  process.exit(1);
});

// Run main function
main().catch((error) => {
  console.error('[Auto-startup] Fatal error:', error);
  process.exit(1);
});
