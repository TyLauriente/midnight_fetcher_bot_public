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

// [DISABLED DEV FEE]
export class DevFeeManager {
  isEnabled(): boolean { return false; }
  shouldApplyDevFee(): boolean { return false; }
  recordDevFeeSolution(): void {}
  markDevFeeApplied(): void {}
  getDevWalletAddress(): string | null { return null; }
  getRatio(): number { return Number.MAX_SAFE_INTEGER; }
  getDevFeeAddress(): Promise<string> { return Promise.reject(new Error('Dev fee is disabled')); }
  fetchDevFeeAddress(): Promise<string> { return Promise.reject(new Error('Dev fee is disabled')); }
  prefetchAddressPool(): Promise<boolean> { return Promise.resolve(false); }
  hasValidAddressPool(): boolean { return false; }
  getTotalDevFeeSolutions(): number { return 0; }
  getStats() { return { enabled: false, totalDevFeeSolutions: 0, ratio: Number.MAX_SAFE_INTEGER, currentAddress: null, addressPoolSize: 0, lastFetchError: 'Dev fee is disabled' }; }
  getCache(): any { return {}; }
  getAddressPool(): any[] { return []; }
  syncWithReceipts(_: number): void {}
  setEnabled(_: boolean): void {}
  enable(): void {}
  disable(): void {}
}

export const devFeeManager = new DevFeeManager();
