/**
 * Dev Fee Manager
 * Implements fair 1-per-hour dev fee system
 */

import 'server-only';
import fs from 'fs';
import path from 'path';

interface DevFeeConfig {
  devWalletAddress: string | null;
  feeEnabled: boolean;
}

interface DevFeeCacheFile {
  address: string;
  fetchedAt: number;
}

class DevFeeManager {
  private devWalletAddress: string | null = null;
  private feeEnabled: boolean = false;
  private lastFeeTimestamp: number = 0;
  private readonly FEE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private readonly CACHE_FILE_PATH = path.join(process.cwd(), '.devfee_cache.json');

  /**
   * Initialize dev fee system
   * Loads from cache file or fetches from server (only once ever)
   */
  async initialize(): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization
    this.initializationPromise = this.doInitialize();
    return this.initializationPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Try to load from cache file first
      const cachedAddress = this.loadFromCache();

      if (cachedAddress) {
        console.log('[DevFee] Loaded dev wallet from cache');
        this.devWalletAddress = cachedAddress;
        this.feeEnabled = true;
        this.initialized = true;
        console.log('[DevFee] Dev fee enabled - 1 solution per hour will support development');
        console.log('[DevFee] Dev wallet:', this.devWalletAddress?.slice(0, 20) + '...');
        return;
      }

      // If not in cache, fetch from API
      console.log('[DevFee] Fetching dev wallet address from API...');
      const response = await fetch('/api/devfee');
      const data: DevFeeConfig = await response.json();

      this.devWalletAddress = data.devWalletAddress;
      this.feeEnabled = data.feeEnabled && !!data.devWalletAddress;
      this.initialized = true;

      // Save to cache file for future use
      if (this.devWalletAddress) {
        this.saveToCache(this.devWalletAddress);
        console.log('[DevFee] Dev wallet address cached to file');
      }

      if (this.feeEnabled) {
        console.log('[DevFee] Dev fee enabled - 1 solution per hour will support development');
        console.log('[DevFee] Dev wallet:', this.devWalletAddress?.slice(0, 20) + '...');
      } else {
        console.log('[DevFee] Dev fee disabled');
      }
    } catch (error) {
      console.error('[DevFee] Failed to initialize dev fee:', error);
      this.feeEnabled = false;
      this.initialized = true; // Mark as initialized even on failure to prevent retries
    } finally {
      this.initializationPromise = null;
    }
  }

  /**
   * Load dev wallet address from cache file
   */
  private loadFromCache(): string | null {
    try {
      if (!fs.existsSync(this.CACHE_FILE_PATH)) {
        return null;
      }

      const data = fs.readFileSync(this.CACHE_FILE_PATH, 'utf-8');
      const cache: DevFeeCacheFile = JSON.parse(data);

      if (cache.address) {
        return cache.address;
      }
    } catch (error) {
      console.error('[DevFee] Failed to load from cache:', error);
    }
    return null;
  }

  /**
   * Save dev wallet address to cache file
   */
  private saveToCache(address: string): void {
    try {
      const cache: DevFeeCacheFile = {
        address,
        fetchedAt: Date.now(),
      };
      fs.writeFileSync(this.CACHE_FILE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      console.error('[DevFee] Failed to save to cache:', error);
    }
  }

  /**
   * Check if next solution should be a dev fee
   * Returns true once per hour
   */
  shouldApplyDevFee(): boolean {
    if (!this.feeEnabled || !this.devWalletAddress) {
      return false;
    }

    const now = Date.now();
    const timeSinceLastFee = now - this.lastFeeTimestamp;

    // First fee or 1 hour passed
    if (this.lastFeeTimestamp === 0 || timeSinceLastFee >= this.FEE_INTERVAL_MS) {
      return true;
    }

    return false;
  }

  /**
   * Mark that a dev fee was applied
   */
  markDevFeeApplied(): void {
    this.lastFeeTimestamp = Date.now();
    console.log('[DevFee] Dev fee applied - next in 1 hour');
  }

  /**
   * Get dev wallet address (if fee should be applied)
   */
  getDevWalletAddress(): string | null {
    return this.devWalletAddress;
  }

  /**
   * Get time until next dev fee (in milliseconds)
   */
  getTimeUntilNextFee(): number {
    if (!this.feeEnabled || this.lastFeeTimestamp === 0) {
      return 0;
    }

    const elapsed = Date.now() - this.lastFeeTimestamp;
    const remaining = this.FEE_INTERVAL_MS - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Get dev fee stats
   */
  getStats() {
    return {
      enabled: this.feeEnabled,
      lastFeeTimestamp: this.lastFeeTimestamp,
      timeUntilNextFee: this.getTimeUntilNextFee(),
      feeInterval: this.FEE_INTERVAL_MS,
    };
  }
}

export const devFeeManager = new DevFeeManager();
