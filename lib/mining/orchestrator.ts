/**
 * Mining Orchestrator
 * Manages mining process, challenge polling, and worker coordination
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { ChallengeResponse, MiningStats, MiningEvent, Challenge, WorkerStats } from './types';
import { hashEngine } from '@/lib/hash/engine';
import { WalletManager, DerivedAddress } from '@/lib/wallet/manager';
import Logger from '@/lib/utils/logger';
import { matchesDifficulty, getDifficultyZeroBits } from './difficulty';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { generateNonce } from './nonce';
import { buildPreimage } from './preimage';
import { devFeeManager } from '@/lib/devfee/manager';
import { ConfigManager } from './config-manager';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface SolutionTimestamp {
  timestamp: number;
}

class MiningOrchestrator extends EventEmitter {
  private isRunning = false;
  private currentChallengeId: string | null = null;
  private apiBase: string = 'https://scavenger.prod.gd.midnighttge.io';
  // Optimize polling interval for high-end systems
  // For systems with many workers, we can poll less frequently since we're processing more solutions
  // Default: 2 seconds, but can be reduced for high-end systems
  private pollInterval = parseInt(process.env.MINING_POLL_INTERVAL || '2000', 10);
  private maxConcurrentAddresses = 1; // Maximum addresses to mine simultaneously (optimized for high-end systems)
  private pollTimer: NodeJS.Timeout | null = null;
  private walletManager: WalletManager | null = null;
  private isDevFeeMining = false; // Flag to prevent multiple simultaneous dev fee mining operations
  private addresses: DerivedAddress[] = [];
  private addressOffset: number = 0; // Address range offset (0 = addresses 0-199, 1 = 200-399, etc.)
  private addressesPerRange: number = 200; // Number of addresses per range
  private solutionsFound = 0;
  private startTime: number | null = null;
  private isMining = false;
  private currentChallenge: Challenge | null = null;
  private totalHashesComputed = 0;
  private lastHashRateUpdate = Date.now();
  private cpuUsage = 0;
  private lastCpuCheck: { idle: number; total: number } | null = null;
  private addressesProcessedCurrentChallenge = new Set<number>(); // Track which address indexes have processed current challenge
  private solutionTimestamps: SolutionTimestamp[] = []; // Track all solution timestamps for hourly/daily stats
  private workerThreads = 11; // Number of parallel mining threads
  private submittedSolutions = new Set<string>(); // Track submitted solution hashes to avoid duplicates
  private solvedAddressChallenges = new Map<string, Set<string>>(); // Map: address -> Set of solved challenge_ids
  private userSolutionsCount = 0; // Track non-dev-fee solutions for dev fee trigger
  private submittingAddresses = new Set<string>(); // Track addresses currently submitting solutions (address+challenge key)
  private pausedAddresses = new Set<string>(); // Track addresses that are paused while submission is in progress
  private workerStats = new Map<number, WorkerStats>(); // Track stats for each worker (workerId -> WorkerStats)
  private hourlyRestartTimer: NodeJS.Timeout | null = null; // Timer for hourly restart
  private stoppedWorkers = new Set<number>(); // Track workers that should stop immediately
  private currentMiningAddress: string | null = null; // Track which address we're currently mining
  private addressSubmissionFailures = new Map<string, number>(); // Track submission failures per address (address+challenge key)
  private customBatchSize: number | null = null; // Custom batch size override

  /**
   * Update orchestrator configuration dynamically
   */
  updateConfiguration(config: { workerThreads?: number; batchSize?: number; addressOffset?: number }): void {
    if (config.workerThreads !== undefined) {
      console.log(`[Orchestrator] Updating workerThreads: ${this.workerThreads} -> ${config.workerThreads}`);
      this.workerThreads = config.workerThreads;
      ConfigManager.setWorkerThreads(config.workerThreads);
    }
    if (config.batchSize !== undefined) {
      console.log(`[Orchestrator] Updating batchSize: ${this.customBatchSize || 'default'} -> ${config.batchSize}`);
      this.customBatchSize = config.batchSize;
      ConfigManager.setBatchSize(config.batchSize);
    }
    if (config.addressOffset !== undefined) {
      console.log(`[Orchestrator] Updating addressOffset: ${this.addressOffset} -> ${config.addressOffset}`);
      this.addressOffset = config.addressOffset;
      ConfigManager.setAddressOffset(config.addressOffset);
    }
  }

  /**
   * Get current configuration
   */
  getCurrentConfiguration(): { workerThreads: number; batchSize: number; addressOffset: number } {
    return {
      workerThreads: this.workerThreads,
      batchSize: this.getBatchSize(),
      addressOffset: this.addressOffset,
    };
  }

  /**
   * Get current batch size (custom or default)
   * Optimized for high-end systems: larger batches = better throughput
   */
  private getBatchSize(): number {
    if (this.customBatchSize !== null) {
      return this.customBatchSize;
    }
    
    // Dynamic batch size based on worker count for high-end systems
    // More workers = larger batches for better throughput
    // Formula: min(300 + (workers * 10), 50000)
    // Example: 100 workers = 1300 batch size, 200 workers = 2300 batch size
    const dynamicBatchSize = Math.min(300 + (this.workerThreads * 10), 50000);
    return dynamicBatchSize;
  }


  /**
   * Start mining with loaded wallet
   * @param password - Wallet password
   * @param addressOffset - Address range offset (0 = addresses 0-199, 1 = 200-399, etc.)
   */
  async start(password: string, addressOffset?: number): Promise<void> {
    if (this.isRunning) {
      console.log('[Orchestrator] Mining already running, returning current state');
      return; // Just return without error if already running
    }

    // Store password for address registration
    (this as any).currentPassword = password;
    
    // Load persisted config or use provided values
    const persistedConfig = ConfigManager.loadConfig();
    
    // Use provided offset, or persisted offset, or default to 0
    if (addressOffset !== undefined) {
      this.addressOffset = addressOffset;
      ConfigManager.setAddressOffset(addressOffset);
    } else {
      this.addressOffset = persistedConfig.addressOffset;
    }
    
    // Load persisted worker threads and batch size
    if (this.workerThreads === 11) { // Only if still at default
      this.workerThreads = persistedConfig.workerThreads;
    }
    if (this.customBatchSize === null) { // Only if still at default
      this.customBatchSize = persistedConfig.batchSize;
    }
    
    // Optimize for high-end systems: mine multiple addresses in parallel
    // For systems with 100+ vCPUs, we can mine multiple addresses simultaneously
    // Formula: min(workerThreads / 10, 10) - allows up to 10 parallel addresses
    // This ensures we have enough workers per address (at least 10 workers per address)
    const optimalConcurrentAddresses = Math.min(Math.max(1, Math.floor(this.workerThreads / 10)), 10);
    this.maxConcurrentAddresses = parseInt(process.env.MINING_MAX_CONCURRENT_ADDRESSES || optimalConcurrentAddresses.toString(), 10);
    console.log(`[Orchestrator] Max concurrent addresses: ${this.maxConcurrentAddresses} (${this.workerThreads} total workers)`);
    
    this.addressesPerRange = parseInt(process.env.MINING_ADDRESSES_PER_RANGE || '200', 10);
    
    // Load wallet
    this.walletManager = new WalletManager();
    const allAddresses = await this.walletManager.loadWallet(password);

    // Calculate required address count for the selected offset
    const startIndex = this.addressOffset * this.addressesPerRange;
    const endIndex = startIndex + this.addressesPerRange;
    const requiredAddressCount = endIndex; // Need addresses up to endIndex (exclusive)
    
    let finalAddressCount = allAddresses.length;
    
    // Check if we have enough addresses, if not, automatically expand
    if (allAddresses.length < requiredAddressCount) {
      console.log(`[Orchestrator] Wallet has ${allAddresses.length} addresses, but offset ${this.addressOffset} requires ${requiredAddressCount} addresses`);
      console.log(`[Orchestrator] Automatically expanding wallet to ${requiredAddressCount} addresses...`);
      
      try {
        await this.walletManager.expandAddresses(password, requiredAddressCount);
        console.log(`[Orchestrator] ✓ Successfully expanded wallet to ${requiredAddressCount} addresses`);
        
        // Reload addresses after expansion
        const expandedAddresses = await this.walletManager.loadWallet(password);
        finalAddressCount = expandedAddresses.length;
        this.addresses = expandedAddresses.filter(addr => addr.index >= startIndex && addr.index < endIndex);
      } catch (error: any) {
        console.error(`[Orchestrator] Failed to expand addresses:`, error);
        throw new Error(`Failed to generate required addresses. Offset ${this.addressOffset} requires ${requiredAddressCount} addresses, but wallet only has ${allAddresses.length}. Error: ${error.message}`);
      }
    } else {
      // Filter addresses to the specified range (deterministic - always same addresses for same offset)
      this.addresses = allAddresses.filter(addr => addr.index >= startIndex && addr.index < endIndex);
    }

    console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
    console.log(`[Orchestrator] ║ ADDRESS RANGE CONFIGURATION                               ║`);
    console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
    console.log(`[Orchestrator] ║ Address Offset:            ${this.addressOffset.toString().padStart(4, ' ')}                                    ║`);
    console.log(`[Orchestrator] ║ Address Range:             ${startIndex.toString().padStart(4, ' ')} - ${(endIndex - 1).toString().padStart(4, ' ')}                              ║`);
    console.log(`[Orchestrator] ║ Total Wallet Addresses:    ${finalAddressCount.toString().padStart(4, ' ')}                                    ║`);
    console.log(`[Orchestrator] ║ Addresses for This Miner:  ${this.addresses.length.toString().padStart(4, ' ')}                                    ║`);
    console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);
    
    if (this.addresses.length === 0) {
      console.error(`[Orchestrator] ❌ No addresses found in range ${startIndex}-${endIndex - 1} after expansion`);
      throw new Error(`No addresses available for offset ${this.addressOffset} (range ${startIndex}-${endIndex - 1}). This should not happen after automatic expansion.`);
    }

    // Load previously submitted solutions from receipts file
    this.loadSubmittedSolutions();

    // Register addresses that aren't registered yet
    this.ensureAddressesRegistered();

    // Check if we already have 10 dev fee addresses in cache, otherwise fetch
    console.log('[Orchestrator] Checking dev fee address pool...');
    let devFeeReady = devFeeManager.hasValidAddressPool();

    if (devFeeReady) {
      console.log('[Orchestrator] ✓ Dev fee enabled with 10 addresses (loaded from cache)');
    } else {
      console.log('[Orchestrator] No cached addresses found, fetching 10 dev fee addresses from API...');
      devFeeReady = await devFeeManager.prefetchAddressPool();
      if (devFeeReady) {
        console.log('[Orchestrator] ✓ Dev fee enabled with 10 addresses (fetched from API)');
      } else {
        console.log('[Orchestrator] ✗ Dev fee DISABLED - failed to fetch 10 addresses');
      }
    }

    // Dev fee will be checked after each solution submission (not on startup)

    this.isRunning = true;
    this.startTime = Date.now();
    this.solutionsFound = 0;

    // Start polling
    this.pollLoop();

    // Schedule hourly restart to clean workers and reset state
    this.scheduleHourlyRestart(password, this.addressOffset);

    this.emit('status', {
      type: 'status',
      active: true,
      challengeId: this.currentChallengeId,
    } as MiningEvent);
  }

  /**
   * Stop mining
   */
  stop(): void {
    this.isRunning = false;
    this.isMining = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Clear hourly restart timer
    if (this.hourlyRestartTimer) {
      clearTimeout(this.hourlyRestartTimer);
      this.hourlyRestartTimer = null;
    }

    this.emit('status', {
      type: 'status',
      active: false,
      challengeId: null,
    } as MiningEvent);
  }

  /**
   * Reinitialize the orchestrator - called when start button is clicked
   * This ensures fresh state and kicks off mining again
   * @param password - Wallet password
   * @param addressOffset - Address range offset (0 = addresses 0-199, 1 = 200-399, etc.). If undefined, uses persisted value.
   */
  async reinitialize(password: string, addressOffset?: number): Promise<void> {
    console.log('[Orchestrator] Reinitializing orchestrator...');

    // Stop current mining if running
    if (this.isRunning) {
      console.log('[Orchestrator] Stopping current mining session...');
      this.stop();
      await this.sleep(1000); // Give time for cleanup
    }

    // Reset state
    this.currentChallengeId = null;
    this.currentChallenge = null;
    this.isMining = false;
    this.addressesProcessedCurrentChallenge.clear();

    console.log('[Orchestrator] Reinitialization complete, starting fresh mining session...');

    // Start fresh with address offset (will use persisted if not provided)
    await this.start(password, addressOffset);
  }

  /**
   * Calculate CPU usage percentage
   */
  private calculateCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;

    if (this.lastCpuCheck) {
      const idleDiff = idle - this.lastCpuCheck.idle;
      const totalDiff = total - this.lastCpuCheck.total;
      const cpuPercentage = 100 - (100 * idleDiff / totalDiff);
      this.cpuUsage = Math.max(0, Math.min(100, cpuPercentage));
    }

    this.lastCpuCheck = { idle, total };
    return this.cpuUsage;
  }

  /**
   * Calculate solutions for time periods
   * Reads from receipts.jsonl to get accurate counts even after restart
   */
  private calculateTimePeriodSolutions(): {
    thisHour: number;
    previousHour: number;
    today: number;
    yesterday: number;
  } {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const currentHourStart = Math.floor(now / oneHour) * oneHour;
    const previousHourStart = currentHourStart - oneHour;

    // Get start of today and yesterday (midnight local time)
    const nowDate = new Date(now);
    const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const yesterdayStart = todayStart - (24 * 60 * 60 * 1000);

    let thisHour = 0;
    let previousHour = 0;
    let today = 0;
    let yesterday = 0;

    // Read all receipts from file (filters out dev fees automatically)
    const allReceipts = receiptsLogger.readReceipts();
    const receipts = allReceipts.filter(r => !r.isDevFee);

    for (const receipt of receipts) {
      const ts = new Date(receipt.ts).getTime();

      // Count this hour
      if (ts >= currentHourStart) {
        thisHour++;
      }
      // Count previous hour
      else if (ts >= previousHourStart && ts < currentHourStart) {
        previousHour++;
      }

      // Count today
      if (ts >= todayStart) {
        today++;
      }
      // Count yesterday
      else if (ts >= yesterdayStart && ts < todayStart) {
        yesterday++;
      }
    }

    return { thisHour, previousHour, today, yesterday };
  }

  /**
   * Get current mining stats
   */
  getStats(): MiningStats {
    // Calculate hash rate
    const now = Date.now();
    const elapsedSeconds = (now - this.lastHashRateUpdate) / 1000;
    const hashRate = elapsedSeconds > 0 ? this.totalHashesComputed / elapsedSeconds : 0;

    // Update CPU usage
    this.calculateCpuUsage();

    // Calculate time period solutions
    const timePeriodSolutions = this.calculateTimePeriodSolutions();

    return {
      active: this.isRunning,
      challengeId: this.currentChallengeId,
      solutionsFound: this.solutionsFound,
      registeredAddresses: this.addresses.filter(a => a.registered).length,
      totalAddresses: this.addresses.length,
      hashRate,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      startTime: this.startTime,
      cpuUsage: this.cpuUsage,
      addressesProcessedCurrentChallenge: this.addressesProcessedCurrentChallenge.size,
      solutionsThisHour: timePeriodSolutions.thisHour,
      solutionsPreviousHour: timePeriodSolutions.previousHour,
      solutionsToday: timePeriodSolutions.today,
      solutionsYesterday: timePeriodSolutions.yesterday,
      workerThreads: this.workerThreads,
    };
  }

  /**
   * Get address data including solved status for current challenge
   */
  getAddressesData() {
    if (!this.isRunning || this.addresses.length === 0) {
      return null;
    }

    return {
      addresses: this.addresses,
      currentChallengeId: this.currentChallengeId,
      solvedAddressChallenges: this.solvedAddressChallenges,
    };
  }

  /**
   * Main polling loop
   */
  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.pollAndMine();
    } catch (error: any) {
      Logger.error('mining', 'Poll error', error);
      this.emit('error', {
        type: 'error',
        message: error.message,
      } as MiningEvent);
    }

    // Schedule next poll
    this.pollTimer = setTimeout(() => this.pollLoop(), this.pollInterval);
  }

  /**
   * Poll challenge and start mining if new challenge
   */
  private async pollAndMine(): Promise<void> {
    const challenge = await this.fetchChallenge();

    if (challenge.code === 'before') {
      console.log('[Orchestrator] Mining not started yet. Starts at:', challenge.starts_at);
      return;
    }

    if (challenge.code === 'after') {
      console.log('[Orchestrator] Mining period ended');
      this.stop();
      return;
    }

    if (challenge.code === 'active' && challenge.challenge) {
      const challengeId = challenge.challenge.challenge_id;

      // New challenge detected
      if (challengeId !== this.currentChallengeId) {
        console.log('[Orchestrator] ========================================');
        console.log('[Orchestrator] NEW CHALLENGE DETECTED:', challengeId);
        console.log('[Orchestrator] Challenge data:', JSON.stringify(challenge.challenge, null, 2));
        console.log('[Orchestrator] ========================================');

        // IMPORTANT: Stop any ongoing mining first to prevent ROM errors
        if (this.isMining) {
          console.log('[Orchestrator] Stopping current mining for new challenge...');
          this.isMining = false;
          // Wait a bit for workers to finish their current batch
          await this.sleep(1000);
        }

        // CRITICAL: Kill all workers as they are working on void challenge solutions
        console.log('[Orchestrator] Killing all hash workers (old challenge solutions are void)...');
        try {
          await hashEngine.killWorkers();
          console.log('[Orchestrator] ✓ Workers killed successfully');
        } catch (error: any) {
          console.error('[Orchestrator] Failed to kill workers:', error.message);
        }

        // Reset challenge progress tracking
        this.addressesProcessedCurrentChallenge.clear();
        this.submittedSolutions.clear(); // Clear submitted solutions for new challenge
        
        // CRITICAL: Clear all failure counters for new challenge
        // This ensures addresses can be retried on new challenges even if they failed on previous ones
        this.addressSubmissionFailures.clear();
        console.log(`[Orchestrator] Cleared all address failure counters for new challenge`);

        // Initialize ROM
        const noPreMine = challenge.challenge.no_pre_mine;
        console.log('[Orchestrator] Initializing ROM for new challenge...');
        await hashEngine.initRom(noPreMine);

        // Wait for ROM to be ready
        const maxWait = 60000;
        const startWait = Date.now();

        while (!hashEngine.isRomReady() && (Date.now() - startWait) < maxWait) {
          await this.sleep(500);
        }

        if (!hashEngine.isRomReady()) {
          throw new Error('ROM initialization timeout');
        }

        console.log('[Orchestrator] ROM ready');

        this.currentChallengeId = challengeId;
        this.currentChallenge = challenge.challenge;

        // Load challenge state from receipts (restore progress, solutions count, etc.)
        this.loadChallengeState(challengeId);

        // Emit status
        this.emit('status', {
          type: 'status',
          active: true,
          challengeId,
        } as MiningEvent);

        // Start mining for this challenge
        if (!this.isMining) {
          this.startMining();
        }
      } else {
        // Same challenge, but update dynamic fields (latest_submission, no_pre_mine_hour)
        // These change frequently as solutions are submitted across the network

        // Check if difficulty changed (happens hourly on no_pre_mine_hour updates)
        if (this.currentChallenge && challenge.challenge.difficulty !== this.currentChallenge.difficulty) {
          const oldDifficulty = this.currentChallenge.difficulty;
          const newDifficulty = challenge.challenge.difficulty;
          const oldZeroBits = getDifficultyZeroBits(oldDifficulty);
          const newZeroBits = getDifficultyZeroBits(newDifficulty);

          console.log('[Orchestrator] ⚠ DIFFICULTY CHANGED ⚠');
          console.log(`[Orchestrator] Old difficulty: ${oldDifficulty} (${oldZeroBits} zero bits)`);
          console.log(`[Orchestrator] New difficulty: ${newDifficulty} (${newZeroBits} zero bits)`);

          if (newZeroBits > oldZeroBits) {
            console.log('[Orchestrator] ⚠ Difficulty INCREASED - solutions in progress may be rejected!');
          } else {
            console.log('[Orchestrator] ✓ Difficulty DECREASED - solutions in progress remain valid');
          }
        }

        this.currentChallenge = challenge.challenge;
      }
    }
  }

  /**
   * Get dynamically filtered list of addresses available for mining
   * This refreshes the registered addresses list and filters out solved addresses
   * Called before each address iteration to pick up newly registered addresses
   */
  private getAvailableAddressesForMining(): DerivedAddress[] {
    const currentChallengeId = this.currentChallengeId;
    if (!currentChallengeId) {
      return [];
    }

    // Dynamically get currently registered addresses (may include newly registered ones)
    const registeredAddresses = this.addresses.filter(a => a.registered);

    // Filter out addresses that have already solved this challenge
    const availableAddresses = registeredAddresses.filter(addr => {
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      const alreadySolved = solvedChallenges && solvedChallenges.has(currentChallengeId);
      return !alreadySolved;
    });

    return availableAddresses;
  }

  /**
   * Mine a single address with a specific range of workers
   * Helper method for parallel address mining
   */
  private async mineAddressWithWorkers(
    addr: DerivedAddress,
    challengeId: string,
    workerStartId: number,
    workerEndId: number,
    addressesInProgress: Set<string>,
    lastMineAttempt: Map<string, number>
  ): Promise<void> {
    const MAX_SUBMISSION_FAILURES = 6;
    const MIN_RETRY_DELAY = 30000;
    const now = Date.now();
    
    // CRITICAL: Reset failure counter if we're retrying after delay
    const submissionKey = `${addr.bech32}:${challengeId}`;
    const lastAttempt = lastMineAttempt.get(addr.bech32);
    const timeSinceLastAttempt = lastAttempt ? (now - lastAttempt) : 0;
    
    if (timeSinceLastAttempt >= MIN_RETRY_DELAY) {
      const failureCount = this.addressSubmissionFailures.get(submissionKey);
      if (failureCount && failureCount > 0) {
        console.log(`[Orchestrator] Retrying address ${addr.index} after delay - clearing previous failure count (${failureCount})`);
        this.addressSubmissionFailures.delete(submissionKey);
      }
    }

    console.log(`[Orchestrator] ========================================`);
    console.log(`[Orchestrator] Starting mining for address ${addr.index} (workers ${workerStartId}-${workerEndId - 1})`);
    console.log(`[Orchestrator] Address: ${addr.bech32.slice(0, 20)}...`);
    console.log(`[Orchestrator] Max allowed failures: ${MAX_SUBMISSION_FAILURES}`);
    console.log(`[Orchestrator] ========================================`);

    // Set current mining address for this address group (only if single address mode)
    if (this.maxConcurrentAddresses === 1) {
      this.currentMiningAddress = addr.bech32;
    }

    // Clear stopped workers set for this address
    this.stoppedWorkers.clear();

    // Launch workers for this address
    const userWorkerCount = workerEndId - workerStartId;
    const workers = Array(userWorkerCount).fill(null).map((_, idx) =>
      this.mineForAddress(addr, false, workerStartId + idx, MAX_SUBMISSION_FAILURES)
    );

    // Wait for ALL workers to complete
    try {
      await Promise.all(workers);
    } catch (error) {
      console.error(`[Orchestrator] Error in workers for address ${addr.index}:`, error);
    } finally {
      // Always remove from in-progress set
      addressesInProgress.delete(addr.bech32);
    }

    // Check if address was successfully solved
    const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
    const addressSolved = solvedChallenges?.has(challengeId) || false;

    if (addressSolved) {
      console.log(`[Orchestrator] ✓ Address ${addr.index} SOLVED!`);
      lastMineAttempt.delete(addr.bech32);
    } else {
      console.log(`[Orchestrator] ✗ Address ${addr.index} FAILED after ${MAX_SUBMISSION_FAILURES} attempts.`);
      console.log(`[Orchestrator] Will retry this address after ${MIN_RETRY_DELAY / 1000}s (challenge data may have updated)`);
    }
  }

  /**
   * Start mining loop for current challenge
   */
  private async startMining(): Promise<void> {
    if (this.isMining || !this.currentChallenge || !this.currentChallengeId) {
      return;
    }

    this.isMining = true;
    const currentChallengeId = this.currentChallengeId;

    // Get initial count for logging
    const initialRegisteredCount = this.addresses.filter(a => a.registered).length;
    const logMsg = `Starting mining with ${this.workerThreads} parallel workers on ${initialRegisteredCount} registered addresses`;
    console.log(`[Orchestrator] ${logMsg}`);

    // Emit to UI log
    this.emit('status', {
      type: 'status',
      active: true,
      challengeId: this.currentChallengeId,
    } as MiningEvent);

    // Reset hash rate tracking
    this.totalHashesComputed = 0;
    this.lastHashRateUpdate = Date.now();

    // Track addresses that are currently being mined to avoid duplicate work
    // But allow retries after failures (don't permanently block addresses)
    const addressesInProgress = new Set<string>();
    const lastMineAttempt = new Map<string, number>(); // Track when we last tried each address
    const MIN_RETRY_DELAY = 30000; // Retry failed addresses after 30 seconds

    // Mine addresses dynamically - refresh list before each iteration to pick up newly registered addresses
    // This ensures that as addresses finish registering in the background, they automatically become available for mining
    while (this.isRunning && this.isMining && this.currentChallengeId === currentChallengeId) {
      // Dynamically get available addresses (includes newly registered ones)
      const addressesToMine = this.getAvailableAddressesForMining();

      // Filter out addresses currently being mined, but allow retries after delay
      const now = Date.now();
      const newAddressesToMine = addressesToMine.filter(addr => {
        // Skip if currently being mined
        if (addressesInProgress.has(addr.bech32)) {
          return false;
        }
        
        // Allow retry if enough time has passed since last attempt
        const lastAttempt = lastMineAttempt.get(addr.bech32);
        if (lastAttempt && (now - lastAttempt) < MIN_RETRY_DELAY) {
          return false;
        }
        
        return true;
      });

      // Log current status
      const registeredCount = this.addresses.filter(a => a.registered).length;
      console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
      console.log(`[Orchestrator] ║ DYNAMIC ADDRESS QUEUE (refreshed each iteration)          ║`);
      console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
      const addressesInProgressCount = addressesInProgress.size;
      const addressesWaitingRetry = addressesToMine.filter(addr => {
        const lastAttempt = lastMineAttempt.get(addr.bech32);
        return lastAttempt && (now - lastAttempt) < MIN_RETRY_DELAY && !addressesInProgress.has(addr.bech32);
      }).length;
      
      console.log(`[Orchestrator] ║ Total addresses loaded:        ${this.addresses.length.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Registered addresses:          ${registeredCount.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Available to mine:             ${addressesToMine.length.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Ready to mine now:             ${newAddressesToMine.length.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Currently mining:              ${addressesInProgressCount.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Waiting for retry:             ${addressesWaitingRetry.toString().padStart(3, ' ')}                       ║`);
      console.log(`[Orchestrator] ║ Challenge ID:                  ${currentChallengeId?.slice(0, 10)}...            ║`);
      console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);

      // If no new addresses available, check if we should wait or continue
      if (newAddressesToMine.length === 0) {
        const allRegisteredCount = this.addresses.filter(a => a.registered).length;
        const allAvailableCount = addressesToMine.length;
        const unregisteredCount = this.addresses.length - registeredCount;

        if (allAvailableCount === 0 && allRegisteredCount > 0) {
          // All registered addresses have been solved for this challenge
          console.log(`[Orchestrator] ✓ All ${allRegisteredCount} registered addresses have been solved for this challenge`);
          console.log(`[Orchestrator] Waiting for new challenge...`);
          // Don't exit - keep polling for new challenges
          await this.sleep(5000);
          continue;
        } else if (addressesInProgressCount > 0) {
          // Some addresses are currently being mined, wait for them to finish
          console.log(`[Orchestrator] ⏳ ${addressesInProgressCount} addresses currently being mined, waiting...`);
          await this.sleep(2000);
          continue;
        } else if (addressesWaitingRetry > 0) {
          // Some addresses are waiting for retry delay
          const nextRetryIn = Math.min(...Array.from(lastMineAttempt.values()).map(t => Math.max(0, MIN_RETRY_DELAY - (now - t))));
          console.log(`[Orchestrator] ⏳ ${addressesWaitingRetry} addresses waiting for retry (next retry in ${Math.ceil(nextRetryIn / 1000)}s)`);
          await this.sleep(Math.min(5000, nextRetryIn + 1000));
          continue;
        } else if (unregisteredCount > 0) {
          // Some addresses are still being registered
          console.log(`[Orchestrator] ⏳ ${unregisteredCount} addresses still registering...`);
          console.log(`[Orchestrator] Waiting for registration to complete (will automatically pick up new addresses)`);
          await this.sleep(5000);
          continue;
        } else {
          // No addresses available - this shouldn't happen if we have addresses
          console.log(`[Orchestrator] ⚠️  No addresses available to mine`);
          console.log(`[Orchestrator] Waiting and will retry...`);
          await this.sleep(10000);
          continue;
        }
      }

      // Process multiple addresses in parallel for high-end systems
      // Take up to maxConcurrentAddresses addresses at once
      const addressesToProcess = newAddressesToMine.slice(0, this.maxConcurrentAddresses);
      
      // Launch mining for all selected addresses in parallel
      const miningPromises = addressesToProcess.map((addr, idx) => {
        addressesInProgress.add(addr.bech32);
        lastMineAttempt.set(addr.bech32, now);
        
        // Calculate worker ID range for this address
        // Distribute workers across addresses: address 0 gets workers 0-N, address 1 gets workers N+1-2N, etc.
        const totalUserWorkers = Math.floor(this.workerThreads * 0.8);
        const workersPerAddress = Math.max(10, Math.floor(totalUserWorkers / addressesToProcess.length));
        const workerStartId = idx * workersPerAddress;
        const workerEndId = Math.min(workerStartId + workersPerAddress, totalUserWorkers);
        
        return this.mineAddressWithWorkers(addr, currentChallengeId, workerStartId, workerEndId, addressesInProgress, lastMineAttempt);
      });
      
      // Wait for at least one address to finish (or all if they all fail)
      await Promise.race([
        Promise.allSettled(miningPromises),
        // Also resolve if any address is solved (to immediately pick up next address)
        new Promise(resolve => {
          const checkInterval = setInterval(() => {
            const anySolved = addressesToProcess.some(addr => {
              const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
              return solvedChallenges?.has(currentChallengeId);
            });
            if (anySolved) {
              clearInterval(checkInterval);
              resolve(null);
            }
          }, 1000);
          // Cleanup after 5 minutes max
          setTimeout(() => clearInterval(checkInterval), 300000);
        })
      ]);
      
      continue; // Continue to next iteration to pick up new addresses

      // After solution submitted or max failures, continue to next address
      // The 2-second poll will refresh challenge data, and failed addresses will be retried after delay
    }

    // Only set isMining to false if we're actually stopping (not just waiting)
    if (!this.isRunning || this.currentChallengeId !== currentChallengeId) {
      this.isMining = false;
      console.log(`[Orchestrator] Mining loop exited: isRunning=${this.isRunning}, challengeChanged=${this.currentChallengeId !== currentChallengeId}`);
    }
  }

  /**
   * Mine for a specific address
   * Note: This should only be called for address+challenge combinations that haven't been solved yet
   * @param addr - The address to mine for
   * @param isDevFee - Whether this is a dev fee mining operation (default: false)
   * @param workerId - Unique worker ID (0-9) to ensure different nonce generation per worker (default: 0)
   * @param maxFailures - Maximum number of submission failures allowed for this address (default: 10)
   */
  private async mineForAddress(addr: DerivedAddress, isDevFee: boolean = false, workerId: number = 0, maxFailures: number = 10): Promise<void> {
    if (!this.currentChallenge || !this.currentChallengeId) return;

    // Check if this worker should be mining for this address
    if (!isDevFee && this.currentMiningAddress !== addr.bech32) {
      console.log(`[Orchestrator] Worker ${workerId}: Skipping address ${addr.index} - not current mining address`);
      return;
    }

    // Capture challenge details at START to prevent race conditions
    // CRITICAL: Make a DEEP COPY of the challenge object to prevent the polling loop
    // from updating our captured challenge data while we're mining
    const challengeId = this.currentChallengeId;
    const challenge = JSON.parse(JSON.stringify(this.currentChallenge)); // Deep copy to freeze challenge data
    const difficulty = challenge.difficulty;

    // ROM should already be ready from pollAndMine - quick check only
    if (!hashEngine.isRomReady()) {
      console.error(`[Orchestrator] ROM not ready for address ${addr.index}`);
      return;
    }

    // Mark this address as having processed the current challenge
    this.addressesProcessedCurrentChallenge.add(addr.index);

    // Initialize worker stats
    const workerStartTime = Date.now();
    this.workerStats.set(workerId, {
      workerId,
      addressIndex: addr.index,
      address: addr.bech32,
      hashesComputed: 0,
      hashRate: 0,
      solutionsFound: 0,
      startTime: workerStartTime,
      lastUpdateTime: workerStartTime,
      status: 'mining',
      currentChallenge: challengeId,
    });

    // Log difficulty for debugging
    const requiredZeroBits = getDifficultyZeroBits(difficulty);
    const startMsg = `Worker ${workerId} for Address ${addr.index}: Starting to mine (requires ${requiredZeroBits} leading zero bits)`;
    console.log(`[Orchestrator] ${startMsg}`);

    // Emit mining start event
    this.emit('mining_start', {
      type: 'mining_start',
      address: addr.bech32,
      addressIndex: addr.index,
      challengeId,
    } as MiningEvent);

    const BATCH_SIZE = this.getBatchSize(); // Use dynamic batch size (custom or default 300)
    const PROGRESS_INTERVAL = 1; // Emit progress every batch for updates
    let hashCount = 0;
    let batchCounter = 0;
    let lastProgressTime = Date.now();

    // Sequential nonce range for this worker (like midnight-scavenger-bot)
    const NONCE_RANGE_SIZE = 1_000_000_000; // 1 billion per worker
    const nonceStart = workerId * NONCE_RANGE_SIZE;
    const nonceEnd = nonceStart + NONCE_RANGE_SIZE;
    let currentNonce = nonceStart;

    // Mine continuously with sequential nonces using BATCH processing
    while (this.isRunning && this.isMining && this.currentChallengeId === challengeId && currentNonce < nonceEnd) {
      // Check if we're still mining the correct address
      // For parallel address mining (maxConcurrentAddresses > 1), workers are assigned to specific addresses
      // In that case, we don't check currentMiningAddress since multiple addresses can be active
      if (!isDevFee && this.maxConcurrentAddresses === 1 && this.currentMiningAddress !== addr.bech32) {
        console.log(`[Orchestrator] Worker ${workerId}: Current address changed (was ${addr.index}), stopping`);
        return;
      }

      // Check if max submission failures reached for this address
      const submissionKey = `${addr.bech32}:${challengeId}`;
      const failureCount = this.addressSubmissionFailures.get(submissionKey) || 0;
      if (failureCount >= maxFailures) {
        console.log(`[Orchestrator] Worker ${workerId}: Max failures (${maxFailures}) reached for address ${addr.index}, stopping`);
        return;
      }

      // Check if address is already solved
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      if (solvedChallenges?.has(challengeId)) {
        console.log(`[Orchestrator] Worker ${workerId}: Address ${addr.index} already solved, stopping`);
        return;
      }

      // Check if this worker should stop immediately (another worker found solution)
      if (this.stoppedWorkers.has(workerId)) {
        console.log(`[Orchestrator] Worker ${workerId}: Stopped by solution from another worker`);
        // Update worker status to idle
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.status = 'idle';
          // Emit final worker update
          this.emit('worker_update', {
            type: 'worker_update',
            workerId,
            addressIndex: addr.index,
            address: addr.bech32,
            hashesComputed: workerData.hashesComputed,
            hashRate: 0,
            solutionsFound: workerData.solutionsFound,
            status: 'idle',
            currentChallenge: challengeId,
          } as MiningEvent);
        }
        return;
      }

      // Pause this worker if address is being submitted by another worker
      const pauseKey = `${addr.bech32}:${challengeId}`;
      if (this.pausedAddresses.has(pauseKey)) {
        // Wait a bit and check again
        await this.sleep(100);
        continue;
      }

      batchCounter++;

      // Generate batch of sequential nonces and preimages (like midnight-scavenger-bot)
      const batchData: Array<{ nonce: string; preimage: string }> = [];
      for (let i = 0; i < BATCH_SIZE && (currentNonce + i) < nonceEnd; i++) {
        // Check if this worker should stop immediately
        if (this.stoppedWorkers.has(workerId)) {
          console.log(`[Orchestrator] Worker ${workerId}: Stopped during batch generation (another worker found solution)`);
          return;
        }

        if (!this.isRunning || !this.isMining || this.currentChallengeId !== challengeId) {
          break;
        }

        // Check if paused during batch generation
        if (this.pausedAddresses.has(pauseKey)) {
          break;
        }

        const nonceNum = currentNonce + i;
        const nonceHex = nonceNum.toString(16).padStart(16, '0'); // Sequential nonce
        const preimage = buildPreimage(
          nonceHex,
          addr.bech32,
          challenge, // Use captured challenge to prevent race condition
          hashCount === 0 && i === 0 // Debug first hash
        );

        batchData.push({ nonce: nonceHex, preimage });
      }

      // Advance nonce counter for next batch
      currentNonce += batchData.length;

      if (batchData.length === 0) break;

      try {
        // Send entire batch to Rust service for PARALLEL processing
        const preimages = batchData.map(d => d.preimage);
        const hashes = await hashEngine.hashBatchAsync(preimages);

        // CRITICAL: Check if challenge changed while we were computing hashes
        if (this.currentChallengeId !== challengeId) {
          console.log(`[Orchestrator] Worker ${workerId}: Challenge changed during hash computation (${challengeId.slice(0, 8)}... -> ${this.currentChallengeId?.slice(0, 8)}...), discarding batch`);
          return; // Stop mining for this address, new challenge will restart
        }

        this.totalHashesComputed += hashes.length;
        hashCount += hashes.length;

        // Log first hash for debugging (only once per address)
        if (hashCount === hashes.length) {
          console.log(`[Orchestrator] Sample hash for address ${addr.index}:`, hashes[0].slice(0, 16) + '...');
          console.log(`[Orchestrator] Target difficulty:                     ${difficulty.slice(0, 16)}...`);
          console.log(`[Orchestrator] Preimage (first 120 chars):`, batchData[0].preimage.slice(0, 120));
          const meetsTarget = matchesDifficulty(hashes[0], difficulty);
          console.log(`[Orchestrator] Hash meets difficulty? ${meetsTarget}`);
        }

        // Check all hashes for solutions
        for (let i = 0; i < hashes.length; i++) {
          const hash = hashes[i];
          const { nonce, preimage } = batchData[i];

          if (matchesDifficulty(hash, difficulty)) {
            // Check if we already submitted this exact hash
            if (this.submittedSolutions.has(hash)) {
              console.log('[Orchestrator] Duplicate solution found (already submitted), skipping:', hash.slice(0, 16) + '...');
              continue;
            }

            // Check if another worker is already submitting for this address+challenge
            const submissionKey = `${addr.bech32}:${challengeId}`;
            if (this.submittingAddresses.has(submissionKey)) {
              console.log(`[Orchestrator] Worker ${workerId}: Another worker is already submitting for this address, stopping this worker`);
              return; // Exit this worker - another worker is handling submission
            }

            // Mark as submitting to prevent other workers from submitting
            this.submittingAddresses.add(submissionKey);

            // IMMEDIATELY stop all other workers MINING THE SAME ADDRESS to save CPU
            // Dev fee workers: only stop other dev fee workers (not user workers)
            // User workers: only stop other user workers (not dev fee workers)
            const userWorkerCount = Math.floor(this.workerThreads * 0.8);

            if (isDevFee) {
              // Stop other dev fee workers (IDs >= userWorkerCount)
              console.log(`[Orchestrator] Worker ${workerId}: Dev fee solution found! Stopping other dev fee workers`);
              for (let i = userWorkerCount; i < this.workerThreads; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                }
              }
            } else {
              // Stop other user workers (IDs < userWorkerCount)
              console.log(`[Orchestrator] Worker ${workerId}: User solution found! Stopping other user workers`);
              for (let i = 0; i < userWorkerCount; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                }
              }
            }

            // PAUSE all workers for this address while we submit
            this.pausedAddresses.add(submissionKey);
            console.log(`[Orchestrator] Worker ${workerId}: Pausing all workers for this address while submitting`);

            // Update worker status to submitting
            const workerData = this.workerStats.get(workerId);
            if (workerData) {
              workerData.status = 'submitting';
              workerData.solutionsFound++;
            }

            // Solution found!
            console.log('[Orchestrator] ========== SOLUTION FOUND ==========');
            console.log('[Orchestrator] Worker ID:', workerId);
            console.log('[Orchestrator] Address:', addr.bech32);
            console.log('[Orchestrator] Nonce:', nonce);
            console.log('[Orchestrator] Challenge ID (captured):', challengeId);
            console.log('[Orchestrator] Challenge ID (current):', this.currentChallengeId);
            console.log('[Orchestrator] Difficulty (captured):', difficulty);
            console.log('[Orchestrator] Difficulty (current):', this.currentChallenge?.difficulty);
            console.log('[Orchestrator] Required zero bits:', getDifficultyZeroBits(difficulty));
            console.log('[Orchestrator] Hash:', hash.slice(0, 32) + '...');
            console.log('[Orchestrator] Full hash:', hash);
            console.log('[Orchestrator] Full preimage:', preimage);
            console.log('[Orchestrator] ====================================');

            // Mark as submitted before submitting to avoid race conditions
            this.submittedSolutions.add(hash);

            // DON'T mark as solved yet - only mark after successful submission
            // This allows retry if submission fails

            // Emit solution submit event
            this.emit('solution_submit', {
              type: 'solution_submit',
              address: addr.bech32,
              addressIndex: addr.index,
              challengeId,
              nonce,
              preimage: preimage.slice(0, 50) + '...',
            } as MiningEvent);

            // CRITICAL: Double-check challenge hasn't changed before submitting
            if (this.currentChallengeId !== challengeId) {
              console.log(`[Orchestrator] Worker ${workerId}: Challenge changed before submission (${challengeId.slice(0, 8)}... -> ${this.currentChallengeId?.slice(0, 8)}...), discarding solution`);
              this.pausedAddresses.delete(submissionKey);
              this.submittingAddresses.delete(submissionKey);
              return; // Don't submit solution for old challenge
            }

            console.log(`[Orchestrator] Worker ${workerId}: Captured challenge data during mining:`);
            console.log(`[Orchestrator]   latest_submission: ${challenge.latest_submission}`);
            console.log(`[Orchestrator]   no_pre_mine_hour: ${challenge.no_pre_mine_hour}`);
            console.log(`[Orchestrator]   difficulty: ${challenge.difficulty}`);

            // CRITICAL VALIDATION: Verify the server will compute the SAME hash we did
            // Server rebuilds preimage from nonce using ITS challenge data, then validates
            // If server's challenge data differs from ours, it computes a DIFFERENT hash!
            console.log(`[Orchestrator] Worker ${workerId}: Validating solution will pass server checks...`);

            if (this.currentChallenge) {
              console.log(`[Orchestrator] Worker ${workerId}: Current challenge data (what server has):`);
              console.log(`[Orchestrator]   latest_submission: ${this.currentChallenge.latest_submission}`);
              console.log(`[Orchestrator]   no_pre_mine_hour: ${this.currentChallenge.no_pre_mine_hour}`);
              console.log(`[Orchestrator]   difficulty: ${this.currentChallenge.difficulty}`);

              // Check if challenge data changed (excluding difficulty which is checked separately)
              const dataChanged =
                challenge.latest_submission !== this.currentChallenge.latest_submission ||
                challenge.no_pre_mine_hour !== this.currentChallenge.no_pre_mine_hour ||
                challenge.no_pre_mine !== this.currentChallenge.no_pre_mine;

              if (dataChanged) {
                console.log(`[Orchestrator] Worker ${workerId}: ⚠️  Challenge data CHANGED since mining!`);
                console.log(`[Orchestrator]   Recomputing hash with current challenge data to verify server will accept...`);

                // Rebuild preimage with CURRENT challenge data (what server will use)
                const serverPreimage = buildPreimage(nonce, addr.bech32, this.currentChallenge, false);

                // Compute what hash the SERVER will get
                const serverHash = await hashEngine.hashBatchAsync([serverPreimage]);
                const serverHashHex = serverHash[0];

                console.log(`[Orchestrator]   Our hash:     ${hash.slice(0, 32)}...`);
                console.log(`[Orchestrator]   Server hash:  ${serverHashHex.slice(0, 32)}...`);

                // Check if server's hash will meet difficulty
                const serverHashValid = matchesDifficulty(serverHashHex, this.currentChallenge.difficulty);
                console.log(`[Orchestrator]   Server hash meets difficulty? ${serverHashValid}`);

                if (!serverHashValid) {
                  console.log(`[Orchestrator] Worker ${workerId}: ✗ Server will REJECT this solution!`);
                  console.log(`[Orchestrator]   Our hash met difficulty but server's recomputed hash does NOT`);
                  console.log(`[Orchestrator]   This is why we get "Solution does not meet difficulty" errors!`);
                  console.log(`[Orchestrator]   Discarding solution to avoid wasting API call and stopping workers`);

                  // Clean up and continue mining
                  this.pausedAddresses.delete(submissionKey);
                  this.submittingAddresses.delete(submissionKey);
                  continue; // Don't submit, keep mining
                } else {
                  console.log(`[Orchestrator] Worker ${workerId}: ✓ Server hash WILL be valid, safe to submit`);
                }
              } else {
                console.log(`[Orchestrator] Worker ${workerId}: ✓ Challenge data unchanged, hash will be identical on server`);
              }
            }

            // Submit immediately with the challenge data we used during mining
            // Like midnight-scavenger-bot: no fresh fetch, no recomputation, just submit
            console.log(`[Orchestrator] Worker ${workerId}: Submitting solution to API...`);

            // CRITICAL: Check if difficulty changed during mining
            // If difficulty increased (more zero bits required), our solution may no longer be valid
            if (this.currentChallenge && this.currentChallenge.difficulty !== difficulty) {
              const currentDifficulty = this.currentChallenge.difficulty;
              const capturedZeroBits = getDifficultyZeroBits(difficulty);
              const currentZeroBits = getDifficultyZeroBits(currentDifficulty);

              console.log(`[Orchestrator] Worker ${workerId}: Difficulty changed during mining!`);
              console.log(`[Orchestrator]   Captured difficulty: ${difficulty} (${capturedZeroBits} zero bits)`);
              console.log(`[Orchestrator]   Current difficulty:  ${currentDifficulty} (${currentZeroBits} zero bits)`);

              // Re-validate solution with CURRENT difficulty
              const stillValid = matchesDifficulty(hash, currentDifficulty);
              console.log(`[Orchestrator]   Solution still valid with current difficulty? ${stillValid}`);

              if (!stillValid) {
                console.log(`[Orchestrator] Worker ${workerId}: Solution no longer meets current difficulty (${currentZeroBits} zero bits), discarding`);
                this.pausedAddresses.delete(submissionKey);
                this.submittingAddresses.delete(submissionKey);
                // Remove from solved set so we can keep mining for this address
                const solvedSet = this.solvedAddressChallenges.get(addr.bech32);
                if (solvedSet) {
                  solvedSet.delete(challengeId);
                }
                // Continue mining - don't return, let the worker keep going
                continue;
              } else {
                console.log(`[Orchestrator] Worker ${workerId}: Solution STILL VALID with increased difficulty, proceeding with submission`);
              }
            }

            // Submit solution (pass the captured challengeId to prevent race condition)
            let submissionSuccess = false;
            try {
              await this.submitSolution(addr, challengeId, nonce, hash, preimage, isDevFee, workerId);

              // Mark as solved ONLY after successful submission (no exception thrown)
              if (!this.solvedAddressChallenges.has(addr.bech32)) {
                this.solvedAddressChallenges.set(addr.bech32, new Set());
              }
              this.solvedAddressChallenges.get(addr.bech32)!.add(challengeId);
              console.log(`[Orchestrator] Worker ${workerId}: Marked address ${addr.index} as solved for challenge ${challengeId.slice(0, 8)}...`);

              // Set success flag AFTER marking as solved - this ensures we only reach here if no exception was thrown
              submissionSuccess = true;
            } catch (error: any) {
              const errorMessage = error?.response?.data?.message || error?.message || '';
              const statusCode = error?.response?.status;
              
              // Check if this is a duplicate/conflict error (address already solved by another instance)
              const isDuplicate = 
                statusCode === 400 || 
                statusCode === 409 ||
                errorMessage.toLowerCase().includes('already submitted') ||
                errorMessage.toLowerCase().includes('duplicate') ||
                errorMessage.toLowerCase().includes('already solved') ||
                errorMessage.toLowerCase().includes('conflict');
              
              if (isDuplicate) {
                console.log(`[Orchestrator] Worker ${workerId}: Solution already submitted by another instance - marking as solved`);
                // Mark as solved even though we didn't submit (another instance did)
                if (!this.solvedAddressChallenges.has(addr.bech32)) {
                  this.solvedAddressChallenges.set(addr.bech32, new Set());
                }
                this.solvedAddressChallenges.get(addr.bech32)!.add(challengeId);
                submissionSuccess = true; // Treat as success - address is solved
              } else {
                console.error(`[Orchestrator] Worker ${workerId}: Submission failed:`, error.message);
                submissionSuccess = false;
              }

              // Increment failure counter for this address
              const currentFailures = this.addressSubmissionFailures.get(submissionKey) || 0;
              this.addressSubmissionFailures.set(submissionKey, currentFailures + 1);
              console.log(`[Orchestrator] Worker ${workerId}: Submission failure ${currentFailures + 1}/${maxFailures} for address ${addr.index}`);
            } finally {
              // Always remove submission lock
              this.submittingAddresses.delete(submissionKey);

              // If submission succeeded, keep paused (will exit via return below)
              // If submission failed, resume workers to retry
              if (!submissionSuccess) {
                console.log(`[Orchestrator] Worker ${workerId}: Resuming all workers to find new solution for this address`);
                this.pausedAddresses.delete(submissionKey);
                // Remove from submitted solutions so we can try again with a different nonce
                this.submittedSolutions.delete(hash);
                // Resume stopped workers so they can continue mining
                this.stoppedWorkers.clear();
                // Don't return - continue mining
                continue;
              } else {
                // Submission succeeded - stop all workers for this address
                this.pausedAddresses.delete(submissionKey);
                // Clear failure counter on success
                this.addressSubmissionFailures.delete(submissionKey);
              }
            }

            // Update worker status to completed
            const finalWorkerData = this.workerStats.get(workerId);
            if (finalWorkerData) {
              finalWorkerData.status = 'completed';
            }

            // IMPORTANT: Stop mining for this address after finding a solution
            // Each address should only submit ONE solution per challenge
            // When this worker returns, Promise.race will stop all other workers
            const logPrefix = isDevFee ? '[DEV FEE]' : '';
            console.log(`[Orchestrator] ${logPrefix} Worker ${workerId} for Address ${addr.index}: Solution submitted, all workers stopping for this address`);
            return; // Exit the mineForAddress function - stops all workers via Promise.race
          }
        }
      } catch (error: any) {
        // Check if this is a hash service timeout (408) - suggests server overload
        const is408Timeout = error.message && error.message.includes('408');
        const isTimeout = error.message && (error.message.includes('timeout') || error.message.includes('ETIMEDOUT'));

        if (is408Timeout || isTimeout) {
          console.error(`[Orchestrator] Worker ${workerId}: Hash service timeout (408) - server may be overloaded`);
          console.error(`[Orchestrator] Worker ${workerId}: Error: ${error.message}`);

          // Log suggestion for user
          this.emit('error', {
            type: 'error',
            message: `Hash service timeout on worker ${workerId}. Server may be overloaded. Consider reducing batch size or worker count.`,
          } as MiningEvent);

          // Wait a bit before retrying to give server time to recover
          await this.sleep(2000);
          continue; // Skip this batch and try next one
        }

        Logger.error('mining', 'Batch hash computation error', error);

        // For other errors, wait a bit and continue
        await this.sleep(1000);
      }

      // Emit progress event every PROGRESS_INTERVAL batches
      // Only log to console every 10 batches to reduce noise
      if (batchCounter % PROGRESS_INTERVAL === 0) {
        const now = Date.now();
        const elapsedSeconds = (now - lastProgressTime) / 1000;
        const hashRate = elapsedSeconds > 0 ? Math.round((BATCH_SIZE * PROGRESS_INTERVAL) / elapsedSeconds) : 0;
        lastProgressTime = now;

        // Update worker stats
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.hashesComputed = hashCount;
          workerData.hashRate = hashRate;
          workerData.lastUpdateTime = now;

          // Emit worker update event
          this.emit('worker_update', {
            type: 'worker_update',
            workerId,
            addressIndex: addr.index,
            address: addr.bech32,
            hashesComputed: hashCount,
            hashRate,
            solutionsFound: workerData.solutionsFound,
            status: workerData.status,
            currentChallenge: challengeId,
          } as MiningEvent);
        }

        // Only log every 100th progress update to console (reduced logging frequency)
        if (batchCounter % (PROGRESS_INTERVAL * 100) === 0) {
          const progressMsg = `Worker ${workerId} for Address ${addr.index}: ${hashCount.toLocaleString()} hashes @ ${hashRate.toLocaleString()} H/s (Challenge: ${challengeId.slice(0, 8)}...)`;
          console.log(`[Orchestrator] ${progressMsg}`);
        }

        this.emit('hash_progress', {
          type: 'hash_progress',
          address: addr.bech32,
          addressIndex: addr.index,
          hashesComputed: hashCount,
          totalHashes: hashCount,
        } as MiningEvent);

        // Emit stats update
        this.emit('stats', {
          type: 'stats',
          stats: this.getStats(),
        } as MiningEvent);
      }
    }
  }

  /**
   * Submit solution to API
   * API format: POST /solution/{address}/{challenge_id}/{nonce}
   */
  private async submitSolution(addr: DerivedAddress, challengeId: string, nonce: string, hash: string, preimage: string, isDevFee: boolean = false, workerId: number = 0): Promise<void> {
    if (!this.walletManager) return;

    try {
      // Correct API endpoint: /solution/{address}/{challenge_id}/{nonce}
      // CRITICAL: Use the challengeId parameter (captured when hash was computed) not this.currentChallengeId
      const submitUrl = `${this.apiBase}/solution/${addr.bech32}/${challengeId}/${nonce}`;
      const logPrefix = isDevFee ? '[DEV FEE]' : '';
      console.log(`[Orchestrator] ${logPrefix} Worker ${workerId} submitting solution:`, {
        url: submitUrl,
        nonce,
        hash,
        preimageLength: preimage.length,
      });

      console.log(`[Orchestrator] ${logPrefix} Making POST request...`);
      const response = await axios.post(submitUrl, {}, {
        timeout: 30000, // 30 second timeout
        validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      });

      console.log(`[Orchestrator] ${logPrefix} Response received!`, {
        statusCode: response.status,
        statusText: response.statusText,
      });

      if (response.status >= 200 && response.status < 300) {
        console.log(`[Orchestrator] ${logPrefix} ✓ Solution ACCEPTED by server! Worker ${workerId}`, {
          statusCode: response.status,
          statusText: response.statusText,
          responseData: response.data,
          cryptoReceipt: response.data?.crypto_receipt,
        });
      } else {
        console.log(`[Orchestrator] ${logPrefix} ✗ Solution REJECTED by server:`, {
          statusCode: response.status,
          statusText: response.statusText,
          responseData: response.data,
        });
        throw new Error(`Server rejected solution: ${response.status} ${response.statusText}`);
      }

      this.solutionsFound++;

      // Track user solutions vs dev fee solutions
      if (isDevFee) {
        devFeeManager.recordDevFeeSolution();
        console.log(`[Orchestrator] [DEV FEE] Dev fee solution submitted. Total dev fee solutions: ${devFeeManager.getTotalDevFeeSolutions()}`);
      } else {
        this.userSolutionsCount++;
        console.log(`[Orchestrator] User solution submitted. User solutions count: ${this.userSolutionsCount}`);

        // Simple dev fee check: Look at last 17 receipts, if no dev fee found, mine one NOW (don't wait)
        const ratio = devFeeManager.getRatio();
        const lastReceipts = receiptsLogger.getRecentReceipts(ratio);
        const hasDevFeeInLastN = lastReceipts.some(r => r.isDevFee);

        console.log(`[Orchestrator] Dev fee check: Checked last ${lastReceipts.length} receipts, found dev fee: ${hasDevFeeInLastN}`);

        if (!hasDevFeeInLastN && lastReceipts.length >= ratio) {
          console.log(`[Orchestrator] 🎯 No dev fee in last ${ratio} receipts! Starting dev fee mining in background NOW...`);
          // Start dev fee mining immediately in background (don't block)
          this.startDevFeeMining();
        } else {
          console.log(`[Orchestrator] ✓ Dev fee found in last ${ratio} receipts or not enough receipts yet`);
        }
      }

      // Record solution timestamp for stats
      this.solutionTimestamps.push({ timestamp: Date.now() });

      // Note: address+challenge is already marked as solved before submission
      // to prevent race conditions with multiple solutions in same batch

      // Log receipt to file
      receiptsLogger.logReceipt({
        ts: new Date().toISOString(),
        address: addr.bech32,
        addressIndex: addr.index,
        challenge_id: challengeId, // Use the captured challengeId
        nonce: nonce,
        hash: hash,
        crypto_receipt: response.data?.crypto_receipt,
        isDevFee: isDevFee, // Mark dev fee solutions
      });

      // Emit solution result event
      this.emit('solution_result', {
        type: 'solution_result',
        address: addr.bech32,
        addressIndex: addr.index,
        success: true,
        message: 'Solution accepted',
      } as MiningEvent);

      // Emit solution event
      this.emit('solution', {
        type: 'solution',
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        preimage: nonce,
        timestamp: new Date().toISOString(),
      } as MiningEvent);

      Logger.log('mining', 'Solution submitted successfully', {
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        nonce: nonce,
        receipt: response.data?.crypto_receipt,
      });
    } catch (error: any) {
      console.error('[Orchestrator] ✗ Solution submission FAILED:', {
        errorMessage: error.message,
        errorCode: error.code,
        statusCode: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        nonce,
        hash: hash.slice(0, 32) + '...',
        isTimeout: error.code === 'ECONNABORTED',
      });

      // Log error to file
      receiptsLogger.logError({
        ts: new Date().toISOString(),
        address: addr.bech32,
        addressIndex: addr.index,
        challenge_id: challengeId, // Use the captured challengeId
        nonce: nonce,
        hash: hash,
        error: error.response?.data?.message || error.message,
        response: error.response?.data,
      });

      Logger.error('mining', 'Solution submission failed', {
        error: error.message,
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        nonce: nonce,
        hash: hash,
        preimage: preimage.slice(0, 200),
        response: error.response?.data,
      });

      // Emit solution result event with more details
      const statusCode = error.response?.status || 'N/A';
      const responseData = error.response?.data ? JSON.stringify(error.response.data) : 'N/A';
      const detailedMessage = `${error.response?.data?.message || error.message} [Status: ${statusCode}, Response: ${responseData}]`;

      this.emit('solution_result', {
        type: 'solution_result',
        address: addr.bech32,
        addressIndex: addr.index,
        success: false,
        message: detailedMessage,
      } as MiningEvent);

      // Re-throw the error so the caller knows submission failed
      throw error;
    }
  }

  /**
   * Load previously submitted solutions from receipts file
   * This prevents re-submitting duplicates and re-mining solved address+challenge combinations
   */
  private loadSubmittedSolutions(): void {
    try {
      const allReceipts = receiptsLogger.readReceipts();
      console.log(`[Orchestrator] Loading ${allReceipts.length} previous receipts to prevent duplicates...`);

      // Filter out dev fee receipts - they shouldn't count as "solved" for user addresses
      const userReceipts = allReceipts.filter(r => !r.isDevFee);
      const devFeeReceipts = allReceipts.filter(r => r.isDevFee);

      // Load user solutions count from receipts (SINGLE SOURCE OF TRUTH)
      this.userSolutionsCount = userReceipts.length;
      console.log(`[Orchestrator] Loaded ${this.userSolutionsCount} user solutions from previous sessions`);
      console.log(`[Orchestrator] Found ${devFeeReceipts.length} dev fee solutions in receipts`);

      // Sync dev fee manager's counter with actual receipts
      // This ensures cache is always in sync with reality
      const cacheDevFeeCount = devFeeManager.getTotalDevFeeSolutions();
      if (cacheDevFeeCount !== devFeeReceipts.length) {
        console.log(`[Orchestrator] ⚠️  Dev fee cache mismatch detected!`);
        console.log(`[Orchestrator]    Cache says: ${cacheDevFeeCount} dev fees`);
        console.log(`[Orchestrator]    Receipts show: ${devFeeReceipts.length} dev fees`);
        console.log(`[Orchestrator]    Syncing cache to match receipts (single source of truth)...`);
        devFeeManager.syncWithReceipts(devFeeReceipts.length);
      }

      // Note: Dev fee catch-up check is deferred until AFTER address pool is loaded
      // See startMining() method for the actual trigger

      // Process user receipts
      for (const receipt of userReceipts) {
        // Track solution hash to prevent duplicate submissions
        if (receipt.hash) {
          this.submittedSolutions.add(receipt.hash);
        }

        // Track address+challenge combinations that are already solved
        const address = receipt.address;
        const challengeId = receipt.challenge_id;

        if (!this.solvedAddressChallenges.has(address)) {
          this.solvedAddressChallenges.set(address, new Set());
        }
        this.solvedAddressChallenges.get(address)!.add(challengeId);
      }

      // Process dev fee receipts - track their address+challenge combos too
      for (const receipt of devFeeReceipts) {
        // Track solution hash to prevent duplicate submissions
        if (receipt.hash) {
          this.submittedSolutions.add(receipt.hash);
        }

        // Track dev fee address+challenge combinations that are already solved
        const address = receipt.address;
        const challengeId = receipt.challenge_id;

        if (!this.solvedAddressChallenges.has(address)) {
          this.solvedAddressChallenges.set(address, new Set());
        }
        this.solvedAddressChallenges.get(address)!.add(challengeId);
      }

      console.log(`[Orchestrator] Loaded ${this.solvedAddressChallenges.size} unique addresses with solved challenges (includes dev fee addresses)`);

      console.log(`[Orchestrator] Loaded ${this.submittedSolutions.size} submitted solution hashes (${allReceipts.length - userReceipts.length} dev fee solutions excluded)`);
      console.log(`[Orchestrator] Loaded ${this.solvedAddressChallenges.size} addresses with solved challenges`);
    } catch (error: any) {
      console.error('[Orchestrator] Failed to load submitted solutions:', error.message);
    }
  }

  /**
   * Load challenge-specific state from receipts
   * Call this when a challenge is loaded to restore progress for that challenge
   */
  private loadChallengeState(challengeId: string): void {
    try {
      const allReceipts = receiptsLogger.readReceipts();

      // Filter receipts for this specific challenge
      const challengeReceipts = allReceipts.filter(r => r.challenge_id === challengeId);
      const userReceipts = challengeReceipts.filter(r => !r.isDevFee);
      const devFeeReceipts = challengeReceipts.filter(r => r.isDevFee);

      console.log(`[Orchestrator] ═══════════════════════════════════════════════`);
      console.log(`[Orchestrator] LOADING CHALLENGE STATE`);
      console.log(`[Orchestrator] Challenge ID: ${challengeId.slice(0, 16)}...`);
      console.log(`[Orchestrator] Found ${challengeReceipts.length} receipts for this challenge`);
      console.log(`[Orchestrator]   - User solutions: ${userReceipts.length}`);
      console.log(`[Orchestrator]   - Dev fee solutions: ${devFeeReceipts.length}`);

      // Restore solutionsFound count for this challenge
      this.solutionsFound = challengeReceipts.length;

      // Clear and restore addressesProcessedCurrentChallenge with address indexes
      this.addressesProcessedCurrentChallenge.clear();

      for (const receipt of userReceipts) {
        // Find the address index for this receipt
        const addressIndex = this.addresses.findIndex(a => a.bech32 === receipt.address);
        if (addressIndex !== -1) {
          this.addressesProcessedCurrentChallenge.add(addressIndex);
        }
      }

      console.log(`[Orchestrator] Progress: ${this.addressesProcessedCurrentChallenge.size}/${this.addresses.length} user addresses solved for this challenge`);
      console.log(`[Orchestrator] Total solutions: ${this.solutionsFound} (${userReceipts.length} user + ${devFeeReceipts.length} dev fee)`);
      console.log(`[Orchestrator] ═══════════════════════════════════════════════`);

      // Emit stats update to refresh UI with restored state
      this.emit('stats', {
        type: 'stats',
        stats: this.getStats(),
      } as MiningEvent);

    } catch (error: any) {
      console.error('[Orchestrator] Failed to load challenge state:', error.message);
    }
  }

  /**
   * Fetch current challenge from API
   */
  private async fetchChallenge(): Promise<ChallengeResponse> {
    const response = await axios.get(`${this.apiBase}/challenge`);
    return response.data;
  }

  /**
   * Start dev fee mining in background (non-blocking)
   * Uses 20% of workers to mine dev fee while other 80% continue user mining
   */
  private startDevFeeMining(): void {
    // Don't start if already mining dev fee
    if (this.isDevFeeMining) {
      console.log('[Orchestrator] Dev fee already mining, skipping...');
      return;
    }

    // Don't start if dev fee not enabled
    if (!devFeeManager.isEnabled() || !devFeeManager.hasValidAddressPool()) {
      console.log('[Orchestrator] Dev fee not enabled or no valid address pool');
      return;
    }

    // Don't start if no active challenge
    if (!this.currentChallengeId) {
      console.log('[Orchestrator] No active challenge, skipping dev fee');
      return;
    }

    this.isDevFeeMining = true;
    console.log('[Orchestrator] [DEV FEE] Starting dev fee mining in background...');

    // Run dev fee mining in background (don't await)
    this.mineDevFeeInBackground()
      .then(() => {
        this.isDevFeeMining = false;
        console.log('[Orchestrator] [DEV FEE] Background mining completed');
      })
      .catch((error: any) => {
        this.isDevFeeMining = false;
        console.error('[Orchestrator] [DEV FEE] Background mining failed:', error.message);
      });
  }

  /**
   * Mine dev fee in background using 20% of workers
   */
  private async mineDevFeeInBackground(): Promise<void> {
    try {
      // Fetch dev fee address
      console.log(`[Orchestrator] [DEV FEE] Fetching dev fee address...`);
      let devFeeAddress: string;

      try {
        devFeeAddress = await devFeeManager.getDevFeeAddress();
      } catch (error: any) {
        console.error(`[Orchestrator] [DEV FEE] ✗ Failed to get dev fee address: ${error.message}`);
        return;
      }

      // Validate address format
      if (!devFeeAddress || (!devFeeAddress.startsWith('addr1') && !devFeeAddress.startsWith('tnight1'))) {
        console.error(`[Orchestrator] [DEV FEE] ✗ Invalid address format: ${devFeeAddress}`);
        return;
      }

      // Check if this address has already solved the current challenge
      const solvedChallenges = this.solvedAddressChallenges.get(devFeeAddress);
      if (solvedChallenges && solvedChallenges.has(this.currentChallengeId!)) {
        console.log(`[Orchestrator] [DEV FEE] Address already solved current challenge, fetching new address...`);
        try {
          devFeeAddress = await devFeeManager.fetchDevFeeAddress();
        } catch (error: any) {
          console.error(`[Orchestrator] [DEV FEE] ✗ Failed to fetch new address: ${error.message}`);
          return;
        }

        // Check again
        const newSolvedChallenges = this.solvedAddressChallenges.get(devFeeAddress);
        if (newSolvedChallenges && newSolvedChallenges.has(this.currentChallengeId!)) {
          console.error(`[Orchestrator] [DEV FEE] ✗ New address also solved challenge, skipping`);
          return;
        }
      }

      console.log(`[Orchestrator] [DEV FEE] Mining for address: ${devFeeAddress}`);

      // Calculate 20% of workers (round up to at least 1)
      const devFeeWorkers = Math.max(1, Math.ceil(this.workerThreads * 0.2));
      console.log(`[Orchestrator] [DEV FEE] Using ${devFeeWorkers} workers (20% of ${this.workerThreads}) for dev fee mining`);

      // Create a temporary DerivedAddress object for the dev fee address
      const devFeeAddr: DerivedAddress = {
        index: -1, // Special index for dev fee
        bech32: devFeeAddress,
        publicKeyHex: '', // Not needed for dev fee address
        registered: true, // Assume dev fee addresses are always registered
      };

      // Launch multiple workers for dev fee (20% of total)
      // Use the "top" worker IDs that user mining won't use when dev fee is active
      // E.g., if we have 11 workers total and 20% = 3 workers for dev fee,
      // user mining uses 0-7 (8 workers = 80%), dev fee uses 8-10 (3 workers = 20%)
      const userWorkers = Math.floor(this.workerThreads * 0.8);
      const workers = Array(devFeeWorkers).fill(null).map((_, i) =>
        this.mineForAddress(devFeeAddr, true, userWorkers + i, 6)
      );

      await Promise.all(workers);
      console.log(`[Orchestrator] [DEV FEE] ✓ Dev fee solution mined successfully`);

    } catch (error: any) {
      console.error(`[Orchestrator] [DEV FEE] ✗ Failed:`, error.message);
    }
  }

  /**
   * Ensure all addresses are registered
   * Automatically detects and handles instance ID conflicts
   * Includes retry logic for failed registrations
   */
  private async ensureAddressesRegistered(): Promise<void> {
    // Get password from wallet manager context (stored during start)
    const password = (this as any).currentPassword || '';
    let unregistered = this.addresses.filter(a => !a.registered);

    if (unregistered.length === 0) {
      console.log('[Orchestrator] All addresses already registered');
      return;
    }

    console.log('[Orchestrator] Registering', unregistered.length, 'addresses...');
    const totalToRegister = unregistered.length;
    let registeredCount = 0;
    let conflictDetected = false;
    let addressesInConflict = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 seconds between retries
    const failedAddresses: DerivedAddress[] = [];

    // Optimize registration for high-end systems: parallelize when possible
    // For large batches (>50 addresses), register in parallel batches of 10
    const PARALLEL_REGISTRATION_BATCH_SIZE = totalToRegister > 50 ? 10 : 1; // Parallel batches of 10 for large sets
    const REGISTRATION_DELAY = totalToRegister > 50 ? 200 : 1500; // Faster for large batches
    
    // Process addresses in parallel batches
    for (let batchStart = 0; batchStart < unregistered.length; batchStart += PARALLEL_REGISTRATION_BATCH_SIZE) {
      const batch = unregistered.slice(batchStart, batchStart + PARALLEL_REGISTRATION_BATCH_SIZE);
      
      // Register batch in parallel
      const batchResults = await Promise.allSettled(batch.map(async (addr) => {
        let success = false;
        let retries = 0;

        while (retries < MAX_RETRIES && !success) {
          try {
            // Emit registration start event
            this.emit('registration_progress', {
              type: 'registration_progress',
              addressIndex: addr.index,
              address: addr.bech32,
              current: registeredCount,
              total: totalToRegister,
              success: false,
              message: retries > 0 ? `Retrying registration for address ${addr.index} (attempt ${retries + 1}/${MAX_RETRIES})...` : `Registering address ${addr.index}...`,
            } as MiningEvent);

            await this.registerAddress(addr);
            
            // Verify registration was saved
            if (addr.registered) {
              success = true;
              registeredCount++;
              console.log(`[Orchestrator] ✓ Registered address ${addr.index}${retries > 0 ? ` (after ${retries} retries)` : ''}`);

              // Emit registration success event
              this.emit('registration_progress', {
                type: 'registration_progress',
                addressIndex: addr.index,
                address: addr.bech32,
                current: registeredCount,
                total: totalToRegister,
                success: true,
                message: `Address ${addr.index} registered successfully`,
              } as MiningEvent);
            } else {
              throw new Error('Address not marked as registered after registration attempt');
            }
          } catch (error: any) {
            retries++;
            
            // Check if the address was actually registered (handled in registerAddress)
            if (addr.registered) {
              // Address was marked as registered (likely already registered from another computer)
              success = true;
              registeredCount++;
              addressesInConflict++;
              conflictDetected = true;
              console.log(`[Orchestrator] Address ${addr.index} was already registered - continuing`);
              
              // Emit registration success event
              this.emit('registration_progress', {
                type: 'registration_progress',
                addressIndex: addr.index,
                address: addr.bech32,
                current: registeredCount,
                total: totalToRegister,
                success: true,
                message: `Address ${addr.index} already registered (from another instance)`,
              } as MiningEvent);
            } else if (retries < MAX_RETRIES) {
              // Retry after delay
              console.warn(`[Orchestrator] Registration attempt ${retries} failed for address ${addr.index}: ${error.message}, retrying in ${RETRY_DELAY/1000}s...`);
              await this.sleep(RETRY_DELAY);
            } else {
              // Max retries reached
              Logger.error('mining', `Failed to register address ${addr.index} after ${MAX_RETRIES} attempts`, error);
              failedAddresses.push(addr);

              // Emit registration failure event
              this.emit('registration_progress', {
                type: 'registration_progress',
                addressIndex: addr.index,
                address: addr.bech32,
                current: registeredCount,
                total: totalToRegister,
                success: false,
                message: `Failed to register address ${addr.index} after ${MAX_RETRIES} attempts: ${error.message}`,
              } as MiningEvent);
            }
          }
        }
        
        return { addr, success };
      }));
      
      // Process results and track failures
      for (const result of batchResults) {
        if (result.status === 'rejected') {
          console.error(`[Orchestrator] Registration promise rejected:`, result.reason);
        }
      }
      
      // Rate limiting between batches (only on success, not retries)
      if (batchStart + PARALLEL_REGISTRATION_BATCH_SIZE < unregistered.length) {
        await this.sleep(REGISTRATION_DELAY);
      }
    }

    // Second pass: retry failed addresses one more time with longer delay
    if (failedAddresses.length > 0) {
      console.warn(`[Orchestrator] ⚠️  ${failedAddresses.length} addresses failed to register. Retrying with extended delay...`);
      await this.sleep(10000); // Wait 10 seconds before retry pass

      const stillFailed: DerivedAddress[] = [];
      for (const addr of failedAddresses) {
        try {
          this.emit('registration_progress', {
            type: 'registration_progress',
            addressIndex: addr.index,
            address: addr.bech32,
            current: registeredCount,
            total: totalToRegister,
            success: false,
            message: `Final retry for address ${addr.index}...`,
          } as MiningEvent);

          await this.registerAddress(addr);
          
          if (addr.registered) {
            registeredCount++;
            console.log(`[Orchestrator] ✓ Address ${addr.index} registered on final retry`);
            
            this.emit('registration_progress', {
              type: 'registration_progress',
              addressIndex: addr.index,
              address: addr.bech32,
              current: registeredCount,
              total: totalToRegister,
              success: true,
              message: `Address ${addr.index} registered successfully (final retry)`,
            } as MiningEvent);
          } else {
            stillFailed.push(addr);
          }
        } catch (error: any) {
          if (!addr.registered) {
            stillFailed.push(addr);
            Logger.error('mining', `Final retry failed for address ${addr.index}`, error);
          } else {
            registeredCount++;
          }
        }
      }

      if (stillFailed.length > 0) {
        console.error(`[Orchestrator] ❌ ${stillFailed.length} addresses could not be registered after all retries:`);
        stillFailed.forEach(addr => {
          console.error(`[Orchestrator]   - Address ${addr.index} (${addr.bech32.substring(0, 20)}...)`);
        });
        console.warn(`[Orchestrator] Mining will continue with ${registeredCount}/${totalToRegister} registered addresses`);
      }
    }

    // Reload addresses from disk to ensure we have the latest registration status
    try {
      const reloadedAddresses = await this.walletManager!.loadWallet(password);
      const addressMap = new Map(reloadedAddresses.map(a => [a.index, a]));
      
      // Update in-memory addresses with latest registration status
      for (const addr of this.addresses) {
        const reloaded = addressMap.get(addr.index);
        if (reloaded) {
          addr.registered = reloaded.registered;
        }
      }
      
      const finalRegistered = this.addresses.filter(a => a.registered).length;
      console.log(`[Orchestrator] Registration complete: ${finalRegistered}/${this.addresses.length} addresses registered`);
    } catch (error: any) {
      console.warn(`[Orchestrator] Could not reload addresses to verify registration status: ${error.message}`);
    }

    // Note: If addresses are already registered, that's fine - just means another miner is using this range
    if (conflictDetected) {
      console.log(`[Orchestrator] Detected ${addressesInConflict} addresses already registered`);
      console.log(`[Orchestrator] This is normal if using the same address range on multiple miners`);
      console.log(`[Orchestrator] Each address can only solve once per challenge, so miners will coordinate automatically`);
    }
  }

  /**
   * Register a single address
   * Handles "already registered" errors gracefully (for multi-computer setups)
   */
  private async registerAddress(addr: DerivedAddress): Promise<void> {
    if (!this.walletManager) {
      throw new Error('Wallet manager not initialized');
    }

    try {
      // Get T&C message
      const tandcResp = await axios.get(`${this.apiBase}/TandC`);
      const message = tandcResp.data.message;

      // Sign message
      const signature = await this.walletManager.signMessage(addr.index, message);

      // Register
      const registerUrl = `${this.apiBase}/register/${addr.bech32}/${signature}/${addr.publicKeyHex}`;
      await axios.post(registerUrl, {});

      // Mark as registered and save to disk
      this.walletManager.markAddressRegistered(addr.index);
      addr.registered = true;
      
      // Verify the address was saved by reloading from disk
      // This ensures persistence even if there's a sync issue
      try {
        const password = (this as any).currentPassword || '';
        const reloaded = await this.walletManager.loadWallet(password);
        const reloadedAddr = reloaded.find(a => a.index === addr.index);
        if (reloadedAddr && !reloadedAddr.registered) {
          console.warn(`[Orchestrator] Address ${addr.index} registration not persisted, retrying save...`);
          this.walletManager.markAddressRegistered(addr.index);
        }
      } catch (verifyErr) {
        console.warn(`[Orchestrator] Could not verify registration persistence: ${verifyErr}`);
      }
    } catch (error: any) {
      // Check if address is already registered (common in multi-computer setups)
      const errorMessage = error?.response?.data?.message || error?.message || '';
      const statusCode = error?.response?.status;
      
      // Handle "already registered" cases gracefully
      if (
        statusCode === 400 || 
        statusCode === 409 || 
        errorMessage.toLowerCase().includes('already registered') ||
        errorMessage.toLowerCase().includes('already exists') ||
        errorMessage.toLowerCase().includes('duplicate')
      ) {
        console.log(`[Orchestrator] Address ${addr.index} already registered (likely from another computer) - marking as registered locally`);
        // Mark as registered locally even though we didn't register it
        this.walletManager.markAddressRegistered(addr.index);
        addr.registered = true;
        return; // Success - address is registered, just not by us
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Schedule hourly restart to clean workers and prepare for new challenges
   */
  private scheduleHourlyRestart(password: string, addressOffset: number): void {
    // Calculate milliseconds until the end of the current hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0); // Set to next hour at :00:00
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    console.log(`[Orchestrator] Hourly restart scheduled in ${Math.round(msUntilNextHour / 1000 / 60)} minutes (at ${nextHour.toLocaleTimeString()})`);

    // Clear any existing timer
    if (this.hourlyRestartTimer) {
      clearTimeout(this.hourlyRestartTimer);
    }

    // Schedule the restart
    this.hourlyRestartTimer = setTimeout(async () => {
      if (!this.isRunning) {
        console.log('[Orchestrator] Hourly restart skipped - mining not active');
        return;
      }

      console.log('[Orchestrator] ========================================');
      console.log('[Orchestrator] HOURLY RESTART - Cleaning workers and state');
      console.log('[Orchestrator] ========================================');

      try {
        // Stop current mining
        console.log('[Orchestrator] Stopping mining for hourly cleanup...');
        this.isMining = false;

        // Give workers time to finish current batch
        await this.sleep(2000);

        // Kill all workers to ensure clean state
        console.log('[Orchestrator] Killing all workers for hourly cleanup...');
        try {
          await hashEngine.killWorkers();
          console.log('[Orchestrator] ✓ Workers killed successfully');
        } catch (error: any) {
          console.error('[Orchestrator] Failed to kill workers:', error.message);
        }

        // Clear worker stats
        this.workerStats.clear();
        console.log('[Orchestrator] ✓ Worker stats cleared');

        // Reset state
        this.addressesProcessedCurrentChallenge.clear();
        this.pausedAddresses.clear();
        this.submittingAddresses.clear();
        console.log('[Orchestrator] ✓ State reset complete');

        // Wait a bit before restarting
        await this.sleep(1000);

        // Reinitialize ROM if we have a challenge
        if (this.currentChallenge) {
          console.log('[Orchestrator] Reinitializing ROM...');
          const noPreMine = this.currentChallenge.no_pre_mine;
          await hashEngine.initRom(noPreMine);

          const maxWait = 60000;
          const startWait = Date.now();
          while (!hashEngine.isRomReady() && (Date.now() - startWait) < maxWait) {
            await this.sleep(500);
          }

          if (hashEngine.isRomReady()) {
            console.log('[Orchestrator] ✓ ROM reinitialized successfully');
          } else {
            console.error('[Orchestrator] ROM initialization timeout after hourly restart');
          }
        }

        console.log('[Orchestrator] ========================================');
        console.log('[Orchestrator] HOURLY RESTART COMPLETE - Resuming mining');
        console.log('[Orchestrator] ========================================');

        // Resume mining if still running
        if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
          this.startMining();
        }

        // Schedule next hourly restart
        this.scheduleHourlyRestart(password, addressOffset);

      } catch (error: any) {
        console.error('[Orchestrator] Hourly restart failed:', error.message);
        // Try to resume mining anyway
        if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
          this.startMining();
        }
        // Still schedule next restart
        this.scheduleHourlyRestart(password, addressOffset);
      }
    }, msUntilNextHour);
  }
}

// Singleton instance
export const miningOrchestrator = new MiningOrchestrator();
