/**
 * Mining Configuration Manager
 * Handles persistent storage of mining configuration (offset, workers, batch size)
 */

import fs from 'fs';
import path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { encrypt, decrypt, EncryptedData } from '@/lib/wallet/encryption';

const SECURE_DIR = path.join(process.cwd(), 'secure');
const CONFIG_FILE = path.join(SECURE_DIR, 'mining-config.json');

/**
 * Generate a machine-specific key for encrypting the password
 * This ensures the password can only be decrypted on the same machine
 */
function getMachineKey(): string {
  // Use a combination of machine-specific identifiers
  const hostname = os.hostname();
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || '';
  
  // Create a deterministic key from machine info
  const machineInfo = `${hostname}-${platform}-${arch}-${cpuModel}`;
  return crypto.createHash('sha256').update(machineInfo).digest('hex').substring(0, 32);
}

export interface MiningConfig {
  addressOffset: number;
  workerThreads: number;
  batchSize: number;
  lastUpdated?: string;
  autoResume?: boolean; // Whether to auto-resume mining on restart
  wasMiningActive?: boolean; // Whether mining was active when app closed
  encryptedPassword?: string; // Encrypted password for auto-resume (only if autoResume is true)
}

const DEFAULT_CONFIG: MiningConfig = {
  addressOffset: 0,
  workerThreads: 11,
  batchSize: 300,
};

export class ConfigManager {
  /**
   * Load mining configuration from disk
   */
  static loadConfig(): MiningConfig {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData) as MiningConfig;
        
        // Validate and merge with defaults
        return {
          addressOffset: typeof config.addressOffset === 'number' ? config.addressOffset : DEFAULT_CONFIG.addressOffset,
          workerThreads: typeof config.workerThreads === 'number' ? config.workerThreads : DEFAULT_CONFIG.workerThreads,
          batchSize: typeof config.batchSize === 'number' ? config.batchSize : DEFAULT_CONFIG.batchSize,
          lastUpdated: config.lastUpdated,
        };
      }
    } catch (error: any) {
      console.warn(`[ConfigManager] Failed to load config: ${error.message}, using defaults`);
    }
    
    return { ...DEFAULT_CONFIG };
  }

  /**
   * Save mining configuration to disk
   */
  static saveConfig(config: Partial<MiningConfig>): void {
    try {
      // Ensure secure directory exists
      if (!fs.existsSync(SECURE_DIR)) {
        fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
      }

      // Load existing config and merge
      const existing = this.loadConfig();
      const updated: MiningConfig = {
        ...existing,
        ...config,
        lastUpdated: new Date().toISOString(),
      };

      // Validate values
      if (updated.addressOffset < 0) updated.addressOffset = 0;
      if (updated.workerThreads < 1) updated.workerThreads = DEFAULT_CONFIG.workerThreads;
      if (updated.batchSize < 50) updated.batchSize = DEFAULT_CONFIG.batchSize;

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
      console.log(`[ConfigManager] Saved config: offset=${updated.addressOffset}, workers=${updated.workerThreads}, batch=${updated.batchSize}`);
    } catch (error: any) {
      console.error(`[ConfigManager] Failed to save config: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update specific config values
   */
  static updateConfig(updates: Partial<MiningConfig>): void {
    this.saveConfig(updates);
  }

  /**
   * Get current address offset
   */
  static getAddressOffset(): number {
    return this.loadConfig().addressOffset;
  }

  /**
   * Set address offset
   */
  static setAddressOffset(offset: number): void {
    if (offset < 0) throw new Error('Address offset must be non-negative');
    this.saveConfig({ addressOffset: offset });
  }

  /**
   * Get worker threads
   */
  static getWorkerThreads(): number {
    return this.loadConfig().workerThreads;
  }

  /**
   * Set worker threads
   */
  static setWorkerThreads(workers: number): void {
    if (workers < 1) throw new Error('Worker threads must be at least 1');
    this.saveConfig({ workerThreads: workers });
  }

  /**
   * Get batch size
   */
  static getBatchSize(): number {
    return this.loadConfig().batchSize;
  }

  /**
   * Set batch size
   */
  static setBatchSize(batchSize: number): void {
    if (batchSize < 50) throw new Error('Batch size must be at least 50');
    this.saveConfig({ batchSize });
  }

  /**
   * Enable/disable auto-resume mining on restart
   */
  static setAutoResume(enabled: boolean, password?: string): void {
    const config = this.loadConfig();
    
    if (enabled && password) {
      // Encrypt password with machine-specific key
      const machineKey = getMachineKey();
      const encrypted = encrypt(password, machineKey);
      config.encryptedPassword = JSON.stringify(encrypted);
      config.autoResume = true;
    } else {
      // Disable auto-resume and clear password
      config.autoResume = false;
      config.encryptedPassword = undefined;
    }
    
    this.saveConfig(config);
  }

  /**
   * Get decrypted password for auto-resume (if enabled)
   */
  static getDecryptedPassword(): string | null {
    const config = this.loadConfig();
    
    if (!config.autoResume || !config.encryptedPassword) {
      return null;
    }
    
    try {
      const machineKey = getMachineKey();
      const encrypted: EncryptedData = JSON.parse(config.encryptedPassword);
      return decrypt(encrypted, machineKey);
    } catch (error: any) {
      console.warn(`[ConfigManager] Failed to decrypt password: ${error.message}`);
      // Clear invalid password
      config.encryptedPassword = undefined;
      config.autoResume = false;
      this.saveConfig(config);
      return null;
    }
  }

  /**
   * Check if auto-resume is enabled
   */
  static isAutoResumeEnabled(): boolean {
    return this.loadConfig().autoResume === true;
  }

  /**
   * Save mining state (whether mining was active)
   */
  static setMiningActive(active: boolean): void {
    this.saveConfig({ wasMiningActive: active });
  }

  /**
   * Check if mining was active when app closed
   */
  static wasMiningActive(): boolean {
    return this.loadConfig().wasMiningActive === true;
  }
}

