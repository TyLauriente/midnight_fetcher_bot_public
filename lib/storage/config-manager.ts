/**
 * Config Manager
 * Persists mining configuration (worker threads, batch size, worker grouping) to disk
 */

import * as fs from 'fs';
import * as path from 'path';

export interface MiningConfig {
  workerThreads: number;
  batchSize: number | null;
  workerGroupingMode: 'auto' | 'all-on-one' | 'grouped';
  workersPerAddress: number;
  addressOffset: number; // Address offset index (0 = 0-199, 1 = 200-399, etc.)
}

class ConfigManager {
  private configFile: string;
  private defaultConfig: MiningConfig = {
    workerThreads: 11,
    batchSize: null, // null means use default
    workerGroupingMode: 'auto',
    workersPerAddress: 5,
    addressOffset: 0, // Default to 0 (addresses 0-199)
  };

  constructor() {
    // Use same storage strategy as receipts: check installation folder first
    const oldStorageDir = path.join(process.cwd(), 'storage');
    const newDataDir = path.join(
      process.env.USERPROFILE || process.env.HOME || process.cwd(),
      'Documents',
      'MidnightFetcherBot'
    );

    let storageDir: string;

    // Check if receipts exist in old location (installation folder) to stay consistent
    const oldReceiptsFile = path.join(oldStorageDir, 'receipts.jsonl');
    if (fs.existsSync(oldReceiptsFile)) {
      storageDir = oldStorageDir;
    } else {
      storageDir = path.join(newDataDir, 'storage');
    }

    // Ensure storage directory exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    this.configFile = path.join(storageDir, 'mining-config.json');
  }

  /**
   * Load configuration from disk, or return defaults if file doesn't exist
   */
  loadConfig(): MiningConfig {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8');
        const config = JSON.parse(data) as MiningConfig;
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
  saveConfig(config: MiningConfig): void {
    try {
      const data = JSON.stringify(config, null, 2);
      fs.writeFileSync(this.configFile, data, 'utf8');
      console.log('[Config] Saved configuration to disk:', config);
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
