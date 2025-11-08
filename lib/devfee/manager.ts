/**
 * Dev Fee Manager
 * Handles fetching dev fee addresses and tracking dev fee solutions
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export interface DevFeeConfig {
  enabled: boolean;
  apiUrl: string;
  ratio: number; // 1 in X solutions goes to dev fee (e.g., 10 = 1 in 10)
  cacheFile: string;
  clientId: string;
}

export interface DevFeeAddress {
  address: string;
  addressIndex: number;
  fetchedAt: number;
  usedCount: number;
}

export interface DevFeeCache {
  currentAddress: DevFeeAddress | null;
  totalDevFeeSolutions: number;
  lastFetchError?: string;
  clientId?: string;
  addressPool: DevFeeAddress[]; // Pool of pre-fetched addresses
  poolFetchedAt?: number; // When the pool was last fetched
  enabled?: boolean; // User's preference for dev fee (stored in cache)
}

export interface DevFeeApiResponse {
  devAddress?: string; // Legacy single address (for backwards compatibility)
  devAddressIndex?: number; // Legacy single address index
  isNewAssignment: boolean;
  addresses: Array<{
    devAddress: string;
    devAddressIndex: number;
    registered: boolean;
  }>;
}

// [DISABLED DEV FEE]
export class DevFeeManager {
  isEnabled(): boolean { return false; }
  getRatio(): number { return Number.MAX_SAFE_INTEGER; }
  getTotalDevFeeSolutions(): number { return 0; }
  hasValidAddressPool(): boolean { return false; }
  getDevFeeAddress(): Promise<string> { return Promise.reject(new Error('Dev fee is disabled')); }
  fetchDevFeeAddress(): Promise<string> { return Promise.reject(new Error('Dev fee is disabled')); }
  prefetchAddressPool(): Promise<boolean> { return Promise.resolve(false); }
  syncWithReceipts(_: number): void {}
  recordDevFeeSolution(): void {}
  getStats() { return { enabled: false, totalDevFeeSolutions: 0, ratio: Number.MAX_SAFE_INTEGER, currentAddress: null, addressPoolSize: 0, lastFetchError: 'Dev fee is disabled' }; }
  getCache(): any { return {}; }
  getAddressPool(): any[] { return []; }
  setEnabled(_: boolean): void {}
  enable(): void {}
  disable(): void {}
  // Interface completeness
  constructor(_?: Partial<any>) { }
}

// Singleton instance
export const devFeeManager = new DevFeeManager();
