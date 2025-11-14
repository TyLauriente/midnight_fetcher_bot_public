/**
 * Config Manager
 * Persists mining configuration (worker threads, batch size, worker grouping) to disk
 * Stores config in secure/ directory alongside wallet files
 */

import * as fs from 'fs';
import * as path from 'path';

export interface MiningConfig {
  addressOffset: number; // Address offset index (0 = 0-199, 1 = 200-399, etc.)
  workerThreads: number;
  batchSize: number; // Always a number in saved config
  wasMiningActive?: boolean; // Whether mining was active when config was saved
  lastUpdated?: string; // ISO timestamp of last update
}

// Internal interface for config with nullable batchSize (for loading/updating)
interface MiningConfigInternal {
  addressOffset: number;
  workerThreads: number;
  batchSize: number | null;
  wasMiningActive?: boolean;
  lastUpdated?: string;
}

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
    return process.cwd();
  }

  // Otherwise use Documents folder (new default)
  return newDataDir;
}

class ConfigManager {
  private configFile: string;
  private defaultConfig: MiningConfig = {
    addressOffset: 0, // Default to 0 (addresses 0-199)
    workerThreads: 11,
    batchSize: 300, // Default batch size
    wasMiningActive: false,
    lastUpdated: new Date().toISOString(),
  };

  constructor() {
    // Use same directory strategy as wallet manager
    const dataDir = determineDataDirectory();
    const secureDir = path.join(dataDir, 'secure');

    // Ensure secure directory exists
    if (!fs.existsSync(secureDir)) {
      fs.mkdirSync(secureDir, { recursive: true, mode: 0o700 });
    }

    this.configFile = path.join(secureDir, 'mining-config.json');
  }

  /**
   * Load configuration from disk, or return defaults if file doesn't exist
   */
  loadConfig(): MiningConfig {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8');
        const config = JSON.parse(data) as MiningConfig;
        // Ensure batchSize is a number (handle legacy null values)
        if (config.batchSize === null || config.batchSize === undefined) {
          config.batchSize = 300;
        }
        console.log('[Config] Loaded configuration from disk:', config);
        return config;
      } else {
        console.log('[Config] No saved configuration found, using defaults');
        return { ...this.defaultConfig };
      }
    } catch (error: any) {
      console.error('[Config] Failed to load configuration:', error.message);
      console.log('[Config] Using default configuration');
      return { ...this.defaultConfig };
    }
  }

  /**
   * Save configuration to disk
   */
  saveConfig(config: MiningConfigInternal | MiningConfig, wasMiningActive?: boolean): void {
    try {
      // Convert null batchSize to actual number (use default 300 if null)
      const batchSize = config.batchSize !== null && config.batchSize !== undefined ? config.batchSize : 300;
      
      const configToSave: MiningConfig = {
        addressOffset: config.addressOffset,
        workerThreads: config.workerThreads,
        batchSize: batchSize,
        wasMiningActive: wasMiningActive !== undefined ? wasMiningActive : (config.wasMiningActive ?? false),
        lastUpdated: new Date().toISOString(),
      };
      const data = JSON.stringify(configToSave, null, 2);
      fs.writeFileSync(this.configFile, data, 'utf8');
      // Set file permissions to 0o600 (read/write for owner only)
      try {
        fs.chmodSync(this.configFile, 0o600);
      } catch (chmodError) {
        // chmod may fail on Windows, ignore
      }
      console.log('[Config] Saved configuration to disk:', configToSave);
    } catch (error: any) {
      console.error('[Config] Failed to save configuration:', error.message);
    }
  }

  /**
   * Update partial configuration and save
   */
  updateConfig(updates: Partial<MiningConfig>): MiningConfig {
    const currentConfig = this.loadConfig();
    const updatedConfig = { ...currentConfig, ...updates };
    this.saveConfig(updatedConfig);
    return updatedConfig;
  }
}

// Singleton instance
export const configManager = new ConfigManager();
