/**
 * Mining Orchestrator
 * Manages mining process, challenge polling, and worker coordination
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { ChallengeResponse, MiningStats, MiningEvent, Challenge } from './types';
import { hashEngine } from '@/lib/hash/engine';
import { WalletManager, DerivedAddress } from '@/lib/wallet/manager';
import Logger from '@/lib/utils/logger';
import { matchesDifficulty, getDifficultyZeroBits } from './difficulty';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { generateNonce } from './nonce';
import { buildPreimage } from './preimage';
import { devFeeManager } from '@/lib/devfee/manager';
import * as os from 'os';

interface SolutionTimestamp {
  timestamp: number;
}

class MiningOrchestrator extends EventEmitter {
  private isRunning = false;
  private currentChallengeId: string | null = null;
  private apiBase: string = 'https://scavenger.prod.gd.midnighttge.io';
  private pollInterval = 30000; // 30 seconds
  private pollTimer: NodeJS.Timeout | null = null;
  private walletManager: WalletManager | null = null;
  private addresses: DerivedAddress[] = [];
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
  private workerThreads = 10; // Number of parallel mining threads
  private submittedSolutions = new Set<string>(); // Track submitted solution hashes to avoid duplicates
  private solvedAddressChallenges = new Map<string, Set<string>>(); // Map: address -> Set of solved challenge_ids
  private userSolutionsCount = 0; // Track non-dev-fee solutions for dev fee trigger

  /**
   * Start mining with loaded wallet
   */
  async start(password: string): Promise<void> {
    if (this.isRunning) {
      console.log('[Orchestrator] Mining already running, returning current state');
      return; // Just return without error if already running
    }

    // Load wallet
    this.walletManager = new WalletManager();
    this.addresses = await this.walletManager.loadWallet(password);

    console.log('[Orchestrator] Loaded wallet with', this.addresses.length, 'addresses');

    // Load previously submitted solutions from receipts file
    this.loadSubmittedSolutions();

    // Register addresses that aren't registered yet
    await this.ensureAddressesRegistered();

    this.isRunning = true;
    this.startTime = Date.now();
    this.solutionsFound = 0;

    // Start polling
    this.pollLoop();

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

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.emit('status', {
      type: 'status',
      active: false,
      challengeId: null,
    } as MiningEvent);
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

    for (const solution of this.solutionTimestamps) {
      const ts = solution.timestamp;

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
        console.log('[Orchestrator] New challenge detected:', challengeId);

        // IMPORTANT: Stop any ongoing mining first to prevent ROM errors
        if (this.isMining) {
          console.log('[Orchestrator] Stopping current mining for ROM reinitialization...');
          this.isMining = false;
          // Wait a bit for workers to finish their current batch
          await this.sleep(1000);
        }

        // Reset challenge progress tracking
        this.addressesProcessedCurrentChallenge.clear();
        this.submittedSolutions.clear(); // Clear submitted solutions for new challenge

        // Initialize ROM
        const noPreMine = challenge.challenge.no_pre_mine;
        console.log('[Orchestrator] Initializing ROM...');
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
      }
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
    const logMsg = `Starting mining with ${this.workerThreads} parallel workers on ${this.addresses.filter(a => a.registered).length} addresses`;
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

    const registeredAddresses = this.addresses.filter(a => a.registered);
    const currentChallengeId = this.currentChallengeId;

    // Filter out addresses that have already solved this challenge
    const addressesToMine = registeredAddresses.filter(addr => {
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      return !solvedChallenges || !solvedChallenges.has(currentChallengeId!);
    });

    if (addressesToMine.length === 0) {
      console.log(`[Orchestrator] All addresses have already solved challenge ${currentChallengeId}`);
      this.isMining = false;
      return;
    }

    console.log(`[Orchestrator] Mining for ${addressesToMine.length} addresses (${registeredAddresses.length - addressesToMine.length} already solved)`);

    // Mine each address+challenge combination in parallel batches
    // Each worker gets a unique address
    for (let i = 0; i < addressesToMine.length; i += this.workerThreads) {
      if (!this.isRunning || !this.isMining || this.currentChallengeId !== currentChallengeId) break;

      // Get batch of addresses to mine in parallel (each worker gets a different address)
      const batch = addressesToMine.slice(i, i + this.workerThreads);

      const batchMsg = `Processing batch of ${batch.length} addresses in parallel (addresses ${i} to ${i + batch.length - 1})`;
      console.log(`[Orchestrator] ${batchMsg}`);

      // Mine all addresses in this batch in parallel - each worker gets a different address
      await Promise.all(batch.map(addr => this.mineForAddress(addr)));
    }

    // After mining all user addresses, check if we need to mine a dev fee solution
    await this.checkAndMineDevFee();

    this.isMining = false;
  }

  /**
   * Mine for a specific address
   * Note: This should only be called for address+challenge combinations that haven't been solved yet
   * @param addr - The address to mine for
   * @param isDevFee - Whether this is a dev fee mining operation (default: false)
   */
  private async mineForAddress(addr: DerivedAddress, isDevFee: boolean = false): Promise<void> {
    if (!this.currentChallenge || !this.currentChallengeId) return;

    const challengeId = this.currentChallengeId;
    const difficulty = this.currentChallenge.difficulty;

    // ROM should already be ready from pollAndMine - quick check only
    if (!hashEngine.isRomReady()) {
      console.error(`[Orchestrator] ROM not ready for address ${addr.index}`);
      return;
    }

    // Mark this address as having processed the current challenge
    this.addressesProcessedCurrentChallenge.add(addr.index);

    // Log difficulty for debugging
    const requiredZeroBits = getDifficultyZeroBits(difficulty);
    const startMsg = `Worker ${addr.index}: Starting to mine (requires ${requiredZeroBits} leading zero bits)`;
    console.log(`[Orchestrator] ${startMsg}`);

    // Emit mining start event
    this.emit('mining_start', {
      type: 'mining_start',
      address: addr.bech32,
      addressIndex: addr.index,
      challengeId,
    } as MiningEvent);

    const BATCH_SIZE = 1000; // Smaller batch size for faster response and lower memory
    const PROGRESS_INTERVAL = 1; // Emit progress every batch for updates
    let hashCount = 0;
    let batchCounter = 0;
    let lastProgressTime = Date.now();

    // Mine continuously with random nonces using BATCH processing
    while (this.isRunning && this.isMining && this.currentChallengeId === challengeId) {
      batchCounter++;

      // Generate batch of nonces and preimages
      const batchData: Array<{ nonce: string; preimage: string }> = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        if (!this.isRunning || !this.isMining || this.currentChallengeId !== challengeId) {
          break;
        }

        const nonceHex = generateNonce();
        const preimage = buildPreimage(
          nonceHex,
          addr.bech32,
          this.currentChallenge,
          hashCount === 0 && i === 0 // Debug first hash
        );

        batchData.push({ nonce: nonceHex, preimage });
      }

      if (batchData.length === 0) break;

      try {
        // Send entire batch to Rust service for PARALLEL processing
        const preimages = batchData.map(d => d.preimage);
        const hashes = await hashEngine.hashBatchAsync(preimages);

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

            // Solution found!
            console.log('[Orchestrator] Solution found!', {
              address: addr.bech32,
              nonce,
              hash: hash.slice(0, 16) + '...',
            });
            console.log('[Orchestrator] Full preimage:', preimage);
            console.log('[Orchestrator] Full hash:', hash);

            // Mark as submitted before submitting to avoid race conditions
            this.submittedSolutions.add(hash);

            // Mark this address+challenge as solved BEFORE submitting
            // This prevents other workers (or this worker finding multiple solutions in same batch)
            // from trying to submit for the same address+challenge
            if (!this.solvedAddressChallenges.has(addr.bech32)) {
              this.solvedAddressChallenges.set(addr.bech32, new Set());
            }
            this.solvedAddressChallenges.get(addr.bech32)!.add(challengeId);

            // Emit solution submit event
            this.emit('solution_submit', {
              type: 'solution_submit',
              address: addr.bech32,
              addressIndex: addr.index,
              challengeId,
              nonce,
              preimage: preimage.slice(0, 50) + '...',
            } as MiningEvent);

            // Submit solution (pass only the nonce)
            await this.submitSolution(addr, nonce, hash, preimage, isDevFee);

            // IMPORTANT: Stop mining for this address after finding a solution
            // Each address should only submit ONE solution per challenge
            const logPrefix = isDevFee ? '[DEV FEE]' : '';
            console.log(`[Orchestrator] ${logPrefix} Worker ${addr.index}: Solution submitted, stopping mining for this address`);
            return; // Exit the mineForAddress function
          }
        }
      } catch (error: any) {
        Logger.error('mining', 'Batch hash computation error', error);
      }

      // Emit progress event every PROGRESS_INTERVAL batches
      if (batchCounter % PROGRESS_INTERVAL === 0) {
        const now = Date.now();
        const elapsedSeconds = (now - lastProgressTime) / 1000;
        const hashRate = elapsedSeconds > 0 ? Math.round((BATCH_SIZE * PROGRESS_INTERVAL) / elapsedSeconds) : 0;
        lastProgressTime = now;

        const progressMsg = `Worker ${addr.index}: ${hashCount.toLocaleString()} hashes @ ${hashRate.toLocaleString()} H/s (Challenge: ${challengeId.slice(0, 8)}...)`;
        console.log(`[Orchestrator] ${progressMsg}`);

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
  private async submitSolution(addr: DerivedAddress, nonce: string, hash: string, preimage: string, isDevFee: boolean = false): Promise<void> {
    if (!this.currentChallengeId || !this.walletManager) return;

    try {
      // Correct API endpoint: /solution/{address}/{challenge_id}/{nonce}
      const submitUrl = `${this.apiBase}/solution/${addr.bech32}/${this.currentChallengeId}/${nonce}`;
      const logPrefix = isDevFee ? '[DEV FEE]' : '';
      console.log(`[Orchestrator] ${logPrefix} Submitting solution:`, {
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
        console.log(`[Orchestrator] ${logPrefix} ✓ Solution ACCEPTED by server!`, {
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
      }

      // Record solution timestamp for stats
      this.solutionTimestamps.push({ timestamp: Date.now() });

      // Note: address+challenge is already marked as solved before submission
      // to prevent race conditions with multiple solutions in same batch

      // Log receipt to file
      receiptsLogger.logReceipt({
        ts: new Date().toISOString(),
        address: addr.bech32,
        challenge_id: this.currentChallengeId,
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
        challenge_id: this.currentChallengeId,
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

      console.log(`[Orchestrator] Loaded ${this.submittedSolutions.size} submitted solution hashes (${allReceipts.length - userReceipts.length} dev fee solutions excluded)`);
      console.log(`[Orchestrator] Loaded ${this.solvedAddressChallenges.size} addresses with solved challenges`);
    } catch (error: any) {
      console.error('[Orchestrator] Failed to load submitted solutions:', error.message);
    }
  }

  /**
   * Check if dev fee solution should be mined and mine it
   */
  private async checkAndMineDevFee(): Promise<void> {
    if (!devFeeManager.isEnabled()) {
      return;
    }

    const ratio = devFeeManager.getRatio();

    // Check if we've reached the threshold for dev fee
    if (this.userSolutionsCount > 0 && this.userSolutionsCount % ratio === 0) {
      console.log(`[Orchestrator] Dev fee threshold reached (${this.userSolutionsCount} user solutions). Mining dev fee solution...`);

      try {
        // Fetch dev fee address
        const devFeeAddress = await devFeeManager.getDevFeeAddress();

        console.log(`[Orchestrator] Mining solution for dev fee address: ${devFeeAddress}`);

        // Create a temporary DerivedAddress object for the dev fee address
        const devFeeAddr: DerivedAddress = {
          index: -1, // Special index for dev fee
          bech32: devFeeAddress,
          publicKeyHex: '', // Not needed for dev fee address
          registered: true, // Assume dev fee addresses are always registered
        };

        // Mine for dev fee address
        await this.mineForAddress(devFeeAddr, true);

        console.log('[Orchestrator] Dev fee solution mining completed');

      } catch (error: any) {
        console.error('[Orchestrator] Failed to mine dev fee solution:', error.message);
        // Continue normal operation even if dev fee fails
      }
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
   * Ensure all addresses are registered
   */
  private async ensureAddressesRegistered(): Promise<void> {
    const unregistered = this.addresses.filter(a => !a.registered);

    if (unregistered.length === 0) {
      console.log('[Orchestrator] All addresses already registered');
      return;
    }

    console.log('[Orchestrator] Registering', unregistered.length, 'addresses...');
    const totalToRegister = unregistered.length;
    let registeredCount = 0;

    for (const addr of unregistered) {
      try {
        // Emit registration start event
        this.emit('registration_progress', {
          type: 'registration_progress',
          addressIndex: addr.index,
          address: addr.bech32,
          current: registeredCount,
          total: totalToRegister,
          success: false,
          message: `Registering address ${addr.index}...`,
        } as MiningEvent);

        await this.registerAddress(addr);
        registeredCount++;
        console.log('[Orchestrator] Registered address', addr.index);

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

        // Rate limiting
        await this.sleep(1500);
      } catch (error: any) {
        Logger.error('mining', `Failed to register address ${addr.index}`, error);

        // Emit registration failure event
        this.emit('registration_progress', {
          type: 'registration_progress',
          addressIndex: addr.index,
          address: addr.bech32,
          current: registeredCount,
          total: totalToRegister,
          success: false,
          message: `Failed to register address ${addr.index}: ${error.message}`,
        } as MiningEvent);
      }
    }
  }

  /**
   * Register a single address
   */
  private async registerAddress(addr: DerivedAddress): Promise<void> {
    if (!this.walletManager) {
      throw new Error('Wallet manager not initialized');
    }

    // Get T&C message
    const tandcResp = await axios.get(`${this.apiBase}/TandC`);
    const message = tandcResp.data.message;

    // Sign message
    const signature = await this.walletManager.signMessage(addr.index, message);

    // Register
    const registerUrl = `${this.apiBase}/register/${addr.bech32}/${signature}/${addr.publicKeyHex}`;
    await axios.post(registerUrl, {});

    // Mark as registered
    this.walletManager.markAddressRegistered(addr.index);
    addr.registered = true;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const miningOrchestrator = new MiningOrchestrator();
