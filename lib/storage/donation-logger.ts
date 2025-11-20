/**
 * Logger for donation (consolidation) attempts
 * Logs all donation attempts to disk with timestamp and attempt count
 */

import fs from 'fs';
import path from 'path';

export interface DonationRecord {
  timestamp: string;
  attemptNumber: number;
  sourceAddress: string;
  sourceAddressIndex?: number;
  destinationAddress: string;
  signature: string;
  pubkey: string;
  success: boolean;
  response?: any;
  error?: string;
  httpStatus?: number;
}

class DonationLogger {
  private donationDir: string;
  private attemptCounter: number = 0;

  constructor() {
    // Use same storage directory logic as receipts
    const oldStorageDir = path.join(process.cwd(), 'storage');
    const newDataDir = path.join(
      process.env.USERPROFILE || process.env.HOME || process.cwd(),
      'Documents',
      'MidnightFetcherBot'
    );

    let storageDir: string;

    // Check if receipts exist in old location (installation folder)
    const oldReceiptsFile = path.join(oldStorageDir, 'receipts.jsonl');
    if (fs.existsSync(oldReceiptsFile)) {
      storageDir = oldStorageDir;
      console.log(`[Donation] Using installation folder: ${storageDir}`);
    } else {
      // Otherwise use Documents folder (new default)
      storageDir = path.join(newDataDir, 'storage');
      console.log(`[Donation] Using Documents folder: ${storageDir}`);
    }

    // Ensure storage directory exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Create donations subdirectory
    this.donationDir = path.join(storageDir, 'donations');
    if (!fs.existsSync(this.donationDir)) {
      fs.mkdirSync(this.donationDir, { recursive: true });
    }

    // Load attempt counter from existing logs
    this.loadAttemptCounter();
  }

  /**
   * Load the highest attempt number from existing log files
   */
  private loadAttemptCounter(): void {
    try {
      const files = fs.readdirSync(this.donationDir);
      let maxAttempt = 0;

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const match = file.match(/donation-(\d+)-/);
          if (match) {
            const attempt = parseInt(match[1], 10);
            if (attempt > maxAttempt) {
              maxAttempt = attempt;
            }
          }
        }
      }

      this.attemptCounter = maxAttempt;
    } catch (error) {
      console.error('[Donation] Failed to load attempt counter:', error);
      this.attemptCounter = 0;
    }
  }

  /**
   * Get the next attempt number
   */
  private getNextAttemptNumber(): number {
    this.attemptCounter++;
    return this.attemptCounter;
  }

  /**
   * Get log file name based on date, time, and attempt number
   */
  private getLogFileName(attemptNumber: number): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Format: 2025-01-15T14-30-45
    const filename = `donation-${attemptNumber}-${dateStr}.jsonl`;
    return path.join(this.donationDir, filename);
  }

  /**
   * Log a donation attempt
   */
  logDonation(record: DonationRecord): void {
    try {
      const attemptNumber = record.attemptNumber || this.getNextAttemptNumber();
      const logFile = this.getLogFileName(attemptNumber);
      const line = JSON.stringify({
        ...record,
        attemptNumber,
        timestamp: record.timestamp || new Date().toISOString(),
      }) + '\n';

      fs.appendFileSync(logFile, line, 'utf8');
      console.log(`[Donation] Logged ${record.success ? 'successful' : 'failed'} donation attempt #${attemptNumber} to ${logFile}`);
    } catch (error) {
      console.error('[Donation] Failed to write donation log:', error);
    }
  }

  /**
   * Read all donation logs
   */
  readAllDonations(): DonationRecord[] {
    const records: DonationRecord[] = [];

    try {
      const files = fs.readdirSync(this.donationDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse(); // Most recent first

      for (const file of files) {
        const filePath = path.join(this.donationDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            records.push(JSON.parse(line));
          } catch (e) {
            console.error(`[Donation] Failed to parse line in ${file}:`, e);
          }
        }
      }
    } catch (error) {
      console.error('[Donation] Failed to read donation logs:', error);
    }

    return records;
  }
}

export const donationLogger = new DonationLogger();

