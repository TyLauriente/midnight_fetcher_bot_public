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
import { execSync } from 'child_process';

interface SolutionTimestamp {
  timestamp: number;
}

class MiningOrchestrator extends EventEmitter {
  private isRunning = false;
  private currentChallengeId: string | null = null;
  private apiBase: string = 'https://scavenger.prod.gd.midnighttge.io';
  
  /**
   * Detect CPU thread count (logical cores) for limiting max workers
   * Uses same logic as system specs API
   */
  private detectCpuThreadCount(): number {
    const platform = os.platform();
    const cpus = os.cpus();
    const logicalCores = cpus.length;
    
    // Try to get physical cores on Linux for verification
    if (platform === 'linux') {
      try {
        // Method 1: Use lscpu if available (most reliable)
        try {
          const lscpuOutput = execSync('lscpu 2>/dev/null', { encoding: 'utf8' });
          const socketsMatch = lscpuOutput.match(/^Socket\(s\):\s*(\d+)/m);
          const coresPerSocketMatch = lscpuOutput.match(/^Core\(s\) per socket:\s*(\d+)/m);
          const threadsPerCoreMatch = lscpuOutput.match(/^Thread\(s\) per core:\s*(\d+)/m);
          
          if (socketsMatch && coresPerSocketMatch) {
            const sockets = parseInt(socketsMatch[1]);
            const coresPerSocket = parseInt(coresPerSocketMatch[1]);
            const physicalCores = sockets * coresPerSocket;
            
            // Verify: logical should equal physical * threads_per_core
            if (threadsPerCoreMatch) {
              const threadsPerCore = parseInt(threadsPerCoreMatch[1]);
              const expectedLogical = physicalCores * threadsPerCore;
              if (Math.abs(expectedLogical - logicalCores) <= 2) { // Allow small variance
                // Return logical cores (for mining, we use all threads)
                return logicalCores;
              }
            } else {
              // Return logical cores if we can't verify
              return logicalCores;
            }
          }
        } catch (lscpuErr) {
          // lscpu not available, continue with other methods
        }
        
        // Method 2: Check /proc/cpuinfo for physical cores
        try {
          const uniquePhysicalIds = execSync('grep "^physical id" /proc/cpuinfo | sort -u | wc -l', { encoding: 'utf8' }).trim();
          const numSockets = parseInt(uniquePhysicalIds) || 0;
          
          if (numSockets > 0) {
            // Get cores per socket
            const coresPerSocket = execSync('grep "^cpu cores" /proc/cpuinfo | head -1 | cut -d: -f2 | tr -d " "', { encoding: 'utf8' }).trim();
            const coresPerPackage = parseInt(coresPerSocket) || 0;
            
            if (coresPerPackage > 0) {
              const physicalCores = numSockets * coresPerPackage;
              // Sanity check: physical cores should be <= logical cores
              if (physicalCores > 0 && physicalCores <= logicalCores) {
                // Return logical cores (for mining, we use all threads)
                return logicalCores;
              }
            }
          }
        } catch (cpuinfoErr) {
          // Continue to next method
        }
      } catch (err) {
        // If all methods fail, fall back to logical cores
        console.warn('[Orchestrator] Failed to detect CPU cores on Linux, using logical cores:', err);
      }
    }
    
    // Default: return logical cores (for mining, we use all threads including hyperthreading)
    return logicalCores;
  }
  
  constructor() {
    super();
    // OPTIMIZATION: Pre-build hex lookup table for fast nonce conversion (0-255 -> '00'-'ff')
    // This avoids repeated toString(16) and padStart calls in hot paths
    this.hexLookup = new Array(256);
    for (let i = 0; i < 256; i++) {
      this.hexLookup[i] = i.toString(16).padStart(2, '0');
    }
    
    // OPTIMIZATION: Pre-build hex byte -> number lookup table (avoids parseInt in hot path)
    // This is faster than parseInt(byteHex, 16) for single-byte hex strings
    this.hexByteLookup = new Map<string, number>();
    for (let i = 0; i < 256; i++) {
      const hex = i.toString(16).padStart(2, '0');
      this.hexByteLookup.set(hex, i);
      this.hexByteLookup.set(hex.toUpperCase(), i);
    }
    
    // CRITICAL: Detect actual CPU thread count to limit max workers
    const maxCpuThreads = this.detectCpuThreadCount();
    console.log(`[Orchestrator] Detected CPU thread count: ${maxCpuThreads} (this will be the maximum allowed worker count)`);
    
    // CRITICAL: Load persisted configuration on startup
    // This ensures worker threads, batch size, and address offset are restored from disk
    const persistedConfig = ConfigManager.loadConfig();
    
    // CRITICAL: Validate and correct worker count if it exceeds actual CPU thread count
    // If worker count in storage is greater than max CPU threads, set it to max and save
    if (persistedConfig.workerThreads > maxCpuThreads) {
      console.warn(`[Orchestrator] ⚠️  Worker count in config (${persistedConfig.workerThreads}) exceeds CPU thread count (${maxCpuThreads}). Setting to ${maxCpuThreads} and saving to config.`);
      this.workerThreads = maxCpuThreads;
      ConfigManager.setWorkerThreads(maxCpuThreads);
    } else {
      this.workerThreads = persistedConfig.workerThreads;
    }
    
    // CRITICAL: Always load batch size from persisted config (default is 850)
    // If it's the default (850), still set it as customBatchSize so it's used
    this.customBatchSize = persistedConfig.batchSize;
    // CRITICAL: Load addressOffset from config, ensuring it's a valid number (0 is valid)
    this.addressOffset = typeof persistedConfig.addressOffset === 'number' && persistedConfig.addressOffset >= 0 
      ? persistedConfig.addressOffset 
      : 0;
    console.log(`[Orchestrator] Loaded persisted config: offset=${this.addressOffset}, workers=${this.workerThreads}, batch=${this.customBatchSize}`);
  }
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
  private cachedRegisteredAddresses: DerivedAddress[] | null = null; // Cache registered addresses to avoid filtering every iteration
  private lastRegisteredAddressesUpdate = 0; // Timestamp of last cache update
  private hasLoggedFullWorkerRestore = false; // Track if we've logged the transition to full worker count after registration
  private solutionsFound = 0;
  private startTime: number | null = null;
  private isMining = false;
  private currentChallenge: Challenge | null = null;
  private totalHashesComputed = 0;
  private lastHashRateUpdate = Date.now();
  private hashRateHistory: Array<{ timestamp: number; hashRate: number }> = []; // Track hash rate over time for automatic recovery
  private hashRateMonitorInterval: NodeJS.Timeout | null = null; // Interval for monitoring hash rate
  private lastHashRateRestart: number = 0; // Timestamp of last hash rate triggered restart (for rate limiting)
  private badHashRateStartTime: number | null = null; // Timestamp when hash rate first dropped below threshold (for 50% drop check)
  private emergencyHashRateStartTime: number | null = null; // Timestamp when hash rate first dropped below emergency threshold (300 H/s or near-zero)
  private baselineHashRate: number | null = null; // Baseline hash rate from first 5 minutes after registration completes
  private baselineWorkerThreads: number | null = null; // Worker count when baseline was established
  private baselineBatchSize: number | null = null; // Batch size when baseline was established
  private baselineStartTime: number | null = null; // When baseline collection started (after registration completes)
  private baselineRegistrationComplete: boolean = false; // Track if registration was complete when baseline started
  private stabilityCheckInterval: NodeJS.Timeout | null = null; // Interval for stability checks and repairs
  private technicalMetricsInterval: NodeJS.Timeout | null = null; // Interval for emitting technical metrics
  private cpuUsage = 0;
  private lastCpuCheck: { idle: number; total: number } | null = null;
  private addressesProcessedCurrentChallenge = new Set<number>(); // Track which address indexes have processed current challenge
  private solutionTimestamps: SolutionTimestamp[] = []; // Track all solution timestamps for hourly/daily stats
  private workerThreads = 11; // Number of parallel mining threads
  private submittedSolutions = new Set<string>(); // Track submitted solution hashes to avoid duplicates
  private submittedSolutionsMaxSize = 10000; // Maximum size before cleanup (prevent unbounded growth)
  private solvedAddressChallenges = new Map<string, Set<string>>(); // Map: address -> Set of solved challenge_ids
  private logLevel: 'debug' | 'info' | 'warn' | 'error' = process.env.LOG_LEVEL as any || 'info'; // Logging level for performance
  private hasEventListeners = false; // Cache whether event listeners exist to avoid emit overhead
  private hexLookup: string[]; // Lookup table for fast hex conversion (0-255 -> '00'-'ff')
  private cachedSubmissionKeys = new Map<string, string>(); // Cache submission keys to avoid repeated string concatenation
  private userSolutionsCount = 0; // Track non-dev-fee solutions for dev fee trigger
  private submittingAddresses = new Set<string>(); // Track addresses currently submitting solutions (address+challenge key)
  private pausedAddresses = new Set<string>(); // Track addresses that are paused while submission is in progress
  private workerStats = new Map<number, WorkerStats>(); // Track stats for each worker (workerId -> WorkerStats)
  private workerHashesSinceLastUpdate = new Map<number, number>(); // Track hashes since last hash rate update per worker
  private addressToWorkers = new Map<string, Set<number>>(); // Reverse map: address -> Set of workerIds (for fast worker stopping)
  private hexByteLookup = new Map<string, number>(); // Lookup table for hex byte -> number (0-255) to avoid parseInt in hot path
  private staticPreimageCache = new Map<string, string>(); // Cache static preimage suffix per address+challenge (key: address:challengeId)
  private hourlyRestartTimer: NodeJS.Timeout | null = null; // Timer for hourly restart
  private stoppedWorkers = new Set<number>(); // Track workers that should stop immediately
  private currentMiningAddress: string | null = null; // Track which address we're currently mining
  private addressSubmissionFailures = new Map<string, number>(); // Track submission failures per address (address+challenge key)
  private lastMineAttempt = new Map<string, number>(); // Track when we last tried each address (CRITICAL: Must be class property to allow clearing on challenge changes)
  private customBatchSize: number | null = null; // Custom batch size override
  private workerAddressAssignment = new Map<number, string>(); // Track which address each worker is assigned to (workerId -> address bech32)
  private automaticRecoveryCheckInterval: NodeJS.Timeout | null = null; // Interval for automatic recovery checks
  private lastAutomaticRecovery = 0; // Timestamp of last automatic recovery (for rate limiting)
  private automaticRecoveryCooldown = 60000; // Minimum time between automatic recoveries (60 seconds)
  private consecutiveRecoveryAttempts = 0; // Track consecutive recovery attempts to prevent infinite loops
  private maxConsecutiveRecoveries = 3; // Maximum consecutive recoveries before giving up (prevents infinite loops)
  private lastRecoveryResetTime = 0; // Timestamp when consecutive recoveries were reset (after successful mining)
  private recoveryResetWindow = 300000; // Reset consecutive count after 5 minutes of successful mining
  private hashServiceTimeoutCount = 0; // Track consecutive hash service timeouts for adaptive backoff
  private lastHashServiceTimeout = 0; // Timestamp of last hash service timeout
  private adaptiveBatchSize: number | null = null; // Dynamically reduced batch size when timeouts occur
  
  // CRITICAL: Adaptive optimization tracking
  private batchPerformanceHistory: Array<{ batchSize: number; processingTime: number; timestamp: number; hashRate: number }> = []; // Track batch performance
  private optimalBatchSize: number | null = null; // Dynamically determined optimal batch size
  private batchOptimizationInterval: NodeJS.Timeout | null = null; // Interval for batch size optimization
  private workerPerformanceHistory: Array<{ workerCount: number; hashRate: number; cpuUsage: number; timestamp: number }> = []; // Track worker performance
  private optimalWorkerCount: number | null = null; // Dynamically determined optimal worker count
  private workerOptimizationInterval: NodeJS.Timeout | null = null; // Interval for worker count optimization
  private lastBatchOptimization = 0; // Timestamp of last batch optimization
  private lastWorkerOptimization = 0; // Timestamp of last worker optimization
  private batchSizeLock = false; // Lock to prevent concurrent batch size changes
  private workerCountLock = false; // Lock to prevent concurrent worker count changes
  private workerAssignmentLock = new Map<number, boolean>(); // Per-worker locks for assignment
  
  // NEW: Real-time adaptive batch sizing with feedback tracking
  private recentBatchMetrics: Array<{ batchSize: number; processingTime: number; timestamp: number; throughput: number }> = []; // Recent batch metrics for real-time analysis
  private batchSizeChangeHistory: Array<{ timestamp: number; oldSize: number; newSize: number; beforeMetrics: { avgThroughput: number; avgLatency: number }; afterMetrics?: { avgThroughput: number; avgLatency: number }; improvement?: number }> = []; // Track batch size changes and their impact
  private currentBatchSizeTarget: number | null = null; // Current dynamically calculated target batch size
  private adaptiveBatchSizeAdjustmentInterval: NodeJS.Timeout | null = null; // Interval for real-time batch size adjustments
  private lastAdaptiveBatchAdjustment = 0; // Timestamp of last adaptive adjustment
  private batchSizeAdjustmentCooldown = 30000; // Minimum time between adjustments (30 seconds)

  /**
   * Update orchestrator configuration dynamically
   */
  updateConfiguration(config: { workerThreads?: number; batchSize?: number; addressOffset?: number }): void {
    if (config.workerThreads !== undefined) {
      console.log(`[Orchestrator] Updating workerThreads: ${this.workerThreads} -> ${config.workerThreads}`);
      this.workerThreads = config.workerThreads;
      ConfigManager.setWorkerThreads(config.workerThreads);
      
      // OPTIMIZATION: Notify hash server about worker count change
      // This helps the server optimize (though workers are set at startup)
      hashEngine.notifyMiningWorkerCount(config.workerThreads).catch((err: any) => {
        console.warn(`[Orchestrator] Failed to notify hash server of worker count change: ${err.message}`);
      });
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
   * NEW: Real-time adaptive batch sizing takes priority over static values
   * Optimized for high-end systems: larger batches = better throughput
   * Includes adaptive reduction when hash service timeouts occur
   * CRITICAL: Now includes intelligent real-time optimization based on performance data
   */
  private getBatchSize(): number {
    // NEW: Real-time adaptive batch size takes highest priority
    if (this.currentBatchSizeTarget !== null && !this.batchSizeLock) {
      return this.currentBatchSizeTarget;
    }
    
    // If adaptive batch size is set (due to timeouts), use it
    if (this.adaptiveBatchSize !== null) {
      return this.adaptiveBatchSize;
    }
    
    // CRITICAL: Use optimal batch size if determined by performance analysis
    if (this.optimalBatchSize !== null && !this.batchSizeLock) {
      return this.optimalBatchSize;
    }
    
    if (this.customBatchSize !== null) {
      return this.customBatchSize;
    }
    
    // Fallback: Dynamic batch size based on worker count (should rarely be used)
    // This is only used if customBatchSize is somehow null (shouldn't happen)
    // CRITICAL FIX: For low-end systems, use smaller batches to avoid overwhelming the system
    // Low-end systems (< 10 workers): minimum 400
    // Mid-range (10-50 workers): 300 + (workers * 10)
    // High-end (50+ workers): larger batches for better throughput
    // Default minimum is 850 to match the default config
    if (this.workerThreads < 10) {
      // Low-end systems: smaller batches for stability
      // Minimum batch size is 400
      return Math.max(400, 200 + (this.workerThreads * 10));
    }
    // Mid-range and high-end: larger batches, but default to 850 if not set
    const dynamicBatchSize = Math.min(300 + (this.workerThreads * 10), 50000);
    return Math.max(850, dynamicBatchSize); // Default minimum is 850
  }
  
  /**
   * Calculate optimal batch size based on performance history
   * Analyzes batch processing times and hash rates to find optimal batch size
   */
  private calculateOptimalBatchSize(): number | null {
    if (this.batchPerformanceHistory.length < 50) {
      return null; // Not enough data yet
    }
    
    // Group by batch size and calculate average performance
    const batchSizeGroups = new Map<number, Array<{ processingTime: number; hashRate: number }>>();
    const recentHistory = this.batchPerformanceHistory.slice(-500); // Last 500 samples
    
    for (const sample of recentHistory) {
      if (!batchSizeGroups.has(sample.batchSize)) {
        batchSizeGroups.set(sample.batchSize, []);
      }
      batchSizeGroups.get(sample.batchSize)!.push({
        processingTime: sample.processingTime,
        hashRate: sample.hashRate,
      });
    }
    
    // Calculate throughput (hashes per second) for each batch size
    // Throughput = (batchSize / processingTime) * efficiency_factor
    // Efficiency factor accounts for overhead (smaller batches have more overhead)
    let bestBatchSize = 0;
    let bestThroughput = 0;
    
    for (const [batchSize, samples] of batchSizeGroups.entries()) {
      if (samples.length < 10) continue; // Need at least 10 samples
      
      const avgProcessingTime = samples.reduce((sum, s) => sum + s.processingTime, 0) / samples.length;
      const avgHashRate = samples.reduce((sum, s) => sum + s.hashRate, 0) / samples.length;
      
      // Calculate throughput: hashes per second
      // Account for overhead: smaller batches have proportionally more overhead
      const overheadFactor = Math.max(0.7, 1 - (100 / batchSize)); // Overhead decreases with batch size
      const throughput = (batchSize / avgProcessingTime) * overheadFactor * 1000; // Convert to H/s
      
      // Prefer batch sizes that maintain good hash rate
      // Weight by hash rate to prefer configurations that actually find solutions
      const weightedThroughput = throughput * (avgHashRate > 0 ? Math.log(avgHashRate + 1) : 0.1);
      
      if (weightedThroughput > bestThroughput) {
        bestThroughput = weightedThroughput;
        bestBatchSize = batchSize;
      }
    }
    
    if (bestBatchSize > 0) {
      // Clamp to reasonable bounds
      const minBatchSize = Math.max(400, this.workerThreads * 20);
      const maxBatchSize = Math.min(50000, this.workerThreads * 1000);
      return Math.max(minBatchSize, Math.min(maxBatchSize, bestBatchSize));
    }
    
    return null;
  }
  
  /**
   * NEW: Analyze recent batch metrics to determine if batch size needs adjustment
   * Returns: { needsAdjustment: boolean, direction: 'increase' | 'decrease' | null, reason: string, targetSize?: number }
   */
  private analyzeBatchSizeNeeds(): { needsAdjustment: boolean; direction: 'increase' | 'decrease' | null; reason: string; targetSize?: number } {
    if (this.recentBatchMetrics.length < 20) {
      return { needsAdjustment: false, direction: null, reason: 'Insufficient data (need at least 20 samples)' };
    }
    
    const recent = this.recentBatchMetrics.slice(-50); // Last 50 samples (~5 seconds of data)
    const currentBatchSize = this.getBatchSize();
    
    // Calculate average metrics
    const avgThroughput = recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length;
    const avgLatency = recent.reduce((sum, m) => sum + m.processingTime, 0) / recent.length;
    const avgBatchSize = recent.reduce((sum, m) => sum + m.batchSize, 0) / recent.length;
    
    // Determine optimal latency range (target: 50-200ms for good balance)
    const targetMinLatency = 50; // ms
    const targetMaxLatency = 200; // ms
    const idealLatency = 100; // ms (sweet spot)
    
    // Determine optimal throughput (should be high and stable)
    const throughputVariance = this.calculateVariance(recent.map(m => m.throughput));
    const isThroughputStable = throughputVariance < (avgThroughput * 0.3); // Less than 30% variance
    
    // Decision logic:
    // 1. If latency is too high (>200ms), batches are too large - decrease
    // 2. If latency is too low (<50ms), batches are too small - increase
    // 3. If throughput is low and latency is acceptable, try increasing batch size
    // 4. If throughput variance is high, adjust towards more stable size
    
    let direction: 'increase' | 'decrease' | null = null;
    let reason = '';
    let targetSize: number | undefined = undefined;
    
    if (avgLatency > targetMaxLatency) {
      // Batches are taking too long - reduce batch size
      direction = 'decrease';
      reason = `Latency too high (${avgLatency.toFixed(0)}ms > ${targetMaxLatency}ms)`;
      // Reduce by 15-25% depending on how far over we are
      const reductionFactor = Math.min(0.25, (avgLatency - targetMaxLatency) / targetMaxLatency);
      targetSize = Math.max(400, Math.floor(currentBatchSize * (1 - reductionFactor)));
    } else if (avgLatency < targetMinLatency && avgThroughput < avgBatchSize * 5) {
      // Latency is low but throughput could be better - increase batch size
      direction = 'increase';
      reason = `Latency low (${avgLatency.toFixed(0)}ms < ${targetMinLatency}ms) and throughput can improve`;
      // Increase by 10-20% depending on how far under we are
      const increaseFactor = Math.min(0.20, (targetMinLatency - avgLatency) / targetMinLatency);
      targetSize = Math.min(50000, Math.floor(currentBatchSize * (1 + increaseFactor)));
    } else if (!isThroughputStable && avgLatency < idealLatency) {
      // Throughput is unstable but we have headroom - try increasing for stability
      direction = 'increase';
      reason = `Throughput unstable (variance: ${(throughputVariance / avgThroughput * 100).toFixed(1)}%)`;
      targetSize = Math.min(50000, Math.floor(currentBatchSize * 1.1)); // 10% increase
    } else if (avgThroughput < avgBatchSize * 3 && avgLatency < idealLatency * 1.5) {
      // Throughput is low relative to batch size - try increasing
      direction = 'increase';
      reason = `Throughput low (${avgThroughput.toFixed(0)} H/s) relative to batch size`;
      targetSize = Math.min(50000, Math.floor(currentBatchSize * 1.15)); // 15% increase
    }
    
    // Only adjust if change is significant (>5%)
    if (direction && targetSize) {
      const changePercent = Math.abs(targetSize - currentBatchSize) / currentBatchSize;
      if (changePercent < 0.05) {
        return { needsAdjustment: false, direction: null, reason: 'Change too small (<5%)' };
      }
      
      // Clamp to reasonable bounds
      const minBatchSize = Math.max(400, this.workerThreads * 20);
      const maxBatchSize = Math.min(50000, this.workerThreads * 1000);
      targetSize = Math.max(minBatchSize, Math.min(maxBatchSize, targetSize));
      
      return { needsAdjustment: true, direction, reason, targetSize };
    }
    
    return { needsAdjustment: false, direction: null, reason: 'Performance metrics within acceptable range' };
  }
  
  /**
   * Calculate variance of an array of numbers
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  }
  
  /**
   * NEW: Evaluate the impact of a batch size change
   * Compares metrics before and after the change
   */
  private evaluateBatchSizeChangeImpact(): void {
    const now = Date.now();
    const evaluationWindow = 60000; // 60 seconds to evaluate impact
    
    // Find recent changes that need evaluation
    for (const change of this.batchSizeChangeHistory) {
      if (change.afterMetrics || now - change.timestamp < evaluationWindow) {
        continue; // Already evaluated or too recent
      }
      
      // Get metrics from the period after the change
      const afterStartTime = change.timestamp;
      const afterEndTime = Math.min(now, change.timestamp + evaluationWindow);
      const afterMetrics = this.recentBatchMetrics.filter(
        m => m.timestamp >= afterStartTime && m.timestamp <= afterEndTime
      );
      
      if (afterMetrics.length < 10) {
        continue; // Not enough data yet
      }
      
      // Calculate after metrics
      const avgAfterThroughput = afterMetrics.reduce((sum, m) => sum + m.throughput, 0) / afterMetrics.length;
      const avgAfterLatency = afterMetrics.reduce((sum, m) => sum + m.processingTime, 0) / afterMetrics.length;
      
      change.afterMetrics = {
        avgThroughput: avgAfterThroughput,
        avgLatency: avgAfterLatency,
      };
      
      // Calculate improvement (positive = better, negative = worse)
      const throughputImprovement = ((avgAfterThroughput - change.beforeMetrics.avgThroughput) / change.beforeMetrics.avgThroughput) * 100;
      const latencyImprovement = ((change.beforeMetrics.avgLatency - avgAfterLatency) / change.beforeMetrics.avgLatency) * 100;
      
      // Combined improvement score (weighted: 70% throughput, 30% latency)
      const improvement = (throughputImprovement * 0.7) + (latencyImprovement * 0.3);
      change.improvement = improvement;
      
      console.log(
        `[Orchestrator] 📊 Batch size change evaluation: ${change.oldSize} → ${change.newSize} ` +
        `(Throughput: ${change.beforeMetrics.avgThroughput.toFixed(0)} → ${avgAfterThroughput.toFixed(0)} H/s, ` +
        `Latency: ${change.beforeMetrics.avgLatency.toFixed(0)} → ${avgAfterLatency.toFixed(0)}ms, ` +
        `Improvement: ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}%)`
      );
    }
  }
  
  /**
   * NEW: Start real-time adaptive batch size adjustment
   * Continuously monitors performance and adjusts batch size dynamically
   */
  private startAdaptiveBatchSizeAdjustment(): void {
    // Clear any existing interval
    if (this.adaptiveBatchSizeAdjustmentInterval) {
      clearInterval(this.adaptiveBatchSizeAdjustmentInterval);
    }
    
    // Adjust every 30 seconds (with cooldown)
    this.adaptiveBatchSizeAdjustmentInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return;
      }
      
      // Check cooldown
      const now = Date.now();
      if (now - this.lastAdaptiveBatchAdjustment < this.batchSizeAdjustmentCooldown) {
        return;
      }
      
      if (this.batchSizeLock) {
        return; // Another adjustment in progress
      }
      
      // Evaluate impact of previous changes
      this.evaluateBatchSizeChangeImpact();
      
      // Analyze current batch size needs
      const analysis = this.analyzeBatchSizeNeeds();
      
      if (!analysis.needsAdjustment || !analysis.targetSize) {
        return; // No adjustment needed
      }
      
      this.batchSizeLock = true;
      try {
        const currentSize = this.getBatchSize();
        const newSize = analysis.targetSize;
        
        // Capture before metrics
        const recent = this.recentBatchMetrics.slice(-20);
        const beforeMetrics = {
          avgThroughput: recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length,
          avgLatency: recent.reduce((sum, m) => sum + m.processingTime, 0) / recent.length,
        };
        
        // Update target batch size
        this.currentBatchSizeTarget = newSize;
        this.lastAdaptiveBatchAdjustment = now;
        
        // Record change for impact evaluation
        this.batchSizeChangeHistory.push({
          timestamp: now,
          oldSize: currentSize,
          newSize: newSize,
          beforeMetrics: beforeMetrics,
        });
        
        // Keep only last 50 changes
        if (this.batchSizeChangeHistory.length > 50) {
          this.batchSizeChangeHistory = this.batchSizeChangeHistory.slice(-50);
        }
        
        console.log(
          `[Orchestrator] 🎯 Real-time batch size adjustment: ${analysis.direction} from ${currentSize} to ${newSize} ` +
          `(${analysis.reason})`
        );
        
        // Emit event for monitoring (simplified to avoid type issues)
        console.log(`[Orchestrator] 📈 Adaptive batch size: ${newSize} (reason: ${analysis.reason})`);
      } finally {
        this.batchSizeLock = false;
      }
    }, 10000); // Check every 10 seconds
  }
  
  /**
   * Start adaptive batch size optimization
   * Analyzes performance data and adjusts batch size for optimal throughput
   */
  private startBatchSizeOptimization(): void {
    // Clear any existing optimization
    if (this.batchOptimizationInterval) {
      clearInterval(this.batchOptimizationInterval);
    }
    if (this.adaptiveBatchSizeAdjustmentInterval) {
      clearInterval(this.adaptiveBatchSizeAdjustmentInterval);
    }
    
    // Optimize every 5 minutes
    this.batchOptimizationInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return;
      }
      
      // Don't optimize too frequently
      const now = Date.now();
      if (now - this.lastBatchOptimization < 5 * 60 * 1000) {
        return;
      }
      
      if (this.batchSizeLock) {
        return; // Another optimization in progress
      }
      
      this.batchSizeLock = true;
      try {
        const optimalSize = this.calculateOptimalBatchSize();
        if (optimalSize !== null && optimalSize !== this.optimalBatchSize) {
          const currentSize = this.getBatchSize();
          const improvement = optimalSize > currentSize ? 'increasing' : 'decreasing';
          console.log(`[Orchestrator] 🎯 Adaptive batch size optimization: ${improvement} from ${currentSize} to ${optimalSize} (based on ${this.batchPerformanceHistory.length} performance samples)`);
          
          // Only update if improvement is significant (>10%)
          if (Math.abs(optimalSize - currentSize) / currentSize > 0.1) {
            this.optimalBatchSize = optimalSize;
            this.lastBatchOptimization = now;
            
            // Emit event for monitoring
            this.emit('technical_metrics', {
              type: 'technical_metrics',
              timestamp: now,
              hashService: {
                timeoutCount: this.hashServiceTimeoutCount,
                lastTimeout: this.lastHashServiceTimeout,
                adaptiveBatchSizeActive: true,
                currentBatchSize: optimalSize,
                baseBatchSize: this.customBatchSize || 850,
              },
            } as MiningEvent);
          }
        }
      } finally {
        this.batchSizeLock = false;
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    
    console.log('[Orchestrator] Adaptive batch size optimization started (analyzes every 5 minutes)');
  }
  
  /**
   * Get current hash rate (helper method)
   */
  private getCurrentHashRate(): number {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastHashRateUpdate) / 1000;
    return elapsedSeconds > 0 ? this.totalHashesComputed / elapsedSeconds : 0;
  }
  
  /**
   * Thread-safe worker assignment getter
   */
  private getWorkerAssignment(workerId: number): string | undefined {
    return this.workerAddressAssignment.get(workerId);
  }
  
  /**
   * Thread-safe worker assignment setter
   */
  private async setWorkerAssignment(workerId: number, address: string): Promise<boolean> {
    // Acquire lock
    if (this.workerAssignmentLock.get(workerId)) {
      await this.sleep(10);
      // Check if already assigned
      const existing = this.workerAddressAssignment.get(workerId);
      if (existing) {
        return existing === address; // Return true if already assigned to same address
      }
    }
    
    this.workerAssignmentLock.set(workerId, true);
    try {
      const existing = this.workerAddressAssignment.get(workerId);
      if (existing && existing !== address) {
        return false; // Already assigned to different address
      }
      this.workerAddressAssignment.set(workerId, address);
      
      // OPTIMIZATION: Update reverse map for fast worker lookup by address
      if (existing && existing !== address) {
        // Remove from old address's worker set
        const oldWorkers = this.addressToWorkers.get(existing);
        if (oldWorkers) {
          oldWorkers.delete(workerId);
          if (oldWorkers.size === 0) {
            this.addressToWorkers.delete(existing);
          }
        }
      }
      // Add to new address's worker set
      let workers = this.addressToWorkers.get(address);
      if (!workers) {
        workers = new Set<number>();
        this.addressToWorkers.set(address, workers);
      }
      workers.add(workerId);
      
      return true;
    } finally {
      this.workerAssignmentLock.set(workerId, false);
    }
  }
  
  /**
   * Thread-safe worker assignment deleter
   */
  private deleteWorkerAssignment(workerId: number): void {
    // OPTIMIZATION: Update reverse map when removing assignment
    const address = this.workerAddressAssignment.get(workerId);
    if (address) {
      const workers = this.addressToWorkers.get(address);
      if (workers) {
        workers.delete(workerId);
        if (workers.size === 0) {
          this.addressToWorkers.delete(address);
        }
      }
    }
    this.workerAddressAssignment.delete(workerId);
    this.workerAssignmentLock.delete(workerId); // Also clear lock
  }
  
  /**
   * Calculate optimal worker count based on performance history
   * Analyzes CPU usage, hash rates, and system performance
   */
  private calculateOptimalWorkerCount(): number | null {
    if (this.workerPerformanceHistory.length < 20) {
      return null; // Not enough data yet
    }
    
    const maxCpuThreads = this.detectCpuThreadCount();
    const recentHistory = this.workerPerformanceHistory.slice(-100); // Last 100 samples
    
    // Group by worker count and calculate average performance
    const workerCountGroups = new Map<number, Array<{ hashRate: number; cpuUsage: number }>>();
    
    for (const sample of recentHistory) {
      if (!workerCountGroups.has(sample.workerCount)) {
        workerCountGroups.set(sample.workerCount, []);
      }
      workerCountGroups.get(sample.workerCount)!.push({
        hashRate: sample.hashRate,
        cpuUsage: sample.cpuUsage,
      });
    }
    
    // Calculate efficiency for each worker count
    // Efficiency = hashRate / (cpuUsage * workerCount) - prefer higher hash rate with lower CPU usage
    let bestWorkerCount = 0;
    let bestEfficiency = 0;
    
    for (const [workerCount, samples] of workerCountGroups.entries()) {
      if (samples.length < 5) continue; // Need at least 5 samples
      if (workerCount > maxCpuThreads) continue; // Don't exceed CPU threads
      
      const avgHashRate = samples.reduce((sum, s) => sum + s.hashRate, 0) / samples.length;
      const avgCpuUsage = samples.reduce((sum, s) => sum + s.cpuUsage, 0) / samples.length;
      
      // Efficiency metric: hash rate per CPU usage per worker
      // Higher is better - we want more hash rate with less CPU per worker
      const efficiency = avgHashRate > 0 && avgCpuUsage > 0 
        ? avgHashRate / (avgCpuUsage * workerCount) 
        : 0;
      
      // Prefer worker counts that:
      // 1. Have high efficiency
      // 2. Don't saturate CPU (>95% is bad)
      // 3. Are close to CPU thread count (utilize hardware)
      const cpuSaturationPenalty = avgCpuUsage > 95 ? 0.5 : 1.0;
      const threadUtilizationBonus = workerCount <= maxCpuThreads ? (workerCount / maxCpuThreads) : 0.5;
      const weightedEfficiency = efficiency * cpuSaturationPenalty * threadUtilizationBonus;
      
      if (weightedEfficiency > bestEfficiency) {
        bestEfficiency = weightedEfficiency;
        bestWorkerCount = workerCount;
      }
    }
    
    if (bestWorkerCount > 0) {
      // Clamp to reasonable bounds
      const minWorkers = Math.max(1, Math.floor(maxCpuThreads * 0.3)); // At least 30% of CPU
      const maxWorkers = Math.min(maxCpuThreads, Math.floor(maxCpuThreads * 1.0)); // Up to 100% of CPU
      return Math.max(minWorkers, Math.min(maxWorkers, bestWorkerCount));
    }
    
    return null;
  }
  
  /**
   * Start adaptive worker count optimization
   * Analyzes performance data and adjusts worker count for optimal efficiency
   */
  private startWorkerCountOptimization(): void {
    // Clear any existing optimization
    if (this.workerOptimizationInterval) {
      clearInterval(this.workerOptimizationInterval);
    }
    
    // Record performance every 30 seconds
    this.workerOptimizationInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return;
      }
      
      // Record current performance
      const currentHashRate = this.getCurrentHashRate();
      const currentCpuUsage = this.calculateCpuUsage();
      
      if (currentHashRate > 0) {
        this.workerPerformanceHistory.push({
          workerCount: this.workerThreads,
          hashRate: currentHashRate,
          cpuUsage: currentCpuUsage,
          timestamp: Date.now(),
        });
        
        // Keep only last 500 samples
        if (this.workerPerformanceHistory.length > 500) {
          this.workerPerformanceHistory = this.workerPerformanceHistory.slice(-500);
        }
      }
      
      // Optimize every 10 minutes (less frequent than batch size)
      const now = Date.now();
      if (now - this.lastWorkerOptimization < 10 * 60 * 1000) {
        return;
      }
      
      if (this.workerCountLock) {
        return; // Another optimization in progress
      }
      
      this.workerCountLock = true;
      try {
        const optimalCount = this.calculateOptimalWorkerCount();
        if (optimalCount !== null && optimalCount !== this.optimalWorkerCount && optimalCount !== this.workerThreads) {
          const improvement = optimalCount > this.workerThreads ? 'increasing' : 'decreasing';
          const improvementPercent = Math.abs((optimalCount - this.workerThreads) / this.workerThreads * 100);
          
          console.log(`[Orchestrator] 🎯 Adaptive worker count optimization: ${improvement} from ${this.workerThreads} to ${optimalCount} (${improvementPercent.toFixed(1)}% change, based on ${this.workerPerformanceHistory.length} performance samples)`);
          
          // Only update if improvement is significant (>15% change)
          if (improvementPercent > 15) {
            this.optimalWorkerCount = optimalCount;
            this.lastWorkerOptimization = now;
            
            // Update worker count (but don't save to config - let user decide)
            console.log(`[Orchestrator] 💡 Suggested optimal worker count: ${optimalCount} (current: ${this.workerThreads})`);
            console.log(`[Orchestrator] 💡 To apply, update worker count in UI or config`);
            
            // Log suggestion (don't emit incomplete event)
            console.log(`[Orchestrator] 💡 Performance analysis suggests ${optimalCount} workers would be more efficient`);
          }
        }
      } finally {
        this.workerCountLock = false;
      }
    }, 30 * 1000); // Record every 30 seconds
    
    console.log('[Orchestrator] Adaptive worker count optimization started (records every 30s, analyzes every 10 minutes)');
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

    // Emit system status: starting
    this.emit('system_status', {
      type: 'system_status',
      state: 'starting',
      message: 'Initializing mining system...',
      progress: 5,
    } as MiningEvent);

    // Store password for address registration
    (this as any).currentPassword = password;
    
    // Load persisted config or use provided values
    // NOTE: Config is already loaded in constructor, but we reload here to get latest from disk
    const persistedConfig = ConfigManager.loadConfig();
    
    // Emit system status: loading config
    this.emit('system_status', {
      type: 'system_status',
      state: 'starting',
      substate: 'loading_config',
      message: 'Loading configuration...',
      progress: 10,
      details: {
        workersConfigured: persistedConfig.workerThreads,
        batchSize: persistedConfig.batchSize,
      },
    } as MiningEvent);
    
    // CRITICAL: Only read addressOffset from config during startup
    // Never write to config file in start() method - only read from it
    // Only save addressOffset when user explicitly changes it via updateConfiguration()
    // This ensures the config file is not modified during startup or auto-startup
    const persistedOffset = persistedConfig.addressOffset ?? 0;
    
    if (addressOffset !== undefined) {
      // Offset provided - use it but DO NOT save to config
      // Only updateConfiguration() should save to config (called from UI)
      // This prevents auto-startup or internal calls from modifying the config file
      this.addressOffset = addressOffset;
      console.log(`[Orchestrator] Using provided addressOffset: ${addressOffset} (NOT saving to config - only UI changes are saved)`);
    } else {
      // No offset provided - always read from config (never write)
      // This is the case for auto-startup and other internal calls
      this.addressOffset = persistedOffset;
      console.log(`[Orchestrator] Using persisted addressOffset from config: ${this.addressOffset}`);
    }
    
    // CRITICAL FIX: Always use persisted worker threads and batch size (not just when at defaults)
    // This ensures settings are restored after app restart
    // CRITICAL: Validate and correct worker count if it exceeds maximum allowed
    // If worker count in storage is greater than MAX_WORKERS, cut it in half and save the corrected value
    const MAX_WORKERS = 1024;
    if (persistedConfig.workerThreads > MAX_WORKERS) {
      const correctedWorkerCount = Math.max(1, Math.floor(persistedConfig.workerThreads / 2));
      console.warn(`[Orchestrator] ⚠️  Worker count in config (${persistedConfig.workerThreads}) exceeds maximum (${MAX_WORKERS}). Reducing to ${correctedWorkerCount} and saving to config.`);
      this.workerThreads = correctedWorkerCount;
      ConfigManager.setWorkerThreads(correctedWorkerCount);
    } else {
      this.workerThreads = persistedConfig.workerThreads;
    }
    // CRITICAL: Always load batch size from persisted config to ensure user settings are respected
    // This prevents the dynamic calculation from overriding user-set values
    this.customBatchSize = persistedConfig.batchSize;
    
    // Optimize for high-end systems: mine multiple addresses in parallel
    // For systems with 100+ vCPUs, we can mine multiple addresses simultaneously
    // Formula: min(workerThreads / 10, 10) - allows up to 10 parallel addresses
    // CRITICAL FIX: For low-end systems (< 20 workers), always use 1 address to avoid spreading workers too thin
    // This ensures low-end systems have all workers focused on one address for better solution rates
    const optimalConcurrentAddresses = this.workerThreads >= 20 
      ? Math.min(Math.max(1, Math.floor(this.workerThreads / 10)), 10)
      : 1; // Low-end systems: single address mode for better performance
    this.maxConcurrentAddresses = parseInt(process.env.MINING_MAX_CONCURRENT_ADDRESSES || optimalConcurrentAddresses.toString(), 10);
    console.log(`[Orchestrator] Max concurrent addresses: ${this.maxConcurrentAddresses} (${this.workerThreads} total workers)`);
    
    this.addressesPerRange = parseInt(process.env.MINING_ADDRESSES_PER_RANGE || '200', 10);

    // Emit system status: loading wallet
    this.emit('system_status', {
      type: 'system_status',
      state: 'starting',
      substate: 'loading_wallet',
      message: 'Loading wallet addresses...',
      progress: 20,
    } as MiningEvent);
    
    // Load wallet
    this.walletManager = new WalletManager();
    const allAddresses = await this.walletManager.loadWallet(password);

    // Calculate required address count for the selected offset
    const startIndex = this.addressOffset * this.addressesPerRange;
    const endIndex = startIndex + this.addressesPerRange;
    const requiredAddressCount = endIndex; // Need addresses up to endIndex (exclusive)
    
    // CRITICAL: Validate address indices are correct and sequential
    // This prevents using corrupted address files with wrong indices
    let addressIndicesValid = true;
    let addressIndicesIssues: string[] = [];
    
    // Emit validation start event
    this.emit('address_validation', {
      type: 'address_validation',
      stage: 'loading',
      message: `Loading ${allAddresses.length} addresses from wallet...`,
      progress: 10,
      addressesTotal: allAddresses.length,
    } as MiningEvent);
    
    if (allAddresses.length > 0) {
      // Emit validation in progress
      this.emit('address_validation', {
        type: 'address_validation',
        stage: 'validating',
        message: 'Validating address indices...',
        progress: 30,
        addressesChecked: allAddresses.length,
        addressesTotal: allAddresses.length,
      } as MiningEvent);
      
      // Check for missing indices (gaps)
      const indices = new Set(allAddresses.map(a => a.index));
      const maxIndex = Math.max(...allAddresses.map(a => a.index));
      const expectedIndices = new Set(Array.from({ length: allAddresses.length }, (_, i) => i));
      
      // Check if indices are sequential starting from 0
      for (let i = 0; i < allAddresses.length; i++) {
        if (!indices.has(i)) {
          addressIndicesValid = false;
          addressIndicesIssues.push(`Missing index ${i}`);
        }
      }
      
      // Check for duplicate indices
      const indexCounts = new Map<number, number>();
      for (const addr of allAddresses) {
        indexCounts.set(addr.index, (indexCounts.get(addr.index) || 0) + 1);
      }
      for (const [index, count] of indexCounts.entries()) {
        if (count > 1) {
          addressIndicesValid = false;
          addressIndicesIssues.push(`Duplicate index ${index} (${count} times)`);
        }
      }
      
      // Check for out-of-range indices
      for (const addr of allAddresses) {
        if (addr.index < 0 || addr.index >= allAddresses.length) {
          addressIndicesValid = false;
          addressIndicesIssues.push(`Out-of-range index ${addr.index} (expected 0-${allAddresses.length - 1})`);
        }
      }
    }
    
    // If address indices are invalid, regenerate addresses
    if (!addressIndicesValid) {
      console.error(`[Orchestrator] ❌ Address file corruption detected! Issues: ${addressIndicesIssues.join(', ')}`);
      console.error(`[Orchestrator] Regenerating addresses to fix corruption...`);
      
      // Emit fixing event
      this.emit('address_validation', {
        type: 'address_validation',
        stage: 'fixing',
        message: `Address corruption detected. Regenerating addresses...`,
        progress: 50,
        issues: addressIndicesIssues,
        addressesTotal: allAddresses.length,
      } as MiningEvent);
      
      try {
        // Regenerate all addresses from scratch
        await this.walletManager.expandAddresses(password, Math.max(requiredAddressCount, allAddresses.length));
        console.log(`[Orchestrator] ✓ Successfully regenerated addresses`);
        
        // Reload addresses after regeneration
        const regeneratedAddresses = await this.walletManager.loadWallet(password);
        allAddresses.length = 0; // Clear old addresses
        allAddresses.push(...regeneratedAddresses); // Use regenerated addresses
        
        // Emit completion
        this.emit('address_validation', {
          type: 'address_validation',
          stage: 'complete',
          message: `Successfully regenerated ${regeneratedAddresses.length} addresses`,
          progress: 100,
          addressesTotal: regeneratedAddresses.length,
        } as MiningEvent);
      } catch (error: any) {
        console.error(`[Orchestrator] Failed to regenerate addresses:`, error);
        this.emit('address_validation', {
          type: 'address_validation',
          stage: 'error',
          message: `Failed to regenerate addresses: ${error.message}`,
          progress: 0,
          issues: [error.message],
        } as MiningEvent);
        throw new Error(`Address file corruption detected and regeneration failed. Please delete derived-addresses.json and restart. Error: ${error.message}`);
      }
    } else {
      // Emit validation complete
      this.emit('address_validation', {
        type: 'address_validation',
        stage: 'complete',
        message: `All ${allAddresses.length} addresses validated successfully`,
        progress: 100,
        addressesChecked: allAddresses.length,
        addressesTotal: allAddresses.length,
      } as MiningEvent);
    }
    
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
    
    // CRITICAL: Validate filtered addresses match the expected range
    const invalidAddresses = this.addresses.filter(addr => addr.index < startIndex || addr.index >= endIndex);
    if (invalidAddresses.length > 0) {
      console.error(`[Orchestrator] ❌ CRITICAL: Found ${invalidAddresses.length} addresses outside expected range ${startIndex}-${endIndex - 1}`);
      for (const addr of invalidAddresses.slice(0, 5)) {
        console.error(`[Orchestrator]   - Address index ${addr.index} (expected ${startIndex}-${endIndex - 1})`);
      }
      throw new Error(`Address validation failed: ${invalidAddresses.length} addresses have incorrect indices for offset ${this.addressOffset}. Expected range: ${startIndex}-${endIndex - 1}`);
    }
    
    // CRITICAL: Verify we have exactly 200 addresses (or addressesPerRange) in the range
    const expectedCount = endIndex - startIndex;
    if (this.addresses.length !== expectedCount) {
      console.error(`[Orchestrator] ❌ CRITICAL: Expected ${expectedCount} addresses for offset ${this.addressOffset} (range ${startIndex}-${endIndex - 1}), but found ${this.addresses.length}`);
      throw new Error(`Address count mismatch: Expected ${expectedCount} addresses for offset ${this.addressOffset}, but found ${this.addresses.length}. Address file may be corrupted.`);
    }
    
    // CRITICAL: Verify all addresses have sequential indices within the range
    const addressIndices = this.addresses.map(a => a.index).sort((a, b) => a - b);
    for (let i = 0; i < addressIndices.length; i++) {
      const expectedIndex = startIndex + i;
      if (addressIndices[i] !== expectedIndex) {
        console.error(`[Orchestrator] ❌ CRITICAL: Address at position ${i} has index ${addressIndices[i]}, expected ${expectedIndex}`);
        throw new Error(`Address index mismatch: Address at position ${i} has index ${addressIndices[i]}, expected ${expectedIndex}. Address file is corrupted.`);
      }
    }

    console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
    console.log(`[Orchestrator] ║ ADDRESS RANGE CONFIGURATION                               ║`);
    console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
    console.log(`[Orchestrator] ║ Address Offset:            ${this.addressOffset.toString().padStart(4, ' ')}                                    ║`);
    console.log(`[Orchestrator] ║ Address Range:             ${startIndex.toString().padStart(4, ' ')} - ${(endIndex - 1).toString().padStart(4, ' ')}                              ║`);
    console.log(`[Orchestrator] ║ Total Wallet Addresses:    ${finalAddressCount.toString().padStart(4, ' ')}                                    ║`);
    console.log(`[Orchestrator] ║ Addresses for This Miner:   ${this.addresses.length.toString().padStart(4, ' ')} (validated)                        ║`);
    console.log(`[Orchestrator] ║ Address Validation:         ✓ PASSED                                                    ║`);
    console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);
    
    if (this.addresses.length === 0) {
      console.error(`[Orchestrator] ❌ No addresses found in range ${startIndex}-${endIndex - 1} after expansion`);
      throw new Error(`No addresses available for offset ${this.addressOffset} (range ${startIndex}-${endIndex - 1}). This should not happen after automatic expansion.`);
    }

    // Emit system status: addresses validated
    this.emit('system_status', {
      type: 'system_status',
      state: 'starting',
      substate: 'addresses_validated',
      message: `Addresses validated: ${this.addresses.length} addresses ready`,
      progress: 60,
      details: {
        addressesLoaded: this.addresses.length,
        addressesValidated: true,
        workersConfigured: this.workerThreads,
        batchSize: this.getBatchSize(),
      },
    } as MiningEvent);
    
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

    // Start hash rate monitoring for automatic recovery
    this.startHashRateMonitoring(password, this.addressOffset);

    // Start stability checks and repairs
    this.startStabilityChecks();

    // Start technical metrics reporting
    this.startTechnicalMetricsReporting();
    
    // CRITICAL: Start automatic recovery mechanism (detects no active workers and restarts mining)
    this.startAutomaticRecovery(password, this.addressOffset);
    
    // CRITICAL: Start adaptive optimizations
    this.startBatchSizeOptimization();
    this.startAdaptiveBatchSizeAdjustment(); // NEW: Start real-time adaptive batch sizing
    this.startWorkerCountOptimization();
    
    // OPTIMIZATION: Notify hash server about mining worker count
    // This helps the server optimize its configuration (though workers are set at startup)
    hashEngine.notifyMiningWorkerCount(this.workerThreads).catch((err: any) => {
      console.warn(`[Orchestrator] Failed to notify hash server of worker count: ${err.message}`);
    });

    // Emit system status: running
    const registeredCount = this.addresses.filter(a => a.registered).length;
    this.emit('system_status', {
      type: 'system_status',
      state: 'running',
      message: 'Mining system fully operational',
      progress: 100,
      details: {
        addressesLoaded: this.addresses.length,
        addressesValidated: true,
        workersConfigured: this.workerThreads,
        workersActive: this.workerThreads,
        batchSize: this.getBatchSize(),
        challengeId: this.currentChallengeId,
        registrationComplete: registeredCount >= this.addresses.length,
      },
    } as MiningEvent);
    
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

    // Clear hash rate monitoring
    if (this.hashRateMonitorInterval) {
      clearInterval(this.hashRateMonitorInterval);
      this.hashRateMonitorInterval = null;
    }
    this.hashRateHistory = [];
    this.lastHashRateRestart = 0; // Reset restart timestamp when manually stopping
    this.baselineHashRate = null; // Reset baseline when manually stopping
    this.baselineStartTime = null;

    // Clear stability check interval
    if (this.stabilityCheckInterval) {
      clearInterval(this.stabilityCheckInterval);
      this.stabilityCheckInterval = null;
    }

    // Clear technical metrics reporting
    if (this.technicalMetricsInterval) {
      clearInterval(this.technicalMetricsInterval);
      this.technicalMetricsInterval = null;
    }
    
    // Clear automatic recovery check interval
    if (this.automaticRecoveryCheckInterval) {
      clearInterval(this.automaticRecoveryCheckInterval);
      this.automaticRecoveryCheckInterval = null;
    }
    
    // CRITICAL FIX: Clear adaptive optimization intervals
    if (this.batchOptimizationInterval) {
      clearInterval(this.batchOptimizationInterval);
      this.batchOptimizationInterval = null;
    }
    
    if (this.workerOptimizationInterval) {
      clearInterval(this.workerOptimizationInterval);
      this.workerOptimizationInterval = null;
    }

    // CRITICAL FIX: Clean up hash client connection pool to prevent resource leaks
    try {
      const hashClient = (hashEngine as any).hashClient;
      if (hashClient && typeof hashClient.destroy === 'function') {
        hashClient.destroy();
        console.log('[Orchestrator] Hash client connection pool destroyed');
      }
    } catch (error) {
      console.warn('[Orchestrator] Error destroying hash client:', error);
    }

    // CRITICAL FIX: Clean up worker stats and assignments to prevent memory leaks
    this.workerStats.clear();
    this.workerAddressAssignment.clear();
    this.stoppedWorkers.clear();
    this.submittingAddresses.clear();
    this.pausedAddresses.clear();
    this.addressSubmissionFailures.clear();
    this.lastMineAttempt.clear(); // Clear blocked addresses when stopping
    this.cachedSubmissionKeys.clear();
    this.solvedAddressChallenges.clear();
    this.submittedSolutions.clear();
    this.addressesProcessedCurrentChallenge.clear();
    
    // CRITICAL FIX: Clear adaptive optimization data
    this.batchPerformanceHistory = [];
    this.recentBatchMetrics = [];
    this.batchSizeChangeHistory = [];
    this.workerPerformanceHistory = [];
    this.optimalBatchSize = null;
    this.currentBatchSizeTarget = null;
    this.optimalWorkerCount = null;
    this.workerAssignmentLock.clear();
    this.workerHashesSinceLastUpdate.clear();
    this.addressToWorkers.clear();
    this.staticPreimageCache.clear();

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
    
    // CRITICAL FIX: Calculate solutions found from receipts for accuracy
    // This ensures the count is accurate even after restarts
    const allReceipts = receiptsLogger.readReceipts();
    const userReceipts = allReceipts.filter(r => !r.isDevFee);
    const totalSolutionsFound = userReceipts.length;

    return {
      active: this.isRunning,
      challengeId: this.currentChallengeId,
      solutionsFound: totalSolutionsFound, // Use receipts count for accuracy
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

        // CRITICAL: Save old challenge ID before updating (needed for cleanup)
        const oldChallengeId = this.currentChallengeId;

        // Reset challenge progress tracking
        this.addressesProcessedCurrentChallenge.clear();
        this.submittedSolutions.clear(); // Clear submitted solutions for new challenge
        
        // CRITICAL: Clear all failure counters for new challenge
        // This ensures addresses can be retried on new challenges even if they failed on previous ones
        this.addressSubmissionFailures.clear();
        
        // Clear worker address assignments for new challenge
    this.workerAddressAssignment.clear();
    this.addressToWorkers.clear(); // Clear reverse map when clearing assignments
    this.staticPreimageCache.clear(); // Clear preimage cache on challenge change
        
        // Reset hash service timeout tracking for new challenge
        this.hashServiceTimeoutCount = 0;
        this.lastHashServiceTimeout = 0;
        this.adaptiveBatchSize = null; // Reset adaptive batch size on new challenge
        
        // CRITICAL: Clean up all stale state for old challenge
        // This prevents addresses/workers from getting stuck in old challenge states
        this.cleanupStaleChallengeState(oldChallengeId);
        
        // CRITICAL FIX: Clean up solvedAddressChallenges for old challenges
        // Remove old challenge IDs from all addresses to prevent unbounded growth
        let cleanedSolvedChallenges = 0;
        for (const [address, solvedChallenges] of this.solvedAddressChallenges.entries()) {
          // Keep only the current challenge (if address has solved it)
          // This prevents the Set from growing unbounded with old challenge IDs
          if (challengeId && solvedChallenges.has(challengeId)) {
            // Address has solved current challenge - keep only current challenge
            const oldSize = solvedChallenges.size;
            solvedChallenges.clear();
            solvedChallenges.add(challengeId);
            cleanedSolvedChallenges += oldSize - 1;
          } else {
            // Address hasn't solved current challenge - clear all old challenges
            const oldSize = solvedChallenges.size;
            solvedChallenges.clear();
            cleanedSolvedChallenges += oldSize;
          }
        }
        if (cleanedSolvedChallenges > 0) {
          console.log(`[Orchestrator] Cleaned ${cleanedSolvedChallenges} old solved challenge IDs (prevented memory leak)`);
        }
        
        // OPTIMIZATION: Invalidate registered addresses cache to force refresh
        this.cachedRegisteredAddresses = null;
        this.lastRegisteredAddressesUpdate = 0;
        
        // OPTIMIZATION: Clear submission key cache on challenge change (keys are challenge-specific)
        this.cachedSubmissionKeys.clear();
        
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

        // CRITICAL: Clear all failure counters for old challenge - they're no longer relevant
        // New challenge means fresh start for all addresses
        const oldChallengeFailures = Array.from(this.addressSubmissionFailures.keys()).filter(
          key => !key.endsWith(`:${challengeId}`)
        );
        if (oldChallengeFailures.length > 0) {
          console.log(`[Orchestrator] Clearing ${oldChallengeFailures.length} stale failure counters from previous challenge`);
          oldChallengeFailures.forEach(key => this.addressSubmissionFailures.delete(key));
        }

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
        
        // CRITICAL FIX: Clear blocked addresses when challenge data changes significantly
        // This mimics what stop/start does - clears failure state so addresses can retry immediately
        // This prevents workers from sitting idle when challenge data updates
        if (this.currentChallenge) {
          const challengeDataChanged = 
            challenge.challenge.latest_submission !== this.currentChallenge.latest_submission ||
            challenge.challenge.no_pre_mine_hour !== this.currentChallenge.no_pre_mine_hour ||
            challenge.challenge.difficulty !== this.currentChallenge.difficulty;
          
          if (challengeDataChanged) {
            // CRITICAL FIX: Clear ALL blocked state when challenge data changes
            // This mimics what stop/start does - completely resets failure state
            const failuresBefore = this.addressSubmissionFailures.size;
            const blockedBefore = this.lastMineAttempt.size;
            const pausedBefore = this.pausedAddresses.size;
            const submittingBefore = this.submittingAddresses.size;
            
            // Clear failure counters for addresses that failed due to stale challenge data
            // This is what stop() does (line 1339) - we're doing it at runtime
            this.addressSubmissionFailures.clear();
            
            // Clear lastMineAttempt to unblock all addresses for immediate retry
            // This is what startMining() does (line 2083) - we're doing it at runtime
            this.lastMineAttempt.clear();
            
            // Clear paused and submitting states - these can also block addresses
            // This ensures addresses aren't stuck in paused/submitting state with stale data
            this.pausedAddresses.clear();
            this.submittingAddresses.clear();
            
            // Reset consecutive recovery attempts since we're proactively fixing the issue
            this.consecutiveRecoveryAttempts = 0;
            
            if (failuresBefore > 0 || blockedBefore > 0 || pausedBefore > 0 || submittingBefore > 0) {
              console.log(`[Orchestrator] 🔄 Challenge data changed - cleared ${failuresBefore} failures, ${blockedBefore} blocked, ${pausedBefore} paused, ${submittingBefore} submitting (all addresses can retry immediately)`);
              
              // Emit event to notify UI
              this.emit('error', {
                type: 'error',
                message: `Challenge data updated - ${blockedBefore + pausedBefore + submittingBefore} blocked addresses unblocked for immediate retry`,
              } as MiningEvent);
            }
          }
        }
      }
    }
  }

  /**
   * Get dynamically filtered list of addresses available for mining
   * This refreshes the registered addresses list and filters out solved addresses
   * Called before each address iteration to pick up newly registered addresses
   * OPTIMIZATION: Cache registered addresses to avoid filtering every iteration
   */
  private getAvailableAddressesForMining(): DerivedAddress[] {
    const currentChallengeId = this.currentChallengeId;
    if (!currentChallengeId) {
      return [];
    }

    // OPTIMIZATION: Cache registered addresses (update cache every 5 seconds or when addresses change)
    const now = Date.now();
    const cacheAge = now - this.lastRegisteredAddressesUpdate;
    if (!this.cachedRegisteredAddresses || cacheAge > 5000) {
      // Refresh cache
      this.cachedRegisteredAddresses = this.addresses.filter(a => a.registered);
      this.lastRegisteredAddressesUpdate = now;
    }
    const registeredAddresses = this.cachedRegisteredAddresses;

    // Filter out addresses that have already solved this challenge
    // OPTIMIZATION: Use single pass filter instead of chained filters
    const availableAddresses: DerivedAddress[] = [];
    for (let i = 0; i < registeredAddresses.length; i++) {
      const addr = registeredAddresses[i];
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      const alreadySolved = solvedChallenges && solvedChallenges.has(currentChallengeId);
      if (!alreadySolved) {
        availableAddresses.push(addr);
      }
    }

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
    addressesInProgress: Set<string>
  ): Promise<void> {
    const MAX_SUBMISSION_FAILURES = 6;
    // CRITICAL FIX: Reduced retry delay from 30s to 5s
    // The old 30s delay was causing workers to sit idle when addresses failed
    // 5 seconds is enough to prevent retry loops while keeping workers busy
    const MIN_RETRY_DELAY = 5000; // 5 seconds - minimal delay to prevent immediate retry loops
    const now = Date.now();
    
    // CRITICAL: Reset failure counter if we're retrying after delay OR if challenge data changed
    const submissionKey = `${addr.bech32}:${challengeId}`;
    const lastAttempt = this.lastMineAttempt.get(addr.bech32);
    const timeSinceLastAttempt = lastAttempt ? (now - lastAttempt) : 0;
    
    // Check if challenge data has changed since last attempt (indicates stale failures)
    // Note: We can't compare to the challenge parameter here since it's passed in, but we can check
    // if the current challenge has changed since the last attempt by checking if challengeId changed
    // or if enough time has passed (challenge data updates frequently)
    const challengeDataChanged = this.currentChallengeId !== challengeId || 
      (lastAttempt && (now - lastAttempt) > 60000); // If >60s passed, challenge data likely changed
    
    if (timeSinceLastAttempt >= MIN_RETRY_DELAY || challengeDataChanged) {
      const failureCount = this.addressSubmissionFailures.get(submissionKey);
      if (failureCount && failureCount > 0) {
        const reason = challengeDataChanged 
          ? 'challenge data changed (stale failures cleared)' 
          : `retry after delay (${Math.floor(timeSinceLastAttempt / 1000)}s)`;
        console.log(`[Orchestrator] Retrying address ${addr.index} - clearing previous failure count (${failureCount}) - ${reason}`);
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

    // CRITICAL FIX: Only clear stopped workers for THIS address, not all addresses
    // This prevents clearing stopped workers for other addresses in parallel mode
    // For single address mode, we can clear all, but for safety, only clear workers in our range
    for (let i = workerStartId; i < workerEndId; i++) {
      this.stoppedWorkers.delete(i);
    }

    // Launch workers for this address
    // CRITICAL: Thread-safe check if any workers are already assigned to this address to prevent duplicate mining
    const userWorkerCount = workerEndId - workerStartId;
    const alreadyAssignedWorkers: number[] = [];
    for (let i = 0; i < userWorkerCount; i++) {
      const workerId = workerStartId + i;
      // CRITICAL FIX: Use thread-safe getter
      const existingAssignment = this.getWorkerAssignment(workerId);
      if (existingAssignment === addr.bech32) {
        // Worker is already assigned to this address - skip to prevent duplicate mining
        console.warn(`[Orchestrator] ⚠️  Worker ${workerId} is already assigned to address ${addr.index}. Skipping duplicate assignment.`);
        alreadyAssignedWorkers.push(workerId);
        continue;
      } else if (existingAssignment && existingAssignment !== addr.bech32) {
        // Worker is assigned to a different address - this is a conflict
        console.warn(`[Orchestrator] ⚠️  Worker ${workerId} is already assigned to a different address. Clearing assignment before reassigning.`);
        this.deleteWorkerAssignment(workerId);
      }
      // CRITICAL FIX: Thread-safe assignment
      const assigned = await this.setWorkerAssignment(workerId, addr.bech32);
      if (!assigned) {
        // Assignment failed (race condition), skip this worker
        console.warn(`[Orchestrator] ⚠️  Worker ${workerId} assignment failed (race condition), skipping`);
        alreadyAssignedWorkers.push(workerId);
      }
    }
    
    // If all workers were already assigned, skip launching new workers
    if (alreadyAssignedWorkers.length === userWorkerCount) {
      console.warn(`[Orchestrator] ⚠️  All workers for address ${addr.index} are already assigned. Skipping duplicate mining.`);
      return;
    }
    
    // OPTIMIZATION: Pre-allocate array and fill directly (faster than fill().map())
    // Then launch the workers
    const workers = new Array(userWorkerCount);
    for (let idx = 0; idx < userWorkerCount; idx++) {
      workers[idx] = this.mineForAddress(addr, false, workerStartId + idx, MAX_SUBMISSION_FAILURES);
    }

    // Wait for ALL workers to complete
    // CRITICAL FIX: Use Promise.allSettled instead of Promise.all to handle individual worker failures
    // This ensures all workers complete even if one fails, preventing premature exit
    try {
      const results = await Promise.allSettled(workers);
      // Log any rejected workers
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') {
          const workerId = workerStartId + i;
          console.error(`[Orchestrator] Worker ${workerId} for address ${addr.index} failed:`, result.reason);
          // Clear worker state on failure
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          const workerData = this.workerStats.get(workerId);
          if (workerData) {
            workerData.status = 'idle';
          }
        }
      }
    } catch (error) {
      // This shouldn't happen with allSettled, but defensive programming
      console.error(`[Orchestrator] Unexpected error in workers for address ${addr.index}:`, error);
    } finally {
      // Always remove from in-progress set
      addressesInProgress.delete(addr.bech32);
      
      // CRITICAL: If challenge changed, clear lastMineAttempt to allow immediate retry on new challenge
      // This prevents addresses from being stuck in retry state when challenge changes
      if (this.currentChallengeId !== challengeId) {
        this.lastMineAttempt.delete(addr.bech32);
        // Also clear failure counter for old challenge
        const oldSubmissionKey = `${addr.bech32}:${challengeId}`;
        this.addressSubmissionFailures.delete(oldSubmissionKey);
        console.log(`[Orchestrator] Challenge changed for address ${addr.index}, cleared retry state for immediate availability on new challenge`);
      }
      
      // Clear worker assignments for this address when done
      for (let i = 0; i < userWorkerCount; i++) {
        const workerId = workerStartId + i;
        // CRITICAL FIX: Thread-safe check and delete
        if (this.getWorkerAssignment(workerId) === addr.bech32) {
          this.deleteWorkerAssignment(workerId);
        }
        // Also clear stopped workers for this address
        this.stoppedWorkers.delete(workerId);
        // CRITICAL FIX: Don't delete idle workers - they need to be reusable for new addresses!
        // Only delete completed workers that are truly done (after a short delay to prevent immediate reuse)
        // Idle workers should remain in workerStats so they can be immediately reassigned to new addresses
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          if (workerData.status === 'completed') {
            // Only delete completed workers after they've been completed for > 30 seconds
            // This prevents immediate deletion and allows for potential reuse if needed
            const timeSinceCompletion = now - (workerData.lastUpdateTime || now);
            if (timeSinceCompletion > 30000) { // 30 seconds
              this.workerStats.delete(workerId);
            }
          }
          // CRITICAL: Don't delete idle workers - they must be reusable!
          // Idle workers are immediately available for new address assignments
        }
      }
    }

    // Check if address was successfully solved
    const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
    const addressSolved = solvedChallenges?.has(challengeId) || false;

    if (addressSolved) {
      console.log(`[Orchestrator] ✓ Address ${addr.index} SOLVED!`);
      this.lastMineAttempt.delete(addr.bech32);
    } else {
      console.log(`[Orchestrator] ✗ Address ${addr.index} FAILED after ${MAX_SUBMISSION_FAILURES} attempts.`);
      console.log(`[Orchestrator] Will retry this address after ${MIN_RETRY_DELAY / 1000}s (challenge data may have updated)`);
      
      // CRITICAL FIX: Clear worker state for this address and ensure workers are immediately available for reuse
      // This ensures workers are available for other addresses and don't remain in a failed state
      const workerCount = workerEndId - workerStartId;
      const now = Date.now();
      for (let i = 0; i < workerCount; i++) {
        const workerId = workerStartId + i;
        // Clear worker assignment so worker can be assigned to new address
        // CRITICAL FIX: Thread-safe check and delete
        if (this.getWorkerAssignment(workerId) === addr.bech32) {
          this.deleteWorkerAssignment(workerId);
        }
        // Clear stopped workers for this address
        this.stoppedWorkers.delete(workerId);
        // CRITICAL: Reset worker status to idle and update timestamp so it's immediately available
        // Don't delete worker stats - they need to be reusable!
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.status = 'idle';
          workerData.lastUpdateTime = now; // Update timestamp so worker is considered fresh
          // Clear address-specific data but keep worker stats for reuse
          workerData.addressIndex = -1; // Mark as unassigned
          workerData.address = ''; // Clear address
        } else {
          // CRITICAL: If worker stats don't exist, create them so worker can be reused
          // This handles the case where worker was deleted but needs to be reused
          this.workerStats.set(workerId, {
            workerId,
            addressIndex: -1,
            address: '',
            hashesComputed: 0,
            hashRate: 0,
            solutionsFound: 0,
            startTime: now,
            lastUpdateTime: now,
            status: 'idle',
            currentChallenge: challengeId,
          });
        }
      }
      
      // Clear submission/pause state for this address
      const submissionKey = `${addr.bech32}:${challengeId}`;
      this.submittingAddresses.delete(submissionKey);
      this.pausedAddresses.delete(submissionKey);
      
      // CRITICAL FIX: Set lastMineAttempt to NOW (not in finally block) so retry delay starts immediately
      // This allows the address to be retried after MIN_RETRY_DELAY, but workers are immediately available
      // for OTHER addresses that haven't failed yet
      this.lastMineAttempt.set(addr.bech32, now);
      
      console.log(`[Orchestrator] Cleared worker state for address ${addr.index} - ${workerCount} workers now available for new addresses`);
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
    
    // CRITICAL: Reset flag for logging full worker restore (new challenge = new registration state)
    this.hasLoggedFullWorkerRestore = false;
    
    // CRITICAL: Clear any stale failure counters for addresses that might have been stuck from previous challenge
    // This ensures addresses are immediately available when a new challenge starts
    // We only clear entries that match the old challenge pattern (if any exist)
    // The main clearing happens in pollAndMine, but this is a safety net
    console.log(`[Orchestrator] Starting mining for challenge ${currentChallengeId.slice(0, 8)}... - ensuring clean state`);

    // Get initial count for logging
    // OPTIMIZATION: Initialize cache and use it
    this.cachedRegisteredAddresses = this.addresses.filter(a => a.registered);
    this.lastRegisteredAddressesUpdate = Date.now();
    const initialRegisteredCount = this.cachedRegisteredAddresses.length;
    const allAddressesRegistered = initialRegisteredCount >= this.addresses.length;
    const effectiveWorkerCount = allAddressesRegistered 
      ? this.workerThreads  // Use 100% of workers once all addresses are registered
      : Math.max(1, Math.floor(this.workerThreads * 0.5)); // Use 50% during registration
    const logMsg = allAddressesRegistered
      ? `Starting mining with ${this.workerThreads} parallel workers on ${initialRegisteredCount} registered addresses`
      : `Starting mining with ${effectiveWorkerCount}/${this.workerThreads} workers (50% during registration) on ${initialRegisteredCount}/${this.addresses.length} registered addresses`;
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

    // CRITICAL: Don't initialize baseline here - wait for registration to complete
    // Baseline will be started in hash rate monitoring when all addresses are registered
    // This ensures we only collect baseline during actual mining performance (after registration)
    // The baselineStartTime will be set in the hash rate monitoring loop when registration completes
    // Reset baseline flags so they can be set when registration completes
    this.baselineHashRate = null;
    this.baselineStartTime = null; // Will be set when registration completes
    this.baselineRegistrationComplete = false; // Track registration status

    // Track addresses that are currently being mined to avoid duplicate work
    // But allow retries after failures (don't permanently block addresses)
    const addressesInProgress = new Set<string>();
    // CRITICAL: Use class property lastMineAttempt (not local variable) so it can be cleared when challenge data changes
    // This allows pollAndMine() to unblock addresses when challenge data updates
    this.lastMineAttempt.clear(); // Clear any stale entries from previous mining session
    const MIN_RETRY_DELAY = 5000; // Retry failed addresses after 5 seconds (reduced from 30s to prevent worker idling)

    // Mine addresses dynamically - refresh list before each iteration to pick up newly registered addresses
    // This ensures that as addresses finish registering in the background, they automatically become available for mining
    while (this.isRunning && this.isMining && this.currentChallengeId === currentChallengeId) {
      // OPTIMIZATION: Cache Date.now() at start of loop iteration to reduce system calls
      const now = Date.now();
      
      // CRITICAL: Check for batch size recovery periodically (not just after successful hashes)
      // This ensures recovery happens even if there are continuous timeouts
      if (this.hashServiceTimeoutCount > 0 && this.adaptiveBatchSize !== null) {
        const timeSinceLastTimeout = now - this.lastHashServiceTimeout;
        // Reset after 10 seconds of no timeouts (faster recovery - was 20 seconds)
        if (timeSinceLastTimeout > 10000) {
          const previousAdaptive = this.adaptiveBatchSize;
          this.hashServiceTimeoutCount = 0;
          const restoredBatchSize = this.getBatchSize(); // Will return customBatchSize or default
          console.log(`[Orchestrator] ✓ Hash service stabilized. Restoring batch size from ${previousAdaptive} to ${restoredBatchSize} (saved value)`);
          this.adaptiveBatchSize = null;
          
          // Emit info event to notify UI
          this.emit('error', {
            type: 'error',
            message: `Hash service recovered. Batch size restored to ${restoredBatchSize} (saved value).`,
          } as MiningEvent);
        }
      }
      
      // Dynamically get available addresses (includes newly registered ones)
      const addressesToMine = this.getAvailableAddressesForMining();

      // Filter out addresses currently being mined, but allow retries after delay
      const newAddressesToMine = addressesToMine.filter(addr => {
        // Skip if currently being mined
        if (addressesInProgress.has(addr.bech32)) {
          return false;
        }
        
        // CRITICAL FIX: Remove retry delay entirely - it's unnecessary and causes workers to sit idle
        // When an address fails after 6 attempts, it's because:
        // 1. Challenge data changed while mining (server rejects solution) - we need NEW solution with NEW data
        // 2. Network/API errors - retrying immediately won't help, need to wait for network recovery
        // 3. Solution already submitted - address is already solved, no retry needed
        // 
        // The retry delay was based on flawed logic: "wait for challenge data to update"
        // But if challenge data updated, we need to find a NEW solution, not retry the old one
        // And we already capture fresh challenge data at the START of each mining attempt (line 2580)
        // So there's no need to wait - just let addresses be retried naturally when they cycle through
        // 
        // If we want to avoid hammering a failing address, we can use a very short delay (2-5 seconds)
        // just to prevent immediate retry loops, but 30 seconds is way too long and causes worker idling
        const lastAttempt = this.lastMineAttempt.get(addr.bech32);
        if (lastAttempt) {
          // Use a minimal delay (5 seconds) just to prevent immediate retry loops
          // This is much shorter than the old 30s delay and won't cause worker idling
          const MIN_RETRY_DELAY = 5000; // 5 seconds - just enough to prevent retry loops
          if ((now - lastAttempt) < MIN_RETRY_DELAY) {
            return false;
          }
        }
        
        return true;
      });

      // OPTIMIZATION: Calculate counts once (used for logging and logic)
      const registeredCount = this.cachedRegisteredAddresses?.length ?? this.addresses.filter(a => a.registered).length;
      const addressesInProgressCount = addressesInProgress.size;
      // OPTIMIZATION: Count waiting addresses more efficiently (single pass)
      let addressesWaitingRetry = 0;
      for (let i = 0; i < addressesToMine.length; i++) {
        const addr = addressesToMine[i];
        if (!addressesInProgress.has(addr.bech32)) {
          const lastAttempt = this.lastMineAttempt.get(addr.bech32);
          if (lastAttempt && (now - lastAttempt) < MIN_RETRY_DELAY) {
            addressesWaitingRetry++;
          }
        }
      }
      
      // Emit mining state event periodically (every 10 iterations to avoid spam)
      if (Math.random() < 0.1) { // 10% chance
        const allAddressesRegistered = registeredCount >= this.addresses.length;
        const addressesSolved = this.solvedAddressChallenges.size;
        const substate = allAddressesRegistered 
          ? (this.baselineHashRate === null ? 'baseline_collection' : 'normal')
          : 'registration';
        
        this.emit('mining_state', {
          type: 'mining_state',
          state: newAddressesToMine.length > 0 ? 'mining' : (addressesInProgressCount > 0 ? 'mining' : 'idle'),
          substate,
          message: `${newAddressesToMine.length} addresses available, ${addressesInProgressCount} in progress, ${addressesWaitingRetry} waiting retry`,
          addressesAvailable: newAddressesToMine.length,
          addressesInProgress: addressesInProgressCount,
          addressesWaitingRetry,
          addressesSolved,
          challengeId: currentChallengeId,
        } as MiningEvent);
      }
      
      // OPTIMIZATION: Reduce logging frequency - only log every 10 iterations (every ~5-10 seconds)
      const shouldLogStatus = Math.random() < 0.1; // 10% chance to log (reduces overhead)
      
      if (shouldLogStatus || this.logLevel === 'debug') {
    console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
        console.log(`[Orchestrator] ║ DYNAMIC ADDRESS QUEUE (refreshed each iteration)          ║`);
    console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
        console.log(`[Orchestrator] ║ Total addresses loaded:        ${this.addresses.length.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Registered addresses:          ${registeredCount.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Available to mine:             ${addressesToMine.length.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Ready to mine now:             ${newAddressesToMine.length.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Currently mining:              ${addressesInProgressCount.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Waiting for retry:             ${addressesWaitingRetry.toString().padStart(3, ' ')}                       ║`);
        console.log(`[Orchestrator] ║ Challenge ID:                  ${currentChallengeId?.substring(0, 10)}...            ║`);
    console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);
      }

      // CRITICAL STABILITY CHECK: Detect and repair stuck addresses and workers
      // This is a major cause of hash rate drops - workers getting stuck
      const stuckAddresses: string[] = [];
      const stuckWorkers: number[] = [];
      
      for (const addressBech32 of addressesInProgress) {
        // Check if any workers are actually assigned to this address
        let hasActiveWorker = false;
        for (const [workerId, assignedAddress] of this.workerAddressAssignment.entries()) {
          if (assignedAddress === addressBech32) {
            const workerData = this.workerStats.get(workerId);
            // Worker exists and is actively mining
            if (workerData && (workerData.status === 'mining' || workerData.status === 'submitting')) {
              // CRITICAL: Check if worker is actually making progress (updated recently)
              const timeSinceUpdate = now - workerData.lastUpdateTime;
              if (timeSinceUpdate < 60000) { // Updated in last minute
                hasActiveWorker = true;
                break;
              } else {
                // Worker hasn't updated in >1 minute - it's stuck
                console.warn(`[Orchestrator] 🔧 Worker ${workerId} stuck (no update in ${Math.floor(timeSinceUpdate / 1000)}s), marking for cleanup`);
                stuckWorkers.push(workerId);
              }
            }
          }
        }
        // If no active workers found and it's been > 1 minute, it's stuck (reduced from 2 minutes for faster recovery)
        if (!hasActiveWorker) {
          const lastAttempt = this.lastMineAttempt.get(addressBech32);
          if (!lastAttempt || (now - lastAttempt) > 60 * 1000) { // Reduced from 2 minutes to 1 minute
            stuckAddresses.push(addressBech32);
          }
        }
      }
      
      // Clean up stuck addresses
      for (const addressBech32 of stuckAddresses) {
        addressesInProgress.delete(addressBech32);
        // Also clear lastMineAttempt to allow immediate retry
        this.lastMineAttempt.delete(addressBech32);
        // Clear any paused/submitting state for this address
        const pauseKey = `${addressBech32}:${currentChallengeId}`;
        this.pausedAddresses.delete(pauseKey);
        this.submittingAddresses.delete(pauseKey);
        console.log(`[Orchestrator] 🔧 Stability: Cleaned stuck address ${addressBech32.slice(0, 20)}... from in-progress`);
      }
      
      // Clean up stuck workers
      for (const workerId of stuckWorkers) {
        // Clear worker assignment and stopped status
        this.workerAddressAssignment.delete(workerId);
        this.stoppedWorkers.delete(workerId);
        // Reset worker status to idle so it can be reused
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.status = 'idle';
          workerData.lastUpdateTime = now;
        }
        console.log(`[Orchestrator] 🔧 Stability: Reset stuck worker ${workerId} to idle state`);
      }
      
      // CRITICAL: Check for workers stuck in paused state (> 60 seconds)
      for (const pauseKey of this.pausedAddresses) {
        const parts = pauseKey.split(':');
        if (parts.length >= 2) {
          const challengeIdFromKey = parts.slice(1).join(':');
          if (challengeIdFromKey === currentChallengeId) {
            const addressBech32 = parts[0];
            // Find workers assigned to this address
            for (const [workerId, assignedAddress] of this.workerAddressAssignment.entries()) {
              if (assignedAddress === addressBech32) {
                const workerData = this.workerStats.get(workerId);
                if (workerData && workerData.status === 'submitting') {
                  const timeSinceSubmission = now - workerData.lastUpdateTime;
                  if (timeSinceSubmission > 60000) { // > 60 seconds
                    console.warn(`[Orchestrator] 🔧 Worker ${workerId} stuck in submission for ${Math.floor(timeSinceSubmission / 1000)}s, clearing pause lock`);
                    this.pausedAddresses.delete(pauseKey);
                    this.submittingAddresses.delete(pauseKey);
                    workerData.status = 'mining';
                    workerData.lastUpdateTime = now;
                  }
                }
              }
            }
          }
        }
      }

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
          // CRITICAL FIX: If many addresses are waiting retry, reduce delay to keep workers busy
          // This prevents all workers from sitting idle when many addresses fail
          const waitingAddresses = Array.from(this.lastMineAttempt.entries()).filter(([_, t]: [string, number]) => (now - t) < MIN_RETRY_DELAY);
          const nextRetryIn = waitingAddresses.length > 0 
            ? Math.min(...waitingAddresses.map(([_, t]: [string, number]) => Math.max(0, MIN_RETRY_DELAY - (now - t))))
            : 0;
          
          // CRITICAL: If more than 50% of addresses are waiting retry, reduce delay to 10 seconds
          // This ensures workers stay busy even when many addresses fail
          const totalAvailable = addressesToMine.length;
          const retryRatio = totalAvailable > 0 ? addressesWaitingRetry / totalAvailable : 0;
          const effectiveRetryDelay = retryRatio > 0.5 ? 10000 : MIN_RETRY_DELAY; // 10s if >50% waiting, else 30s
          
          // Allow retries sooner if many addresses are waiting
          const addressesReadyForRetry = waitingAddresses.filter(([_, t]: [string, number]) => (now - t) >= effectiveRetryDelay);
          if (addressesReadyForRetry.length > 0) {
            // Some addresses are ready for retry - continue loop to pick them up
            console.log(`[Orchestrator] ⚡ ${addressesReadyForRetry.length} addresses ready for retry (${addressesWaitingRetry} total waiting)`);
            continue; // Don't sleep - immediately continue to pick up retry addresses
          }
          
          console.log(`[Orchestrator] ⏳ ${addressesWaitingRetry} addresses waiting for retry (next retry in ${Math.ceil(nextRetryIn / 1000)}s, ${(retryRatio * 100).toFixed(0)}% of addresses)`);
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
      
      // CRITICAL: Safety check - ensure we have addresses to process
      if (addressesToProcess.length === 0) {
        console.warn(`[Orchestrator] No addresses to process (this shouldn't happen here)`);
        await this.sleep(2000);
        continue;
      }
      
      // CRITICAL: Use 50% of workers until all addresses are registered
      // This reserves workers for registration tasks and prevents overwhelming the system during initialization
      const allAddressesRegistered = registeredCount >= this.addresses.length;
      
      // CRITICAL: After registration completes, ensure we're using the full persisted worker count from config
      // Reload config to ensure we have the latest persisted value (in case it was changed externally)
      // CRITICAL: Do NOT save the temporary 50% reduction to config - it's only for runtime use
      if (allAddressesRegistered && this.workerThreads !== ConfigManager.loadConfig().workerThreads) {
        const persistedConfig = ConfigManager.loadConfig();
        // CRITICAL: Validate and correct worker count if it exceeds maximum allowed
        const MAX_WORKERS = 1024;
        if (persistedConfig.workerThreads > MAX_WORKERS) {
          const correctedWorkerCount = Math.max(1, Math.floor(persistedConfig.workerThreads / 2));
          console.warn(`[Orchestrator] ⚠️  Worker count in config (${persistedConfig.workerThreads}) exceeds maximum (${MAX_WORKERS}). Reducing to ${correctedWorkerCount} and saving to config.`);
          this.workerThreads = correctedWorkerCount;
          ConfigManager.setWorkerThreads(correctedWorkerCount);
        } else {
          this.workerThreads = persistedConfig.workerThreads;
        }
        console.log(`[Orchestrator] ✓ All addresses registered! Restored full worker count from config: ${this.workerThreads} workers`);
      }
      
      // CRITICAL: effectiveWorkerCount is ONLY for runtime use - it is NEVER saved to config
      // The 50% reduction during registration is temporary and does not persist
      const effectiveWorkerCount = allAddressesRegistered 
        ? this.workerThreads  // Use 100% of persisted worker count from config once all addresses are registered
        : Math.max(1, Math.floor(this.workerThreads * 0.5)); // Use 50% during registration (TEMPORARY - not saved)
      
      // Log worker count adjustment
      if (!allAddressesRegistered) {
        const unregisteredCount = this.addresses.length - registeredCount;
        // Log at info level (not just debug) so user knows why performance is reduced
        console.log(`[Orchestrator] ⚙️  Registration mode: Using ${effectiveWorkerCount}/${this.workerThreads} workers (${unregisteredCount} addresses still registering)`);
      } else if (effectiveWorkerCount === this.workerThreads) {
        // Log when we switch back to full worker count (only once, not every iteration)
        // Use a flag to track if we've already logged this transition
        if (!this.hasLoggedFullWorkerRestore) {
          console.log(`[Orchestrator] ✓ Registration complete! Using full worker count: ${this.workerThreads} workers (from persisted config)`);
          this.hasLoggedFullWorkerRestore = true;
        }
      }
      
      // Launch mining for all selected addresses in parallel
      // CRITICAL: Wrap in try-finally to ensure addressesInProgress cleanup even if map() throws
      const miningPromises = addressesToProcess.map((addr, idx) => {
        // CRITICAL: Add to addressesInProgress BEFORE any async operations
        // This ensures cleanup happens in finally block of mineAddressWithWorkers
        addressesInProgress.add(addr.bech32);
        // CRITICAL FIX: Don't set lastMineAttempt here - it will be set in mineAddressWithWorkers
        // when the address fails, or deleted when it succeeds. This ensures proper timing.
        
        try {
          // Calculate worker ID range for this address
          // Optimized distribution: ensure all workers are used, no gaps
          // Distribute workers across addresses: address 0 gets workers 0-N, address 1 gets workers N+1-2N, etc.
          // CRITICAL: Use effective worker count (50% during registration, 100% when all registered)
          // CRITICAL: Never exceed the configured workerThreads - this ensures we don't create more workers than set
          const totalUserWorkers = Math.min(effectiveWorkerCount, this.workerThreads);
          
          // CRITICAL: Log worker count to verify no duplication (log for first address only)
          if (idx === 0) {
            console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
            console.log(`[Orchestrator] ║ WORKER DISTRIBUTION                                         ║`);
            console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
            console.log(`[Orchestrator] ║ Configured workers:        ${this.workerThreads.toString().padStart(4, ' ')}                                    ║`);
            console.log(`[Orchestrator] ║ Effective workers:         ${effectiveWorkerCount.toString().padStart(4, ' ')} (${allAddressesRegistered ? '100%' : '50%'})                        ║`);
            console.log(`[Orchestrator] ║ Total user workers:        ${totalUserWorkers.toString().padStart(4, ' ')}                                    ║`);
            console.log(`[Orchestrator] ║ Addresses to process:      ${addressesToProcess.length.toString().padStart(4, ' ')}                                    ║`);
            console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);
          }
          
          // CRITICAL FIX: Calculate minWorkersPerAddress based on effectiveWorkerCount, not this.workerThreads
          // This prevents trying to use more workers than available during registration mode
          // Minimum workers per address: 1 for low-end systems, scaled down proportionally for registration mode
          // Use a smaller minimum (effectiveWorkerCount / 10) to ensure we can distribute workers across all addresses
          const minWorkersPerAddress = effectiveWorkerCount >= 20 ? Math.max(1, Math.floor(effectiveWorkerCount / 10)) : 1;
          // CRITICAL: Ensure we don't divide by zero (defensive programming)
          // Calculate base workers per address, ensuring we don't exceed totalUserWorkers
          const baseWorkersPerAddress = addressesToProcess.length > 0
            ? Math.floor(totalUserWorkers / addressesToProcess.length)
            : totalUserWorkers;
          // Use the maximum of minimum and base, but cap at totalUserWorkers to prevent overflow
          const workersPerAddress = Math.min(
            Math.max(minWorkersPerAddress, baseWorkersPerAddress),
            totalUserWorkers
          );
          const workerStartId = idx * workersPerAddress;
          // Ensure last address gets all remaining workers (no waste)
          // CRITICAL: Cap workerEndId at totalUserWorkers to prevent exceeding available workers
          const workerEndId = idx === addressesToProcess.length - 1 
            ? totalUserWorkers 
            : Math.min(workerStartId + workersPerAddress, totalUserWorkers);
          
          // CRITICAL: Validate worker range is correct
          if (workerStartId < 0 || workerEndId > totalUserWorkers || workerStartId >= workerEndId) {
            console.error(`[Orchestrator] ❌ CRITICAL: Invalid worker range for address ${addr.index}: ${workerStartId}-${workerEndId} (total: ${totalUserWorkers})`);
            throw new Error(`Invalid worker range calculation: ${workerStartId}-${workerEndId} for address ${addr.index} (total workers: ${totalUserWorkers})`);
          }
          
          return this.mineAddressWithWorkers(addr, currentChallengeId, workerStartId, workerEndId, addressesInProgress);
        } catch (error) {
          // CRITICAL: If mineAddressWithWorkers throws synchronously, clean up immediately
          // (This is unlikely since it's async, but defensive programming)
          addressesInProgress.delete(addr.bech32);
          this.lastMineAttempt.delete(addr.bech32);
          throw error;
        }
      });
      
      // Wait for at least one address to finish (or all if they all fail)
      // CRITICAL FIX: Ensure timers are always cleaned up, even if Promise.allSettled resolves first
      let checkInterval: NodeJS.Timeout | null = null;
      let timeoutId: NodeJS.Timeout | null = null;
      
      try {
        await Promise.race([
          Promise.allSettled(miningPromises).finally(() => {
            // CRITICAL: Clean up timers when Promise.allSettled resolves
            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
          }),
          // Also resolve if any address is solved (to immediately pick up next address)
          new Promise<void>(resolve => {
            // OPTIMIZATION: Use event-driven approach instead of polling when possible
            // For now, use optimized polling with longer interval (reduces CPU overhead)
            // Check every 1 second instead of 500ms - solutions are rare, so this is sufficient
            checkInterval = setInterval(() => {
              // OPTIMIZATION: Use for loop instead of .some() for better performance
              let anySolved = false;
              for (let i = 0; i < addressesToProcess.length; i++) {
                const addr = addressesToProcess[i];
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
                if (solvedChallenges?.has(currentChallengeId)) {
                  anySolved = true;
                  break;
                }
              }
              if (anySolved) {
                if (checkInterval) {
                  clearInterval(checkInterval);
                  checkInterval = null;
                }
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                resolve();
              }
            }, 1000); // 1 second interval - sufficient for solution detection
            
            // Cleanup after 5 minutes max
            timeoutId = setTimeout(() => {
              if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
              }
              resolve();
            }, 300000);
          })
        ]);
      } finally {
        // CRITICAL: Always clean up timers in finally block to prevent memory leaks
        // This ensures cleanup even if an error occurs or the promise resolves unexpectedly
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
      
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
    // In parallel mode (maxConcurrentAddresses > 1), workers are assigned to specific addresses via worker ID ranges
    // In single-address mode, we check currentMiningAddress
    if (!isDevFee) {
      if (this.maxConcurrentAddresses === 1) {
        // Single address mode: check currentMiningAddress
        if (this.currentMiningAddress !== addr.bech32) {
      console.log(`[Orchestrator] Worker ${workerId}: Skipping address ${addr.index} - not current mining address`);
          // CRITICAL: Clear worker state so it can be reused (thread-safe)
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          // CRITICAL: Update worker stats to idle and mark as available for reuse
          const workerData = this.workerStats.get(workerId);
          const now = Date.now();
          if (workerData) {
            workerData.status = 'idle';
            workerData.lastUpdateTime = now;
            workerData.addressIndex = -1;
            workerData.address = '';
          }
      return;
        }
      } else {
        // Parallel mode: check worker assignment
        // CRITICAL FIX: Thread-safe worker assignment check
        const assignedAddress = this.getWorkerAssignment(workerId);
        if (assignedAddress && assignedAddress !== addr.bech32) {
          console.log(`[Orchestrator] Worker ${workerId}: Skipping address ${addr.index} - assigned to different address (${assignedAddress.slice(0, 20)}...)`);
          return;
        }
        // CRITICAL FIX: Thread-safe worker assignment with lock
        // Use helper method for thread-safe assignment
        if (!assignedAddress) {
          const assigned = await this.setWorkerAssignment(workerId, addr.bech32);
          if (!assigned) {
            // Already assigned to different address
            console.log(`[Orchestrator] Worker ${workerId}: Already assigned to different address, skipping`);
            return;
          }
        }
      }
    }

    // Capture challenge details at START to prevent race conditions
    // OPTIMIZATION: Use shallow copy instead of expensive JSON.parse(JSON.stringify())
    // We only need to capture the values, not deep clone the entire object
    // The challenge object structure is simple (strings/numbers), so shallow copy is sufficient
    const challengeId = this.currentChallengeId;
    if (!this.currentChallenge) return;
    
    // Shallow copy challenge object (much faster than JSON.parse/stringify)
    const challenge = {
      challenge_id: this.currentChallenge.challenge_id,
      difficulty: this.currentChallenge.difficulty,
      no_pre_mine: this.currentChallenge.no_pre_mine,
      latest_submission: this.currentChallenge.latest_submission,
      no_pre_mine_hour: this.currentChallenge.no_pre_mine_hour,
    };
    const difficulty = challenge.difficulty;
    
    // OPTIMIZATION: Pre-calculate difficulty parameters once per challenge (cached for performance)
    // This avoids recalculating zero bits and mask for every hash check
    const difficultyMask = parseInt(difficulty.slice(0, 8), 16) >>> 0;
    const cachedRequiredZeroBits = getDifficultyZeroBits(difficulty);
    const fullZeroBytes = Math.floor(cachedRequiredZeroBits / 8);
    const remainingZeroBits = cachedRequiredZeroBits % 8;
    const remainingBitsMask = remainingZeroBits > 0 ? (0xFF << (8 - remainingZeroBits)) : 0;

    // ROM should already be ready from pollAndMine - quick check only
    if (!hashEngine.isRomReady()) {
      console.error(`[Orchestrator] ROM not ready for address ${addr.index}`);
      // CRITICAL: Clear worker state so it can be reused
      this.workerAddressAssignment.delete(workerId);
      this.stoppedWorkers.delete(workerId);
      // CRITICAL: Update worker stats to idle and mark as available for reuse
      const workerData = this.workerStats.get(workerId);
      const now = Date.now();
      if (workerData) {
        workerData.status = 'idle';
        workerData.lastUpdateTime = now;
        workerData.addressIndex = -1;
        workerData.address = '';
      }
      return;
    }

    // Mark this address as having processed the current challenge
    this.addressesProcessedCurrentChallenge.add(addr.index);

    // CRITICAL: Initialize or update worker stats
    // If worker stats already exist (from previous address), reuse them but preserve cumulative hashes
    // Only reset per-address tracking (addressIndex, address, startTime for this address)
    // This ensures workers are immediately available for new addresses while preserving total work done
    const workerStartTime = Date.now();
    const existingWorkerData = this.workerStats.get(workerId);
    if (existingWorkerData) {
      // CRITICAL: Preserve cumulative hashesComputed across address changes
      // Only reset per-address tracking fields
      const preservedHashesComputed = existingWorkerData.hashesComputed; // Preserve cumulative hashes
      const preservedHashRate = existingWorkerData.hashRate; // Preserve hash rate for smooth transitions
      existingWorkerData.addressIndex = addr.index;
      existingWorkerData.address = addr.bech32;
      existingWorkerData.hashesComputed = preservedHashesComputed; // Keep cumulative hashes
      existingWorkerData.hashRate = preservedHashRate; // Keep hash rate
      // Don't reset solutionsFound - it's cumulative across all addresses
      existingWorkerData.startTime = workerStartTime; // New start time for this address
      existingWorkerData.lastUpdateTime = workerStartTime;
      existingWorkerData.status = 'mining';
      existingWorkerData.currentChallenge = challengeId;
      // BUG FIX: Reset hash accumulator for new address to prevent incorrect hash rate calculations
      this.workerHashesSinceLastUpdate.set(workerId, 0);
    } else {
      // Create new worker stats if they don't exist
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
      // BUG FIX: Initialize hash accumulator for new worker
      this.workerHashesSinceLastUpdate.set(workerId, 0);
    }

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
    // EXTREME OPTIMIZATION: Emit progress every 100 batches (20x reduction)
    // User wants maximum tick speed - minimize event emissions
    const PROGRESS_INTERVAL = 100; // Emit progress every 100 batches for updates
    let hashCount = 0;
    let batchCounter = 0;
    let lastProgressTime = Date.now();

    // OPTIMIZATION: Pre-calculate pause/submission key once (used multiple times in loop)
    const pauseKey = `${addr.bech32}:${challengeId}`;

    // Sequential nonce range for this worker (like midnight-scavenger-bot)
    // CRITICAL FIX: Use wrap-around nonce range to prevent exhaustion
    // Workers will cycle through their nonce space indefinitely
    const NONCE_RANGE_SIZE = 1_000_000_000; // 1 billion per worker
    const nonceStart = workerId * NONCE_RANGE_SIZE;
    const nonceEnd = nonceStart + NONCE_RANGE_SIZE;
    let currentNonce = nonceStart;
    // Track if we've wrapped around (for logging)
    let nonceWraps = 0;

    // Mine continuously with sequential nonces using BATCH processing
    // CRITICAL: Loop indefinitely - wrap around nonce range when exhausted
    while (this.isRunning && this.isMining && this.currentChallengeId === challengeId) {
      // Check if we're still mining the correct address
      // For parallel address mining (maxConcurrentAddresses > 1), workers are assigned to specific addresses
      // In that case, we don't check currentMiningAddress since multiple addresses can be active
      if (!isDevFee && this.maxConcurrentAddresses === 1 && this.currentMiningAddress !== addr.bech32) {
        console.log(`[Orchestrator] Worker ${workerId}: Current address changed (was ${addr.index}), stopping`);
        return;
      }

      // OPTIMIZATION: Use pre-calculated pauseKey (same as submissionKey)
      // Check if max submission failures reached for this address
      const failureCount = this.addressSubmissionFailures.get(pauseKey) || 0;
      if (failureCount >= maxFailures) {
        console.log(`[Orchestrator] Worker ${workerId}: Max failures (${maxFailures}) reached for address ${addr.index}, stopping`);
        // CRITICAL: Clear worker state so it can be reused immediately (thread-safe)
        this.deleteWorkerAssignment(workerId);
        this.stoppedWorkers.delete(workerId);
        // CRITICAL: Update worker stats to idle and mark as available for reuse
        // Don't delete worker stats - they need to be reusable!
        const workerData = this.workerStats.get(workerId);
        const now = Date.now();
        if (workerData) {
          workerData.status = 'idle';
          workerData.lastUpdateTime = now; // Update timestamp
          workerData.addressIndex = -1; // Mark as unassigned
          workerData.address = ''; // Clear address
        } else {
          // Create worker stats if they don't exist (shouldn't happen, but defensive)
          this.workerStats.set(workerId, {
            workerId,
            addressIndex: -1,
            address: '',
            hashesComputed: 0,
            hashRate: 0,
            solutionsFound: 0,
            startTime: now,
            lastUpdateTime: now,
            status: 'idle',
            currentChallenge: challengeId,
          });
        }
        return;
      }

      // Check if address is already solved
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      if (solvedChallenges?.has(challengeId)) {
        console.log(`[Orchestrator] Worker ${workerId}: Address ${addr.index} already solved, stopping`);
        // CRITICAL: Clear worker state so it can be reused immediately (thread-safe)
        this.deleteWorkerAssignment(workerId);
        this.stoppedWorkers.delete(workerId);
        // CRITICAL: Update worker stats to idle and mark as available for reuse
        const workerData = this.workerStats.get(workerId);
        const now = Date.now();
        if (workerData) {
          workerData.status = 'idle';
          workerData.lastUpdateTime = now;
          workerData.addressIndex = -1; // Mark as unassigned
          workerData.address = ''; // Clear address
        }
        return;
      }

      // Check if this worker should stop immediately (another worker found solution)
      // CRITICAL FIX: Only stop if we're in the correct address assignment
      // For parallel mode, only stop if we're assigned to the same address that found a solution
      // CRITICAL FIX: Thread-safe check for worker assignment
      const shouldStop = this.stoppedWorkers.has(workerId) && (
        this.maxConcurrentAddresses === 1 || 
        this.getWorkerAssignment(workerId) === addr.bech32
      );
      
      if (shouldStop) {
        console.log(`[Orchestrator] Worker ${workerId}: Stopped by solution from another worker`);
        // CRITICAL: Clear worker state so it can be reused immediately (thread-safe)
        this.deleteWorkerAssignment(workerId);
        this.stoppedWorkers.delete(workerId);
        // CRITICAL: Update worker status to idle and mark as available for reuse
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.status = 'idle';
          workerData.lastUpdateTime = Date.now();
          workerData.addressIndex = -1; // Mark as unassigned
          workerData.address = ''; // Clear address
          // Emit final worker update
          this.emit('worker_update', {
            type: 'worker_update',
            workerId,
            addressIndex: -1,
            address: '',
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
      // OPTIMIZATION: pauseKey is pre-calculated above to avoid repeated string concatenation
      // OPTIMIZATION: Cache workerData to avoid repeated Map lookups
      // CRITICAL FIX: Add timeout and max iterations to prevent workers from being stuck in paused state forever
      if (this.pausedAddresses.has(pauseKey)) {
        const workerData = this.workerStats.get(workerId);
        let shouldContinue = true;
        
        // Check if we've been paused for too long (> 60 seconds) - indicates stuck submission
        if (workerData && workerData.status === 'submitting') {
          const timeSinceSubmissionStart = Date.now() - workerData.lastUpdateTime;
          if (timeSinceSubmissionStart > 60000) { // 60 seconds
            console.warn(`[Orchestrator] Worker ${workerId}: Stuck in paused state for >60s, clearing pause lock`);
            this.pausedAddresses.delete(pauseKey);
            this.submittingAddresses.delete(pauseKey);
            // Reset worker status
            workerData.status = 'mining';
            workerData.lastUpdateTime = Date.now();
            shouldContinue = false; // Don't wait, continue mining
          }
        }
        
        // CRITICAL: Add max pause time check to prevent infinite loop
        // Track total pause time across iterations to prevent infinite waiting
        const pausedStartTime = (workerData as any)?.pausedStartTime || Date.now();
        if (!(workerData as any)?.pausedStartTime && workerData) {
          (workerData as any).pausedStartTime = Date.now();
        }
        const totalPausedTime = Date.now() - pausedStartTime;
        if (totalPausedTime > 120000) { // 2 minutes total
          console.warn(`[Orchestrator] Worker ${workerId}: Force clearing pause lock after ${Math.floor(totalPausedTime / 1000)}s`);
          this.pausedAddresses.delete(pauseKey);
          this.submittingAddresses.delete(pauseKey);
          if (workerData) {
            workerData.status = 'mining';
            workerData.lastUpdateTime = Date.now();
            delete (workerData as any).pausedStartTime;
          }
          shouldContinue = false; // Don't wait, continue mining
        }
        
        if (shouldContinue) {
          // Reduced wait time for faster response (was 100ms, now 50ms)
          await this.sleep(50);
        continue;
        }
        // If we cleared the pause lock, continue to mining (don't wait)
      } else {
        // OPTIMIZATION: Only get workerData if we need to clear pausedStartTime
        // Most of the time this branch won't need workerData, so we can avoid the lookup
        // But we still need to check if pausedStartTime exists, so we do need the lookup
        const workerData = this.workerStats.get(workerId);
        if (workerData && (workerData as any)?.pausedStartTime) {
          delete (workerData as any).pausedStartTime;
        }
      }

      batchCounter++;

      // Generate batch of sequential nonces and preimages (like midnight-scavenger-bot)
      // Optimized: Pre-allocate array size for better performance
      // CRITICAL FIX: Handle nonce range wrap-around to prevent exhaustion
      let batchSize = Math.min(BATCH_SIZE, nonceEnd - currentNonce);
      // If we've exhausted the range, wrap around to start
      // EXTREME OPTIMIZATION: No logging in hot path
      if (batchSize === 0 || currentNonce >= nonceEnd) {
        currentNonce = nonceStart;
        batchSize = Math.min(BATCH_SIZE, nonceEnd - currentNonce);
      }
      const batchData: Array<{ nonce: string; preimage: string }> = new Array(batchSize);
      
      // OPTIMIZATION: Cache static preimage suffix per address+challenge to avoid repeated string operations
      const preimageCacheKey = `${addr.bech32}:${challengeId}`;
      let staticPreimageSuffix = this.staticPreimageCache.get(preimageCacheKey);
      if (!staticPreimageSuffix) {
        // Build static parts only once per address+challenge combination
        const addressPart = addr.bech32;
        const challengeIdPart = challenge.challenge_id.startsWith('**') ? challenge.challenge_id : `**${challenge.challenge_id}`;
        const staticPreimageParts = [
          addressPart,
          challengeIdPart,
          challenge.difficulty,
          challenge.no_pre_mine,
          challenge.latest_submission,
          challenge.no_pre_mine_hour
        ];
        staticPreimageSuffix = staticPreimageParts.join('');
        this.staticPreimageCache.set(preimageCacheKey, staticPreimageSuffix);
      }
      
      let actualBatchSize = batchSize;
        for (let i = 0; i < batchSize; i++) {
        // EXTREME OPTIMIZATION: Check only every 5000 iterations to maximize tick speed
        // User wants 100x improvement - reduce all overhead to absolute minimum
        if (i % 5000 === 0) {
          // Fast path: check most likely conditions first (no logging in hot path)
          if (this.stoppedWorkers.has(workerId)) {
            actualBatchSize = i;
            break;
          }
          if (this.currentChallengeId !== challengeId) {
            actualBatchSize = i;
            break;
          }
          if (!this.isRunning || !this.isMining) {
            actualBatchSize = i;
            break;
          }
          if (this.pausedAddresses.has(pauseKey)) {
            actualBatchSize = i;
            break;
          }
        }

        // CRITICAL FIX: Handle nonce range wrap-around within batch
        let nonceNum = currentNonce + i;
        if (nonceNum >= nonceEnd) {
          // Wrap around to start of range
          nonceNum = nonceStart + (nonceNum - nonceEnd);
        }
        // EXTREME OPTIMIZATION: Fast hex conversion using lookup table
        // Convert 64-bit number to 16 hex chars using byte-by-byte lookup
        // String concatenation is faster than array join for small fixed-size strings in modern engines
        let nonceHex = '';
        for (let byteIdx = 7; byteIdx >= 0; byteIdx--) {
          const byte = (nonceNum >>> (byteIdx * 8)) & 0xFF;
          nonceHex += this.hexLookup[byte];
        }
        // Optimized: Build preimage using string concatenation (faster than array join for single concatenation)
        const preimage = nonceHex + staticPreimageSuffix;

        batchData[i] = { nonce: nonceHex, preimage };
      }
      
      // OPTIMIZATION: Trim array to actual size if we broke early (fixed bug)
      if (actualBatchSize < batchSize) {
        batchData.length = actualBatchSize;
      }

      // Advance nonce counter for next batch
      // CRITICAL FIX: Handle wrap-around when advancing nonce
      currentNonce += batchData.length;
      if (currentNonce >= nonceEnd) {
        // Wrap around to start of range
        currentNonce = nonceStart + (currentNonce - nonceEnd);
      }

      if (batchData.length === 0) break;

      try {
        // Send entire batch to Rust service for PARALLEL processing
        // OPTIMIZATION: Build preimages array directly (faster than map for large arrays)
        // OPTIMIZATION: Pre-allocate exact size to avoid resizing
        const preimages = new Array<string>(batchData.length);
        for (let i = 0; i < batchData.length; i++) {
          preimages[i] = batchData[i].preimage;
        }
        
        // NEW: Track performance more frequently for real-time adaptive sizing (every 100 batches for adaptive, every 1000 for historical)
        const shouldTrackAdaptive = batchCounter % 100 === 0; // More frequent for real-time adaptation
        const shouldTrackHistorical = batchCounter % 1000 === 0; // Less frequent for historical analysis
        const batchStartTime = (shouldTrackAdaptive || shouldTrackHistorical) ? Date.now() : 0;
        const hashes = await hashEngine.hashBatchAsync(preimages);
        const batchProcessingTime = (shouldTrackAdaptive || shouldTrackHistorical) ? Date.now() - batchStartTime : 0;
        
        // NEW: Record real-time metrics for adaptive batch sizing (more frequent)
        if (shouldTrackAdaptive && this.isRunning && this.isMining && batchData.length > 0 && batchProcessingTime > 0) {
          const throughput = (batchData.length / batchProcessingTime) * 1000; // Hashes per second for this batch
          this.recentBatchMetrics.push({
            batchSize: batchData.length,
            processingTime: batchProcessingTime,
            timestamp: Date.now(),
            throughput: throughput,
          });
          
          // Keep only last 200 samples (last ~20 seconds at 100 batches per sample)
          if (this.recentBatchMetrics.length > 200) {
            this.recentBatchMetrics = this.recentBatchMetrics.slice(-200);
          }
        }
        
        // Record batch performance for historical analysis (less frequent)
        if (shouldTrackHistorical && this.isRunning && this.isMining && batchData.length > 0) {
          const currentHashRate = this.getCurrentHashRate();
          if (currentHashRate > 0) {
            this.batchPerformanceHistory.push({
              batchSize: batchData.length,
              processingTime: batchProcessingTime,
              timestamp: Date.now(),
              hashRate: currentHashRate,
            });
            
            // Keep only last 1000 samples to prevent memory growth
            if (this.batchPerformanceHistory.length > 1000) {
              this.batchPerformanceHistory = this.batchPerformanceHistory.slice(-1000);
            }
          }
        }

        // CRITICAL: Check if challenge changed while we were computing hashes
        // EXTREME OPTIMIZATION: No logging in hot path
        if (this.currentChallengeId !== challengeId) {
          // CRITICAL: Clear failure counter for old challenge to allow immediate retry on new challenge
          const oldSubmissionKey = `${addr.bech32}:${challengeId}`;
          this.addressSubmissionFailures.delete(oldSubmissionKey);
          // CRITICAL: Clear worker state so it can be reused for new challenge
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          const workerData = this.workerStats.get(workerId);
          if (workerData) {
            workerData.status = 'idle';
          }
          return; // Stop mining for this address, new challenge will restart
        }

        // CRITICAL: Atomic hash counting to prevent race conditions
        // Update both total system hashes and worker-specific hashes atomically
        const hashesInBatch = hashes.length;
        this.totalHashesComputed += hashesInBatch;
        hashCount += hashesInBatch;

        // EXTREME OPTIMIZATION: Update worker stats extremely infrequently for maximum tick speed
        // OPTIMIZATION: Cache workerData to avoid repeated Map lookups (cache once per batch)
        // CRITICAL: Cache workerData at start of batch processing to avoid repeated lookups
        let workerData = this.workerStats.get(workerId);
        if (workerData) {
          // EXTREME: Only check assignment every 1000 batches (assignment rarely changes)
          if (batchCounter % 1000 === 0) {
            const assignedAddress = this.getWorkerAssignment(workerId);
            if (assignedAddress !== addr.bech32) {
              // Worker was reassigned - no logging in hot path
              continue; // Skip this batch
            }
            // Refresh workerData cache after assignment check (in case it changed)
            workerData = this.workerStats.get(workerId);
          }
          
          // BUG FIX: Always accumulate hashes, but only calculate hash rate periodically
          // This fixes the issue where hashes weren't being counted correctly
          if (workerData) {
            workerData.hashesComputed += hashesInBatch;
          }
          
          // EXTREME: Update stats only every 100 batches (20x reduction)
          if (batchCounter % 100 === 0) {
            const now = Date.now();
            if (workerData) {
              workerData.lastUpdateTime = now;
              
              // Update hash rate every 100 batches (20x reduction from before)
              const lastUpdateTime = workerData.lastHashRateUpdateTime || workerData.startTime;
              const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
              if (timeSinceLastUpdate > 0) {
                // BUG FIX: Use accumulated hashes correctly - they're already accumulated in the else branch
                const accumulatedHashes = this.workerHashesSinceLastUpdate.get(workerId) || 0;
                const instantaneousHashRate = accumulatedHashes / timeSinceLastUpdate;
                const alpha = 0.3;
                if (workerData.hashRate === 0) {
                  workerData.hashRate = instantaneousHashRate;
                } else {
                  workerData.hashRate = alpha * instantaneousHashRate + (1 - alpha) * workerData.hashRate;
                }
                workerData.lastHashRateUpdateTime = now;
                this.workerHashesSinceLastUpdate.set(workerId, 0);
              }
            }
          } else {
            // Accumulate hashes for next hash rate calculation (no Date.now() call)
            const currentAccumulated = this.workerHashesSinceLastUpdate.get(workerId) || 0;
            this.workerHashesSinceLastUpdate.set(workerId, currentAccumulated + hashesInBatch);
          }
        }

        // EXTREME OPTIMIZATION: Remove all debug logging from hot path
        // User wants maximum performance - no logging overhead

        // Check all hashes for solutions (early exit optimization: stop checking once we find a solution)
        // OPTIMIZATION: Use cached difficulty parameters for faster inline checking (avoids function call overhead)
        let solutionFound = false;
        for (let i = 0; i < hashes.length && !solutionFound; i++) {
          const hash = hashes[i];
          const { nonce, preimage } = batchData[i];

          // OPTIMIZED: Fast inline difficulty check using pre-calculated parameters
          // This is faster than calling matchesDifficulty() for every hash
          // EXTREME OPTIMIZATION: Cache hash prefix substring to avoid repeated substring calls
          // OPTIMIZATION: parseInt is optimized for hex parsing in modern engines
          const hashPrefix = hash.substring(0, 8);
          const hashPrefixBE = parseInt(hashPrefix, 16) >>> 0;
          
          // Fast check 1: ShadowHarvester (most restrictive, check first - fastest rejection)
          const shadowHarvesterPass = ((hashPrefixBE | difficultyMask) >>> 0) === difficultyMask;
          if (!shadowHarvesterPass) continue;
          
          // Fast check 2: Heist Engine (zero bits) - only check if ShadowHarvester passed
          // CRITICAL OPTIMIZATION: Pre-compute zero check string for faster comparison
          // EXTREME OPTIMIZATION: Reuse hashPrefix for zero byte checking when possible
          let heistEnginePass = true;
          if (fullZeroBytes > 0) {
            // OPTIMIZATION: Use direct string comparison with pre-computed zero string
            // This is faster than character-by-character checking
            // EXTREME OPTIMIZATION: For 1-2 zero bytes, check hashPrefix directly (already extracted)
            if (fullZeroBytes <= 2) {
              // Fast path for 1-2 zero bytes (most common) - reuse hashPrefix
              if (fullZeroBytes === 1) {
                heistEnginePass = hashPrefix.substring(0, 2) === '00';
              } else {
                heistEnginePass = hashPrefix === '00000000' || hashPrefix.substring(0, 4) === '0000';
              }
            } else {
              // Slower path for >2 zero bytes - check character by character
              // OPTIMIZATION: Use hashPrefix when possible, fall back to full hash
              const zeroCheckLength = fullZeroBytes * 2;
              const checkString = zeroCheckLength <= 8 ? hashPrefix : hash;
              const maxCheck = Math.min(zeroCheckLength, checkString.length);
              for (let j = 0; j < maxCheck; j += 2) {
                if (checkString.substring(j, j + 2) !== '00') {
                  heistEnginePass = false;
                  break;
                }
              }
            }
          }
          if (heistEnginePass && remainingZeroBits > 0 && fullZeroBytes * 2 < hash.length) {
            // OPTIMIZATION: Use substring instead of slice, cache the position
            // OPTIMIZATION: Use hexByteLookup instead of parseInt for faster conversion
            // EXTREME OPTIMIZATION: Reuse hashPrefix if bytePos is within it (0-8 chars)
            const bytePos = fullZeroBytes * 2;
            const byteHex = bytePos < 8 ? hashPrefix.substring(bytePos, bytePos + 2) : hash.substring(bytePos, bytePos + 2);
            const byte = this.hexByteLookup.get(byteHex) ?? parseInt(byteHex, 16);
            heistEnginePass = (byte & remainingBitsMask) === 0;
          }
          
          // Both checks must pass (same as matchesDifficulty)
          // EXTREME OPTIMIZATION: Remove reference check - inline check is fast and accurate
          // User wants maximum performance - no double-checking overhead
          if (heistEnginePass && shadowHarvesterPass) {
            // OPTIMIZATION: Check if we already submitted this exact hash (bounded Set with auto-cleanup)
            // EXTREME: No logging in hot path
            if (this.submittedSolutions.has(hash)) {
              // CRITICAL FIX: Don't reset solutionFound - continue checking for other solutions
              // We found a valid solution but it's a duplicate, so keep looking
              continue;
            }
            
            // CRITICAL: Mark solution found BEFORE any other checks
            // This ensures we don't miss solutions due to race conditions
            solutionFound = true;

            // EXTREME OPTIMIZATION: No size check logging in hot path
            // Cleanup happens in background stability check
            
            // solutionFound is already set to true above - no need to set again

            // CRITICAL FIX: Use atomic check-and-set to prevent race condition
            // OPTIMIZATION: Set.add() returns the Set, so we can check if it was already present
            // This is more efficient than checking size before and after
            const wasAlreadySubmitting = this.submittingAddresses.has(pauseKey);
            if (!wasAlreadySubmitting) {
              this.submittingAddresses.add(pauseKey);
            }
            
            if (wasAlreadySubmitting) {
              if (this.logLevel === 'debug') {
                console.log(`[Orchestrator] Worker ${workerId}: Another worker is already submitting for this address, stopping this worker`);
              }
              // CRITICAL: Clear worker state so it can be reused for another address
              this.deleteWorkerAssignment(workerId);
              this.stoppedWorkers.delete(workerId);
              const workerData = this.workerStats.get(workerId);
              if (workerData) {
                workerData.status = 'idle';
              }
              return; // Exit this worker - another worker is handling submission
            }

            // CRITICAL: Atomically add to pausedAddresses (already added to submittingAddresses above)
            // This prevents other workers from proceeding while we submit
            this.pausedAddresses.add(pauseKey);
            
            // OPTIMIZATION: Add to submittedSolutions BEFORE submission to prevent race conditions
            // This prevents other workers from trying to submit the same hash
            this.submittedSolutions.add(hash);

            // IMMEDIATELY stop all other workers MINING THE SAME ADDRESS to save CPU
            // In parallel mode, only stop workers assigned to this same address
            // In single-address mode, stop all workers in the appropriate range
            const userWorkerCount = Math.floor(this.workerThreads * 0.8);

            if (this.maxConcurrentAddresses > 1) {
              // Parallel mode: Only stop workers assigned to this same address
              // EXTREME OPTIMIZATION: Use reverse map for O(1) worker lookup instead of O(n) iteration
              const workersForAddress = this.addressToWorkers.get(addr.bech32);
              if (workersForAddress) {
                workersForAddress.forEach(assignedWorkerId => {
                  if (assignedWorkerId !== workerId) {
                    this.stoppedWorkers.add(assignedWorkerId);
                  }
                });
              }
            } else {
              // Single-address mode: Stop all workers in appropriate range
            if (isDevFee) {
              // Stop other dev fee workers (IDs >= userWorkerCount)
              // EXTREME OPTIMIZATION: No logging in hot path
              for (let i = userWorkerCount; i < this.workerThreads; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                }
              }
            } else {
              // Stop other user workers (IDs < userWorkerCount)
              // EXTREME OPTIMIZATION: No logging in hot path
              for (let i = 0; i < userWorkerCount; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                  }
                }
              }
            }

            // PAUSE all workers for this address while we submit
            // OPTIMIZATION: Use pre-calculated pauseKey
            // NOTE: pausedAddresses is already added above to prevent race conditions
            // EXTREME OPTIMIZATION: Minimal logging - only emit event for UI

            // Update worker status to submitting
            const workerData = this.workerStats.get(workerId);
            if (workerData) {
              workerData.status = 'submitting';
              workerData.solutionsFound++;
            }

            // EXTREME OPTIMIZATION: No logging in hot path
            // User wants maximum performance - all logging removed

            // Hash is already added to submittedSolutions above (line 1780) to prevent race conditions
            // No need to add again here

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
            // EXTREME OPTIMIZATION: No logging in hot path
            if (this.currentChallengeId !== challengeId) {
              // OPTIMIZATION: Use pre-calculated pauseKey
              this.pausedAddresses.delete(pauseKey);
              this.submittingAddresses.delete(pauseKey);
              return; // Don't submit solution for old challenge
            }

            // OPTIMIZATION: Only log validation details in debug mode (expensive operation)
            if (this.logLevel === 'debug') {
            console.log(`[Orchestrator] Worker ${workerId}: Captured challenge data during mining:`);
            console.log(`[Orchestrator]   latest_submission: ${challenge.latest_submission}`);
            console.log(`[Orchestrator]   no_pre_mine_hour: ${challenge.no_pre_mine_hour}`);
            console.log(`[Orchestrator]   difficulty: ${challenge.difficulty}`);
            }

            // CRITICAL VALIDATION: Verify the server will compute the SAME hash we did
            // Server rebuilds preimage from nonce using ITS challenge data, then validates
            // If server's challenge data differs from ours, it computes a DIFFERENT hash!
            // OPTIMIZATION: Only validate if challenge data actually changed (expensive operation)
            const shouldValidate = challenge.latest_submission !== this.currentChallenge?.latest_submission ||
                                   challenge.no_pre_mine_hour !== this.currentChallenge?.no_pre_mine_hour ||
                                   challenge.no_pre_mine !== this.currentChallenge?.no_pre_mine;
            
            if (shouldValidate && this.logLevel === 'debug') {
            console.log(`[Orchestrator] Worker ${workerId}: Validating solution will pass server checks...`);
            }

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
                  // OPTIMIZATION: Use pre-calculated pauseKey
                  this.pausedAddresses.delete(pauseKey);
                  this.submittingAddresses.delete(pauseKey);
                  this.submittedSolutions.delete(hash); // Remove from submitted since we're not submitting
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
            if (this.logLevel === 'debug') {
            console.log(`[Orchestrator] Worker ${workerId}: Submitting solution to API...`);
            }

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
                // OPTIMIZATION: Use pre-calculated pauseKey
                this.pausedAddresses.delete(pauseKey);
                this.submittingAddresses.delete(pauseKey);
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
            // CRITICAL: Add timeout wrapper to prevent submissions from hanging forever
            let submissionSuccess = false;
            let submissionTimedOut = false;
            let timeoutId: NodeJS.Timeout | null = null;
            try {
              // Wrap submission in a timeout to prevent hanging (30 second max)
              // CRITICAL FIX: Store timeout ID so we can clear it if submission succeeds
              const submissionPromise = this.submitSolution(addr, challengeId, nonce, hash, preimage, isDevFee, workerId);
              const timeoutPromise = new Promise<void>((_, reject) => {
                timeoutId = setTimeout(() => {
                  timeoutId = null; // Clear reference when fired
                  reject(new Error('Submission timeout after 30 seconds'));
                }, 30000);
              });
              
              // Race between submission and timeout
              await Promise.race([submissionPromise, timeoutPromise]);
              
              // CRITICAL: Clear timeout if submission succeeded (prevents timeout from firing after success)
              if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }

              // Mark as solved ONLY after successful submission (no exception thrown)
              if (!this.solvedAddressChallenges.has(addr.bech32)) {
                this.solvedAddressChallenges.set(addr.bech32, new Set());
              }
              this.solvedAddressChallenges.get(addr.bech32)!.add(challengeId);
              console.log(`[Orchestrator] Worker ${workerId}: Marked address ${addr.index} as solved for challenge ${challengeId.slice(0, 8)}...`);

              // Set success flag AFTER marking as solved - this ensures we only reach here if no exception was thrown
              submissionSuccess = true;
            } catch (error: any) {
              // Check if this was a timeout
              if (error?.message?.includes('timeout')) {
                submissionTimedOut = true;
                console.error(`[Orchestrator] Worker ${workerId}: Submission timed out after 30 seconds - treating as failure`);
              }
              
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
                // CRITICAL FIX: Don't increment failure counter for duplicate/conflict errors
                // These are treated as success, not failure
              } else {
              const errorMsg = error?.response?.data?.message || error?.message || 'Unknown error';
              const statusCode = error?.response?.status;
              console.error(`[Orchestrator] Worker ${workerId}: Submission failed:`, errorMsg);
              console.error(`[Orchestrator]   Status: ${statusCode || 'N/A'}, Address: ${addr.index}`);
              submissionSuccess = false;

                // Only increment failure counter for actual failures (not duplicates)
                // OPTIMIZATION: Use pre-calculated pauseKey
                const currentFailures = this.addressSubmissionFailures.get(pauseKey) || 0;
                this.addressSubmissionFailures.set(pauseKey, currentFailures + 1);
              console.log(`[Orchestrator] Worker ${workerId}: Submission failure ${currentFailures + 1}/${maxFailures} for address ${addr.index}`);
              
              // CRITICAL: If challenge data might be stale, suggest refreshing
              // Check if the challenge we're submitting for differs from current challenge
              if (this.currentChallengeId !== challengeId) {
                console.log(`[Orchestrator] Worker ${workerId}: ⚠️  Challenge changed during mining - solution may be invalid`);
              } else if (this.currentChallenge && (
                challenge.latest_submission !== this.currentChallenge.latest_submission ||
                challenge.no_pre_mine_hour !== this.currentChallenge.no_pre_mine_hour
              )) {
                console.log(`[Orchestrator] Worker ${workerId}: ⚠️  Challenge data changed - will refresh on next retry`);
              }
              }
            } finally {
              // CRITICAL: Always clear timeout to prevent memory leak
              if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              
              // CRITICAL: Always remove submission lock, even if there was an exception or timeout
              // This ensures addresses don't get stuck in submitting state
              // OPTIMIZATION: Use pre-calculated pauseKey
              this.submittingAddresses.delete(pauseKey);
              
              // If submission timed out, also clear paused state to allow retry
              if (submissionTimedOut) {
                this.pausedAddresses.delete(pauseKey);
                this.submittedSolutions.delete(hash); // Remove so we can try again
                // Increment failure counter for timeout
                const currentFailures = this.addressSubmissionFailures.get(pauseKey) || 0;
                this.addressSubmissionFailures.set(pauseKey, currentFailures + 1);
                console.log(`[Orchestrator] Worker ${workerId}: Submission timeout failure ${currentFailures + 1}/${maxFailures} for address ${addr.index}`);
              }

              // If submission succeeded, keep paused (will exit via return below)
              // If submission failed, resume workers to retry
              if (!submissionSuccess) {
                console.log(`[Orchestrator] Worker ${workerId}: Resuming all workers to find new solution for this address`);
                this.pausedAddresses.delete(pauseKey);
                // Remove from submitted solutions so we can try again with a different nonce
                this.submittedSolutions.delete(hash);
                // Resume stopped workers for THIS ADDRESS ONLY (not all workers)
                // In parallel mode, only clear workers assigned to this address
                if (this.maxConcurrentAddresses > 1) {
                  for (const [assignedWorkerId, assignedAddress] of this.workerAddressAssignment.entries()) {
                    if (assignedAddress === addr.bech32) {
                      this.stoppedWorkers.delete(assignedWorkerId);
                    }
                  }
                } else {
                  // Single-address mode: clear all stopped workers (they're all for this address)
                this.stoppedWorkers.clear();
                }
                // Don't return - continue mining
                continue;
              } else {
                // Submission succeeded - stop all workers for this address
                // OPTIMIZATION: Use pre-calculated pauseKey
                this.pausedAddresses.delete(pauseKey);
                // Clear failure counter on success
                this.addressSubmissionFailures.delete(pauseKey);
              }
            }

            // Update worker status to completed
            const finalWorkerData = this.workerStats.get(workerId);
            if (finalWorkerData) {
              finalWorkerData.status = 'completed';
            }

            // Clear stopped workers for this address (they're done)
            // In parallel mode, only clear workers assigned to this address
            if (this.maxConcurrentAddresses > 1) {
              for (const [assignedWorkerId, assignedAddress] of this.workerAddressAssignment.entries()) {
                if (assignedAddress === addr.bech32) {
                  this.stoppedWorkers.delete(assignedWorkerId);
                }
              }
            } else {
              // Single-address mode: clear all stopped workers
              this.stoppedWorkers.clear();
            }

            // IMPORTANT: Stop mining for this address after finding a solution
            // Each address should only submit ONE solution per challenge
            // When this worker returns, Promise.race will stop all other workers
            const logPrefix = isDevFee ? '[DEV FEE]' : '';
            console.log(`[Orchestrator] ${logPrefix} Worker ${workerId} for Address ${addr.index}: Solution submitted, all workers stopping for this address`);
            // CRITICAL: Clear worker assignment so it can be reused for next address
            // Note: stoppedWorkers will be cleared by mineAddressWithWorkers cleanup
            this.deleteWorkerAssignment(workerId);
            return; // Exit the mineForAddress function - stops all workers via Promise.race
          }
        }
      } catch (error: any) {
        // Check if this is a hash service timeout (408) - suggests server overload
        const is408Timeout = error.message && error.message.includes('408');
        const isTimeout = error.message && (error.message.includes('timeout') || error.message.includes('ETIMEDOUT'));

        if (is408Timeout || isTimeout) {
          const now = Date.now();
          const timeSinceLastTimeout = now - this.lastHashServiceTimeout;
          
          // Track consecutive timeouts
          if (timeSinceLastTimeout < 10000) { // Within 10 seconds
            this.hashServiceTimeoutCount++;
          } else {
            // Reset counter if enough time has passed
            this.hashServiceTimeoutCount = 1;
          }
          this.lastHashServiceTimeout = now;
          
          console.error(`[Orchestrator] Worker ${workerId}: Hash service timeout (408) - server may be overloaded`);
          console.error(`[Orchestrator] Worker ${workerId}: Error: ${error.message}`);
          console.error(`[Orchestrator] Consecutive timeout count: ${this.hashServiceTimeoutCount}`);

          // Adaptive backoff: increase delay with consecutive timeouts
          // 1 timeout: 2s, 2 timeouts: 4s, 3 timeouts: 8s, 4+ timeouts: 16s
          const backoffDelay = Math.min(16000, 2000 * Math.pow(2, Math.min(this.hashServiceTimeoutCount - 1, 3)));
          
          // Adaptive batch size reduction: reduce batch size when timeouts occur
          // CRITICAL: This is TEMPORARY and does NOT save to disk - will reset when service stabilizes
          if (this.hashServiceTimeoutCount >= 3 && this.adaptiveBatchSize === null) {
            const currentBatchSize = this.getBatchSize();
            // Reduce batch size by 30% (less aggressive) when 3+ consecutive timeouts occur
            // Minimum is 25% of original or 400, whichever is higher (prevents going too low)
            const minBatchSize = Math.max(400, Math.floor(currentBatchSize * 0.25));
            this.adaptiveBatchSize = Math.max(minBatchSize, Math.floor(currentBatchSize * 0.7));
            console.warn(`[Orchestrator] ⚠️  Hash service overloaded! Temporarily reducing batch size from ${currentBatchSize} to ${this.adaptiveBatchSize} to reduce server load`);
            console.warn(`[Orchestrator] ⚠️  NOTE: This is TEMPORARY - your saved batch size (${this.customBatchSize || 'default'}) is unchanged. Batch size will auto-recover when service stabilizes.`);
            
            this.emit('error', {
              type: 'error',
              message: `Hash service overloaded. Temporarily reducing batch size to ${this.adaptiveBatchSize} (saved: ${this.customBatchSize || currentBatchSize}). Will auto-recover when service stabilizes.`,
            } as MiningEvent);
          } else if (this.hashServiceTimeoutCount >= 6 && this.adaptiveBatchSize !== null) {
            // Further reduce if still timing out (less aggressive - only after 6+ timeouts)
            const currentAdaptive = this.adaptiveBatchSize;
            // Use the original batch size (before any reductions) to calculate minimum
            // This ensures we don't go below 25% of the original, even after multiple reductions
            const originalBatchSize = this.customBatchSize || (300 + (this.workerThreads * 10));
            const minBatchSize = Math.max(400, Math.floor(originalBatchSize * 0.25));
            this.adaptiveBatchSize = Math.max(minBatchSize, Math.floor(this.adaptiveBatchSize * 0.8));
            if (this.adaptiveBatchSize < currentAdaptive) {
              console.warn(`[Orchestrator] ⚠️  Further reducing temporary batch size to ${this.adaptiveBatchSize} due to continued timeouts`);
              console.warn(`[Orchestrator] ⚠️  NOTE: Your saved batch size (${this.customBatchSize || originalBatchSize}) is unchanged. Minimum is ${minBatchSize} (25% of original).`);
            }
          }

          // Log suggestion for user
          const savedBatchSize = this.customBatchSize || this.getBatchSize();
          this.emit('error', {
            type: 'error',
            message: `Hash service timeout on worker ${workerId}. Server may be overloaded. ${this.adaptiveBatchSize !== null ? `Temporarily using batch size ${this.adaptiveBatchSize} (saved: ${savedBatchSize}). Will auto-recover.` : 'Consider reducing batch size or worker count if this persists.'}`,
          } as MiningEvent);

          // Wait with adaptive backoff before retrying to give server time to recover
          await this.sleep(backoffDelay);
          continue; // Skip this batch and try next one
        }
        
        // Reset timeout counter on successful hash (not a timeout error)
        // NOTE: Recovery check is now also done in the main mining loop above for faster recovery
        // This is a secondary check for immediate recovery after a successful hash
        if (this.hashServiceTimeoutCount > 0 && this.adaptiveBatchSize !== null) {
          const timeSinceLastTimeout = Date.now() - this.lastHashServiceTimeout;
          // Reset immediately if we've had 5 seconds of no timeouts (very fast recovery after success)
          if (timeSinceLastTimeout > 5000) {
            const previousAdaptive = this.adaptiveBatchSize;
            this.hashServiceTimeoutCount = 0;
            const restoredBatchSize = this.getBatchSize(); // Will return customBatchSize or default
            console.log(`[Orchestrator] ✓ Hash service stabilized (successful hash). Restoring batch size from ${previousAdaptive} to ${restoredBatchSize} (saved value)`);
            this.adaptiveBatchSize = null;
            
            // Emit info event to notify UI
            this.emit('error', {
              type: 'error',
              message: `Hash service recovered. Batch size restored to ${restoredBatchSize} (saved value).`,
            } as MiningEvent);
          }
        }

        Logger.error('mining', 'Batch hash computation error', error);

        // For other errors, check if we should continue or exit
        // CRITICAL: Don't exit on transient errors - continue mining
        // Only exit on critical errors (challenge changed, worker stopped, etc.)
        if (!this.isRunning || !this.isMining || this.currentChallengeId !== challengeId) {
          // Critical state change - exit worker
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          const workerData = this.workerStats.get(workerId);
          if (workerData) {
            workerData.status = 'idle';
          }
          return;
        }
        
        // Transient error - wait a bit and continue
        await this.sleep(1000);
      }

      // Emit progress event every PROGRESS_INTERVAL batches
      // Only log to console every 10 batches to reduce noise
      if (batchCounter % PROGRESS_INTERVAL === 0) {
        const now = Date.now();
        // OPTIMIZATION: Use incremental hash rate from workerData instead of recalculating
        // This avoids redundant calculations and is more accurate
        const workerData = this.workerStats.get(workerId);
        let hashRate = 0;
        if (workerData && workerData.hashRate > 0) {
          // Use the incrementally calculated hash rate (already updated in hash computation block above)
          hashRate = Math.round(workerData.hashRate);
        } else {
          // Fallback: calculate from elapsed time if workerData not available or hash rate not yet calculated
        const elapsedSeconds = (now - lastProgressTime) / 1000;
          hashRate = elapsedSeconds > 0 ? Math.round((BATCH_SIZE * PROGRESS_INTERVAL) / elapsedSeconds) : 0;
        }
        lastProgressTime = now;

        // Update worker stats (hash rate already updated incrementally in hash computation block above)
        if (workerData) {
          workerData.hashesComputed = hashCount;
          // Hash rate already updated incrementally in the hash computation block above
          // Only update if we calculated it from elapsed time (fallback)
          if (workerData.hashRate === 0 && hashRate > 0) {
          workerData.hashRate = hashRate;
          }
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
          // CRITICAL FIX: Add error handling for fire-and-forget promise
          this.startDevFeeMining().catch((error: any) => {
            console.error('[Orchestrator] Failed to start dev fee mining:', error);
            // Don't throw - this is background operation, don't block user mining
          });
        } else {
          console.log(`[Orchestrator] ✓ Dev fee found in last ${ratio} receipts or not enough receipts yet`);
        }
      }

      // Record solution timestamp for stats (keep only last 24 hours to prevent memory leak)
      // OPTIMIZATION: Use efficient cleanup - only filter when array gets large
      const now = Date.now();
      this.solutionTimestamps.push({ timestamp: now });
      // Only filter when array gets large (every 100 solutions) to avoid filtering on every solution
      if (this.solutionTimestamps.length > 100) {
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        // OPTIMIZATION: Use efficient cleanup - find first valid index and slice
        let firstValidIndex = 0;
        for (let i = 0; i < this.solutionTimestamps.length; i++) {
          if (this.solutionTimestamps[i].timestamp > oneDayAgo) {
            firstValidIndex = i;
            break;
          }
        }
        if (firstValidIndex > 0) {
          this.solutionTimestamps = this.solutionTimestamps.slice(firstValidIndex);
        }
      }

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
   * CRITICAL FIX: Returns Promise to allow proper error handling
   */
  private startDevFeeMining(): Promise<void> {
    // Don't start if already mining dev fee
    if (this.isDevFeeMining) {
      console.log('[Orchestrator] Dev fee already mining, skipping...');
      return Promise.resolve();
    }

    // Don't start if dev fee not enabled
    if (!devFeeManager.isEnabled() || !devFeeManager.hasValidAddressPool()) {
      console.log('[Orchestrator] Dev fee not enabled or no valid address pool');
      return Promise.resolve();
    }

    // Don't start if no active challenge
    if (!this.currentChallengeId) {
      console.log('[Orchestrator] No active challenge, skipping dev fee');
      return Promise.resolve();
    }

    this.isDevFeeMining = true;
    console.log('[Orchestrator] [DEV FEE] Starting dev fee mining in background...');

    // CRITICAL FIX: Return promise to allow proper error handling by caller
    return this.mineDevFeeInBackground()
      .then(() => {
        this.isDevFeeMining = false;
        console.log('[Orchestrator] [DEV FEE] Background mining completed');
      })
      .catch((error: any) => {
        this.isDevFeeMining = false;
        console.error('[Orchestrator] [DEV FEE] Background mining failed:', error.message);
        // Re-throw to allow caller to handle
        throw error;
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

    // CRITICAL: Remove duplicate addresses by index to prevent registering the same address multiple times
    // Use a Map to track unique addresses by index
    const uniqueAddressesMap = new Map<number, DerivedAddress>();
    for (const addr of unregistered) {
      if (!uniqueAddressesMap.has(addr.index)) {
        uniqueAddressesMap.set(addr.index, addr);
      } else {
        console.warn(`[Orchestrator] ⚠️  Duplicate address detected at index ${addr.index}, skipping duplicate`);
      }
    }
    unregistered = Array.from(uniqueAddressesMap.values());
    
    if (unregistered.length === 0) {
      console.log('[Orchestrator] All addresses already registered (after duplicate removal)');
      return;
    }

    console.log(`[Orchestrator] Registering ${unregistered.length} unique addresses (removed ${this.addresses.filter(a => !a.registered).length - unregistered.length} duplicates)...`);
    const totalToRegister = unregistered.length;
    let registeredCount = 0;
    let conflictDetected = false;
    let addressesInConflict = 0;
    const MAX_RETRIES = 5; // Increased retries for 429 errors
    const BASE_RETRY_DELAY = 5000; // Base 5 seconds between retries
    const failedAddresses: DerivedAddress[] = [];
    let rateLimitDetected = false; // Track if we've hit rate limits
    const addressesBeingRegistered = new Set<number>(); // Track addresses currently being registered to prevent duplicates

    // CRITICAL: Start with conservative parallel batch size to avoid rate limits
    // Reduce batch size if we detect 429 errors
    let PARALLEL_REGISTRATION_BATCH_SIZE = totalToRegister > 50 ? 5 : 1; // Reduced from 10 to 5 for large sets
    let REGISTRATION_DELAY = totalToRegister > 50 ? 500 : 2000; // Increased delay between batches
    
    // Process addresses in parallel batches
    for (let batchStart = 0; batchStart < unregistered.length; batchStart += PARALLEL_REGISTRATION_BATCH_SIZE) {
      const batch = unregistered.slice(batchStart, batchStart + PARALLEL_REGISTRATION_BATCH_SIZE);
      
      // Register batch in parallel
      const batchResults = await Promise.allSettled(batch.map(async (addr) => {
        // CRITICAL: Check if this address is already being registered by another parallel batch
        if (addressesBeingRegistered.has(addr.index)) {
          console.warn(`[Orchestrator] ⚠️  Address ${addr.index} is already being registered, skipping duplicate attempt`);
          return { addr, success: false, skipped: true };
        }
        
        // Mark as being registered
        addressesBeingRegistered.add(addr.index);
        
        let success = false;
        let retries = 0;

        try {
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
              // CRITICAL: Check if error indicates address is already registered (even if not caught by registerAddress)
              const statusCode = error?.response?.status;
              const errorMessage = error?.response?.data?.message || error?.message || '';
              const isAlreadyRegistered = (
                statusCode === 400 || 
                statusCode === 409 || 
                errorMessage.toLowerCase().includes('already registered') ||
                errorMessage.toLowerCase().includes('already exists') ||
                errorMessage.toLowerCase().includes('duplicate')
              );
              
              // If address is already registered, mark it and stop retrying
              if (isAlreadyRegistered) {
                console.log(`[Orchestrator] Address ${addr.index} is already registered (detected in retry loop) - marking as registered and stopping retries`);
                if (this.walletManager) {
                  this.walletManager.markAddressRegistered(addr.index);
                }
                addr.registered = true;
                success = true;
                registeredCount++;
                addressesInConflict++;
                conflictDetected = true;
                
                // Emit registration success event
                this.emit('registration_progress', {
                  type: 'registration_progress',
                  addressIndex: addr.index,
                  address: addr.bech32,
                  current: registeredCount,
                  total: totalToRegister,
                  success: true,
                  message: `Address ${addr.index} already registered (detected during retry)`,
                } as MiningEvent);
                break; // Exit retry loop
              }
              
              // CRITICAL: Detect 429 rate limit errors and use exponential backoff
              const isRateLimit = statusCode === 429 || error.message?.includes('429');
              
              if (isRateLimit) {
                rateLimitDetected = true;
                // Exponential backoff for rate limits: 5s, 10s, 20s, 40s, 80s
                const exponentialDelay = BASE_RETRY_DELAY * Math.pow(2, retries - 1);
                // Cap at 60 seconds max
                const retryDelay = Math.min(exponentialDelay, 60000);
                
                console.warn(`[Orchestrator] ⚠️  Rate limit (429) detected for address ${addr.index}. Retrying in ${retryDelay/1000}s (attempt ${retries}/${MAX_RETRIES})...`);
                
                // Reduce parallel batch size if we hit rate limits
                if (PARALLEL_REGISTRATION_BATCH_SIZE > 1) {
                  PARALLEL_REGISTRATION_BATCH_SIZE = Math.max(1, Math.floor(PARALLEL_REGISTRATION_BATCH_SIZE / 2));
                  REGISTRATION_DELAY = Math.min(REGISTRATION_DELAY * 2, 10000); // Increase delay between batches, cap at 10s
                  console.log(`[Orchestrator] ⚙️  Reduced parallel batch size to ${PARALLEL_REGISTRATION_BATCH_SIZE} and increased delay to ${REGISTRATION_DELAY}ms due to rate limits`);
                }
                
                await this.sleep(retryDelay);
              } else {
                // Regular error - use base delay
                console.warn(`[Orchestrator] Registration attempt ${retries} failed for address ${addr.index}: ${error.message}, retrying in ${BASE_RETRY_DELAY/1000}s...`);
                await this.sleep(BASE_RETRY_DELAY);
              }
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
        } finally {
          // Always remove from set when done (success or failure)
          addressesBeingRegistered.delete(addr.index);
        }
      }));
      
      // Process results and track failures
      for (const result of batchResults) {
        if (result.status === 'rejected') {
          console.error(`[Orchestrator] Registration promise rejected:`, result.reason);
        }
      }
      
      // Rate limiting between batches
      // CRITICAL: Increase delay if we've detected rate limits
      if (batchStart + PARALLEL_REGISTRATION_BATCH_SIZE < unregistered.length) {
        const batchDelay = rateLimitDetected ? Math.max(REGISTRATION_DELAY, 2000) : REGISTRATION_DELAY;
        await this.sleep(batchDelay);
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
      
      // Emit system status update: registration complete
      this.emit('system_status', {
        type: 'system_status',
        state: 'running',
        substate: 'registration_complete',
        message: `All ${finalRegistered} addresses registered successfully`,
        progress: 100,
        details: {
          addressesLoaded: this.addresses.length,
          addressesValidated: true,
          workersConfigured: this.workerThreads,
          workersActive: this.workerThreads,
          batchSize: this.getBatchSize(),
          challengeId: this.currentChallengeId,
          registrationComplete: true,
        },
      } as MiningEvent);
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

  /**
   * Start hash rate monitoring for automatic recovery
   * Monitors hash rate and automatically stops/restarts mining based on hash rate
   * - Only restarts after 5 full minutes of bad hash rate
   * - Rate limited to once per 20 minutes
   */
  private startHashRateMonitoring(password: string, addressOffset: number): void {
    // Clear any existing monitoring
    if (this.hashRateMonitorInterval) {
      clearInterval(this.hashRateMonitorInterval);
    }

    // Reset restart timestamp and bad hash rate tracking when starting monitoring
    this.lastHashRateRestart = 0;
    this.badHashRateStartTime = null;
    this.emergencyHashRateStartTime = null;

    // Monitor hash rate every 30 seconds
    this.hashRateMonitorInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return; // Don't monitor if not running or not mining
      }

      const now = Date.now();
      // CRITICAL: getStats() uses this.totalHashesComputed which is the TOTAL SYSTEM hash rate
      // This is correct - we monitor the total system hash rate, not per-address
      const stats = this.getStats();
      const currentHashRate = stats.hashRate; // Total system hash rate (all workers combined)

      // CRITICAL: Detect very low hash rate (emergency recovery - hardcoded 300 H/s threshold)
      // Track when hash rate first dropped below 300 H/s, only restart after 5 minutes
      if (currentHashRate < 300 && this.hashRateHistory.length > 0) {
        if (this.emergencyHashRateStartTime === null) {
          // First time we detect bad hash rate - start tracking
          this.emergencyHashRateStartTime = now;
          console.warn(`[Orchestrator] ⚠️  Hash rate below 300 H/s threshold (${currentHashRate.toFixed(2)} H/s). Monitoring for 5 minutes...`);
        } else {
          // Check if we've had bad hash rate for 5 full minutes
          const timeSinceBadStart = now - this.emergencyHashRateStartTime;
          const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
          
          if (timeSinceBadStart >= fiveMinutes) {
            // Rate limiting: don't restart more than once every 20 minutes
            const timeSinceLastRestart = now - this.lastHashRateRestart;
            const minRestartInterval = 20 * 60 * 1000; // 20 minutes
            if (timeSinceLastRestart < minRestartInterval) {
              // Too soon since last restart, skip
              console.log(`[Orchestrator] Hash rate still bad, but restart rate limit active (${Math.ceil((minRestartInterval - timeSinceLastRestart) / 60000)} minutes remaining)`);
              return;
            }
            
            console.error(`[Orchestrator] 🚨 EMERGENCY: Hash rate below 300 H/s threshold (${currentHashRate.toFixed(2)} H/s) for 5+ minutes!`);
            console.error(`[Orchestrator] Restarting to recover...`);
            
            // Emit critical error
            this.emit('error', {
              type: 'error',
              message: `EMERGENCY: Hash rate below 300 H/s (${currentHashRate.toFixed(0)} H/s) for 5+ minutes. Restarting...`,
            } as MiningEvent);

            // Reset emergency hash rate tracking and record restart
            this.emergencyHashRateStartTime = null;
            this.badHashRateStartTime = null; // Also reset normal threshold tracking
            this.lastHashRateRestart = now;
            this.restartMiningForHashRateRecovery(password, addressOffset);
            return;
          } else {
            // Still monitoring, log progress
            const minutesRemaining = Math.ceil((fiveMinutes - timeSinceBadStart) / 60000);
            if (Math.random() < 0.1) { // Log occasionally to avoid spam
              console.warn(`[Orchestrator] ⚠️  Hash rate still below 300 H/s. ${minutesRemaining} minute(s) remaining before restart...`);
            }
          }
        }
      } else if (this.emergencyHashRateStartTime !== null && currentHashRate >= 300) {
        // Hash rate recovered - reset tracking
        console.log(`[Orchestrator] ✓ Hash rate recovered above 300 H/s threshold. Resetting emergency hash rate tracking.`);
        this.emergencyHashRateStartTime = null;
      }

      // CRITICAL: Detect near-zero hash rate (emergency recovery)
      // Track when hash rate first dropped below 1 H/s, only restart after 5 minutes
      // Note: This uses the same emergency tracking as 300 H/s threshold
      if (currentHashRate < 1 && this.hashRateHistory.length > 0) {
        if (this.emergencyHashRateStartTime === null) {
          // First time we detect near-zero hash rate - start tracking
          this.emergencyHashRateStartTime = now;
          console.warn(`[Orchestrator] ⚠️  Hash rate near zero (${currentHashRate.toFixed(2)} H/s). Monitoring for 5 minutes...`);
        } else {
          // Check if we've had bad hash rate for 5 full minutes
          const timeSinceBadStart = now - this.emergencyHashRateStartTime;
          const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
          
          if (timeSinceBadStart >= fiveMinutes) {
            // Rate limiting: don't restart more than once every 20 minutes
            const timeSinceLastRestart = now - this.lastHashRateRestart;
            const minRestartInterval = 20 * 60 * 1000; // 20 minutes
            if (timeSinceLastRestart < minRestartInterval) {
              // Too soon since last restart, skip
              console.log(`[Orchestrator] Hash rate still near zero, but restart rate limit active (${Math.ceil((minRestartInterval - timeSinceLastRestart) / 60000)} minutes remaining)`);
              return;
            }
            
            console.error(`[Orchestrator] 🚨 EMERGENCY: Hash rate near zero (${currentHashRate.toFixed(2)} H/s) for 5+ minutes!`);
            console.error(`[Orchestrator] Restarting to recover...`);
            
            // Emit critical error
            this.emit('error', {
              type: 'error',
              message: `EMERGENCY: Hash rate near zero (${currentHashRate.toFixed(0)} H/s) for 5+ minutes. Restarting...`,
            } as MiningEvent);

            // Reset emergency hash rate tracking and record restart
            this.emergencyHashRateStartTime = null;
            this.badHashRateStartTime = null; // Also reset normal threshold tracking
            this.lastHashRateRestart = now;
            this.restartMiningForHashRateRecovery(password, addressOffset);
            return;
          } else {
            // Still monitoring, log progress
            const minutesRemaining = Math.ceil((fiveMinutes - timeSinceBadStart) / 60000);
            if (Math.random() < 0.1) { // Log occasionally to avoid spam
              console.warn(`[Orchestrator] ⚠️  Hash rate still near zero. ${minutesRemaining} minute(s) remaining before restart...`);
            }
          }
        }
      } else if (this.emergencyHashRateStartTime !== null && currentHashRate >= 1 && currentHashRate < 300) {
        // Hash rate recovered above 1 H/s but still below 300 H/s - keep tracking for 300 H/s threshold
        // (This case is handled by the 300 H/s check above)
      } else if (this.emergencyHashRateStartTime !== null && currentHashRate >= 300) {
        // Hash rate recovered above 300 H/s - reset tracking
        console.log(`[Orchestrator] ✓ Hash rate recovered above 300 H/s. Resetting emergency hash rate tracking.`);
        this.emergencyHashRateStartTime = null;
      }

      // Add current hash rate to history
      this.hashRateHistory.push({
        timestamp: now,
        hashRate: currentHashRate,
      });

      // CRITICAL: Check if all addresses are registered before starting baseline collection
      // Only start baseline collection AFTER all addresses are registered
      const registeredCount = this.addresses.filter(a => a.registered).length;
      const allAddressesRegistered = registeredCount >= this.addresses.length;
      
      // If registration just completed and baseline hasn't started, start it now
      if (allAddressesRegistered && !this.baselineRegistrationComplete && this.baselineHashRate === null) {
        console.log(`[Orchestrator] ✓ All addresses registered! Starting baseline hash rate collection (5 minutes)...`);
        this.baselineStartTime = now;
        this.baselineWorkerThreads = this.workerThreads;
        this.baselineBatchSize = this.getBatchSize();
        this.baselineRegistrationComplete = true;
        this.hashRateHistory = []; // Reset history to start fresh baseline collection after registration
      }
      
      // CRITICAL: Collect baseline during first 5 minutes AFTER registration completes
      if (this.baselineStartTime && this.baselineHashRate === null && this.baselineRegistrationComplete) {
        const timeSinceStart = now - this.baselineStartTime;
        const baselineCollectionTime = 5 * 60 * 1000; // 5 minutes (reduced from 10)
        
        // Need at least 10 samples (5 minutes / 30 seconds = 10 samples)
        if (timeSinceStart >= baselineCollectionTime && this.hashRateHistory.length >= 10) {
          // Calculate baseline from first 5 minutes after registration
          const baselineSamples = this.hashRateHistory.filter(h => 
            h.timestamp >= this.baselineStartTime! && 
            h.timestamp <= this.baselineStartTime! + baselineCollectionTime
          );
          
          if (baselineSamples.length > 0) {
            this.baselineHashRate = baselineSamples.reduce((sum, h) => sum + h.hashRate, 0) / baselineSamples.length;
            console.log(`[Orchestrator] ✓ Baseline hash rate established: ${this.baselineHashRate.toFixed(2)} H/s`);
            console.log(`[Orchestrator]   Settings: ${this.baselineWorkerThreads} workers, batch size ${this.baselineBatchSize}`);
            console.log(`[Orchestrator]   Collected over 5 minutes after registration completed`);
            console.log(`[Orchestrator]   Will use this baseline for threshold calculation (50% drop triggers restart)`);
          }
        }
      }

      // CRITICAL FIX: Efficiently keep only last 10 minutes of history (600 seconds / 30 seconds = 20 samples)
      // Use slice instead of filter to avoid creating new array unnecessarily
      const tenMinutesAgo = now - (10 * 60 * 1000);
      // Find first valid index (more efficient than filter)
      let firstValidIndex = 0;
      for (let i = 0; i < this.hashRateHistory.length; i++) {
        if (this.hashRateHistory[i].timestamp >= tenMinutesAgo) {
          firstValidIndex = i;
          break;
        }
      }
      if (firstValidIndex > 0) {
        this.hashRateHistory = this.hashRateHistory.slice(firstValidIndex);
      }

      // Need at least 5 minutes of history (10 samples) before checking (unless using baseline)
      if (this.hashRateHistory.length < 10 && this.baselineHashRate === null) {
        return; // Not enough data yet
      }

      // Determine which threshold to use
      let thresholdHashRate: number;
      let thresholdSource: string;
      
      // Check if baseline is valid (settings match)
      const currentWorkerThreads = this.workerThreads;
      const currentBatchSize = this.getBatchSize();
      const settingsMatch = this.baselineHashRate !== null &&
                           this.baselineWorkerThreads === currentWorkerThreads &&
                           this.baselineBatchSize === currentBatchSize;
      
      if (settingsMatch && this.baselineHashRate !== null) {
        // Use baseline from first 10 minutes
        thresholdHashRate = this.baselineHashRate;
        thresholdSource = 'baseline (first 10 min)';
      } else {
        // Use rolling 10-minute average
        thresholdHashRate = this.hashRateHistory.reduce((sum, h) => sum + h.hashRate, 0) / this.hashRateHistory.length;
        thresholdSource = 'rolling 10-min average';
      }

      // Only check if threshold was meaningful (> 10 H/s) to avoid false positives at startup
      if (thresholdHashRate <= 10) {
        return;
      }

      // Check if we should restart due to low hash rate (50% drop from baseline)
      const stopThreshold = thresholdHashRate * 0.5; // 50% of threshold = 50% drop
      if (currentHashRate < stopThreshold) {
        if (this.badHashRateStartTime === null) {
          // First time we detect bad hash rate - start tracking
          this.badHashRateStartTime = now;
          console.warn(`[Orchestrator] ⚠️  Hash rate drop detected!`);
          console.warn(`[Orchestrator] Current: ${currentHashRate.toFixed(2)} H/s`);
          console.warn(`[Orchestrator] Threshold (${thresholdSource}): ${thresholdHashRate.toFixed(2)} H/s`);
          console.warn(`[Orchestrator] Stop threshold (50%): ${stopThreshold.toFixed(2)} H/s`);
          console.warn(`[Orchestrator] Monitoring for 5 minutes before restart...`);
        } else {
          // Check if we've had bad hash rate for 5 full minutes
          const timeSinceBadStart = now - this.badHashRateStartTime;
          const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
          
          if (timeSinceBadStart >= fiveMinutes) {
            // Rate limiting: don't restart more than once every 20 minutes
            const timeSinceLastRestart = now - this.lastHashRateRestart;
            const minRestartInterval = 20 * 60 * 1000; // 20 minutes
            if (timeSinceLastRestart < minRestartInterval) {
              // Too soon since last restart, skip
              console.log(`[Orchestrator] Hash rate still below threshold, but restart rate limit active (${Math.ceil((minRestartInterval - timeSinceLastRestart) / 60000)} minutes remaining)`);
              return;
            }
            
            console.warn(`[Orchestrator] ⚠️  Hash rate drop persisted for 5+ minutes!`);
            console.warn(`[Orchestrator] Current: ${currentHashRate.toFixed(2)} H/s`);
            console.warn(`[Orchestrator] Threshold (${thresholdSource}): ${thresholdHashRate.toFixed(2)} H/s`);
            console.warn(`[Orchestrator] Stop threshold (50%): ${stopThreshold.toFixed(2)} H/s`);
            console.warn(`[Orchestrator] Automatically restarting mining (stop 5s, then resume)...`);

            // Emit warning event
            this.emit('error', {
              type: 'error',
              message: `Hash rate dropped to ${currentHashRate.toFixed(0)} H/s (below 50% of ${thresholdSource}) for 5+ minutes. Automatically restarting mining...`,
            } as MiningEvent);

            // Reset bad hash rate tracking and record restart timestamp
            this.badHashRateStartTime = null;
            this.lastHashRateRestart = now;

            // Stop mining, wait 5 seconds, then restart
            this.restartMiningForHashRateRecovery(password, addressOffset);
          } else {
            // Still monitoring, log progress occasionally
            const minutesRemaining = Math.ceil((fiveMinutes - timeSinceBadStart) / 60000);
            if (Math.random() < 0.1) { // Log occasionally to avoid spam
              console.warn(`[Orchestrator] ⚠️  Hash rate still below threshold. ${minutesRemaining} minute(s) remaining before restart...`);
            }
          }
        }
      } else if (this.badHashRateStartTime !== null && currentHashRate >= stopThreshold) {
        // Hash rate recovered above threshold - reset tracking
        console.log(`[Orchestrator] ✓ Hash rate recovered above threshold. Resetting bad hash rate tracking.`);
        this.badHashRateStartTime = null;
      }
    }, 30000); // Check every 30 seconds

    console.log('[Orchestrator] Hash rate monitoring started (checks every 30s, collects baseline for 5 min after registration, auto-restarts only after 5 full minutes of bad hash rate, max once per 20 minutes)');
  }

  /**
   * Start technical metrics reporting
   * Emits detailed technical metrics every 5 seconds for dashboard display
   */
  private startTechnicalMetricsReporting(): void {
    // Clear any existing reporting
    if (this.technicalMetricsInterval) {
      clearInterval(this.technicalMetricsInterval);
    }

    // Emit metrics every 5 seconds
    // CRITICAL FIX: Also emit stats and worker updates for UI
    this.technicalMetricsInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return; // Don't report if not running or not mining
      }

      const now = Date.now();
      
      // CRITICAL FIX: Emit stats update for UI (solutions found, this hour, today, etc.)
      this.emit('stats', {
        type: 'stats',
        stats: this.getStats(),
      } as MiningEvent);
      
      // CRITICAL FIX: Emit worker updates for Workers tab
      this.workerStats.forEach((workerData, workerId) => {
        this.emit('worker_update', {
          type: 'worker_update',
          workerId: workerData.workerId,
          addressIndex: workerData.addressIndex,
          address: workerData.address,
          hashesComputed: workerData.hashesComputed,
          hashRate: workerData.hashRate,
          solutionsFound: workerData.solutionsFound,
          status: workerData.status,
          currentChallenge: workerData.currentChallenge,
        } as MiningEvent);
      });
      
      // Calculate worker statistics
      const workerStatusCounts: Record<string, number> = {};
      let totalActive = 0;
      let totalIdle = 0;
      let totalMining = 0;
      let totalSubmitting = 0;
      let totalCompleted = 0;
      const hashesPerWorker: Record<number, number> = {};
      let totalHashesFromWorkers = 0;

      for (const [workerId, workerData] of this.workerStats.entries()) {
        const status = workerData.status;
        workerStatusCounts[status] = (workerStatusCounts[status] || 0) + 1;
        
        if (status === 'idle') totalIdle++;
        else if (status === 'mining') totalMining++;
        else if (status === 'submitting') totalSubmitting++;
        else if (status === 'completed') totalCompleted++;
        
        if (status !== 'idle' && status !== 'completed') {
          totalActive++;
        }

        hashesPerWorker[workerId] = workerData.hashesComputed;
        totalHashesFromWorkers += workerData.hashesComputed;
      }

      // Calculate thread utilization
      const maxCpuThreads = this.detectCpuThreadCount();
      const threadsInUse = this.workerAddressAssignment.size;
      const utilizationPercent = maxCpuThreads > 0 ? (threadsInUse / maxCpuThreads) * 100 : 0;

      // Calculate failure statistics
      let totalSubmissionFailures = 0;
      let maxFailuresForAnyAddress = 0;
      for (const failureCount of this.addressSubmissionFailures.values()) {
        totalSubmissionFailures += failureCount;
        if (failureCount > maxFailuresForAnyAddress) {
          maxFailuresForAnyAddress = failureCount;
        }
      }
      const addressesWithFailures = this.addressSubmissionFailures.size;
      const averageFailuresPerAddress = addressesWithFailures > 0 
        ? totalSubmissionFailures / addressesWithFailures 
        : 0;

      // Calculate address statistics
      const registeredCount = this.addresses.filter(a => a.registered).length;
      const unregisteredCount = this.addresses.length - registeredCount;
      const solvedCount = this.addresses.filter(a => {
        if (!this.currentChallengeId) return false;
        const solvedChallenges = this.solvedAddressChallenges.get(a.bech32);
        return solvedChallenges?.has(this.currentChallengeId) || false;
      }).length;
      
      // Count addresses in progress and waiting retry (approximate from worker assignments)
      const addressesInProgress = new Set(this.workerAddressAssignment.values()).size;
      // For waiting retry, we'd need to check lastMineAttempt, but that's not accessible here
      // We'll approximate it as addresses with failures that aren't in progress
      const addressesWaitingRetry = Math.max(0, addressesWithFailures - addressesInProgress);

      // Calculate solutions per hour
      const uptime = this.startTime ? (now - this.startTime) / 1000 : 0; // seconds
      const solutionsPerHour = uptime > 0 ? (this.solutionsFound / uptime) * 3600 : 0;

      // Emit technical metrics event
      this.emit('technical_metrics', {
        type: 'technical_metrics',
        timestamp: now,
        workers: {
          totalConfigured: this.workerThreads,
          totalActive,
          totalIdle,
          totalMining,
          totalSubmitting,
          totalCompleted,
          byStatus: workerStatusCounts,
        },
        threads: {
          totalInUse: threadsInUse,
          maxAvailable: maxCpuThreads,
          utilizationPercent: Math.round(utilizationPercent * 100) / 100,
        },
        failures: {
          totalSubmissionFailures,
          addressesWithFailures,
          averageFailuresPerAddress: Math.round(averageFailuresPerAddress * 100) / 100,
          maxFailuresForAnyAddress,
        },
        hashService: {
          timeoutCount: this.hashServiceTimeoutCount,
          lastTimeout: this.lastHashServiceTimeout > 0 ? this.lastHashServiceTimeout : null,
          adaptiveBatchSizeActive: this.adaptiveBatchSize !== null,
          currentBatchSize: this.getBatchSize(),
          baseBatchSize: this.customBatchSize || 850,
        },
        hashing: {
          totalHashesComputed: this.totalHashesComputed,
          totalHashesPerWorker: hashesPerWorker,
          averageHashesPerWorker: this.workerStats.size > 0 
            ? Math.round((totalHashesFromWorkers / this.workerStats.size) * 100) / 100 
            : 0,
        },
        addresses: {
          total: this.addresses.length,
          registered: registeredCount,
          unregistered: unregisteredCount,
          inProgress: addressesInProgress,
          waitingRetry: addressesWaitingRetry,
          solved: solvedCount,
          failed: addressesWithFailures,
        },
        performance: {
          cpuUsage: this.cpuUsage,
          uptime: Math.round(uptime),
          solutionsFound: this.solutionsFound,
          solutionsPerHour: Math.round(solutionsPerHour * 100) / 100,
        },
        memory: {
          workerStatsSize: this.workerStats.size,
          addressAssignmentsSize: this.workerAddressAssignment.size,
          submittedSolutionsSize: this.submittedSolutions.size,
          pausedAddressesSize: this.pausedAddresses.size,
          submittingAddressesSize: this.submittingAddresses.size,
        },
      } as MiningEvent);
    }, 5000); // Emit every 5 seconds

    console.log('[Orchestrator] Technical metrics reporting started (emits every 5s)');
  }

  /**
   * Restart mining for hash rate recovery
   * CRITICAL: This method MUST follow the exact sequence: stop → wait 5s → start
   * This is the proven method that fixes hash rate drops
   */
  private async restartMiningForHashRateRecovery(password: string, addressOffset: number): Promise<void> {
    if (!this.isRunning) {
      return; // Don't restart if not running
    }

    console.log('[Orchestrator] ========================================');
    console.log('[Orchestrator] HASH RATE RECOVERY - Starting restart');
    console.log('[Orchestrator] ========================================');

    try {
      // STEP 1: Stop mining completely
      console.log('[Orchestrator] Step 1: Stopping mining...');
      this.isMining = false;

      // CRITICAL: Kill all hash workers immediately to stop all computation
      try {
        await hashEngine.killWorkers();
        console.log('[Orchestrator] ✓ All hash workers killed');
      } catch (error: any) {
        console.error('[Orchestrator] Failed to kill workers:', error.message);
      }

      // CRITICAL: Clear ALL state that could cause issues
      console.log('[Orchestrator] Step 2: Clearing all worker and address state...');
      this.workerStats.clear();
      this.stoppedWorkers.clear();
    this.workerAddressAssignment.clear();
    this.addressToWorkers.clear(); // Clear reverse map when clearing assignments
    this.staticPreimageCache.clear(); // Clear preimage cache on challenge change
      this.addressSubmissionFailures.clear();
      this.submittingAddresses.clear();
      this.pausedAddresses.clear();
      this.addressesProcessedCurrentChallenge.clear();
      this.solvedAddressChallenges.clear(); // Clear solved addresses to allow re-mining
      this.submittedSolutions.clear(); // Clear submitted solutions
      this.totalHashesComputed = 0;
      this.lastHashRateUpdate = Date.now();

      // Reset hash service timeout tracking
      this.hashServiceTimeoutCount = 0;
      this.lastHashServiceTimeout = 0;
      this.adaptiveBatchSize = null;

      // Clear cached registered addresses to force refresh
      this.cachedRegisteredAddresses = null;
      this.lastRegisteredAddressesUpdate = 0;

      // Clear submission key cache
      this.cachedSubmissionKeys.clear();

      // Reset current mining address
      this.currentMiningAddress = null;

      console.log('[Orchestrator] ✓ All state cleared');

      // STEP 2: Wait exactly 5 seconds (critical timing)
      console.log('[Orchestrator] Step 3: Waiting 5 seconds (critical for recovery)...');
      await this.sleep(5000); // Wait 5 seconds - this is the proven fix

      // STEP 3: Restart mining
      console.log('[Orchestrator] Step 4: Restarting mining...');
      
      // CRITICAL: Reset baseline tracking to start fresh after restart
      // This ensures we don't use a bad baseline from before the restart
      // But keep baselineRegistrationComplete flag so we know when to start collecting again
      this.baselineHashRate = null;
      this.baselineStartTime = null; // Will be set when registration completes again
      this.baselineRegistrationComplete = false; // Reset so we wait for registration again
      this.hashRateHistory = []; // Reset history to start fresh baseline collection

      // Restart mining
      if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
        this.startMining();
        console.log('[Orchestrator] ========================================');
        console.log('[Orchestrator] ✓ Mining restarted successfully after hash rate recovery');
        console.log('[Orchestrator] ========================================');
        
        this.emit('error', {
          type: 'error',
          message: 'Mining restarted successfully after hash rate recovery. Baseline tracking reset.',
        } as MiningEvent);
      } else {
        console.error('[Orchestrator] ✗ Cannot restart: orchestrator not running or no challenge');
      }
    } catch (error: any) {
      console.error('[Orchestrator] Hash rate recovery restart failed:', error.message);
      console.error('[Orchestrator] Attempting emergency recovery...');
      
      // Emergency recovery: try to resume mining anyway
      if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
        this.isMining = false; // Ensure it's stopped first
        await this.sleep(5000); // Wait 5 seconds
        this.startMining();
        console.log('[Orchestrator] Emergency recovery: Mining restarted');
      }
    }
  }

  /**
   * Restart mining to recover from hash rate drop
   * This is similar to the hourly restart but triggered by hash rate monitoring
   */
  private async restartMining(password: string, addressOffset: number): Promise<void> {
    if (!this.isRunning) {
      return; // Don't restart if not running
    }

    console.log('[Orchestrator] ========================================');
    console.log('[Orchestrator] AUTO-RESTART - Recovering from hash rate drop');
    console.log('[Orchestrator] ========================================');

    try {
      // Stop current mining
      console.log('[Orchestrator] Stopping mining for recovery...');
      this.isMining = false;

      // Give workers time to finish current batch
      await this.sleep(2000);

      // Clear worker state
      this.workerStats.clear();
      this.stoppedWorkers.clear();
    this.workerAddressAssignment.clear();
    this.addressToWorkers.clear(); // Clear reverse map when clearing assignments
    this.staticPreimageCache.clear(); // Clear preimage cache on challenge change
      this.addressSubmissionFailures.clear();
      this.submittingAddresses.clear();
      this.pausedAddresses.clear();
      this.totalHashesComputed = 0;
      this.lastHashRateUpdate = Date.now();
      this.hashRateHistory = []; // Reset history after restart

      // Reset hash service timeout tracking
      this.hashServiceTimeoutCount = 0;
      this.lastHashServiceTimeout = 0;
      this.adaptiveBatchSize = null;

      console.log('[Orchestrator] Worker state cleared, restarting mining...');

      // Restart mining
      if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
        this.startMining();
        console.log('[Orchestrator] ✓ Mining restarted successfully');
        
        this.emit('error', {
          type: 'error',
          message: 'Mining restarted successfully after hash rate recovery.',
        } as MiningEvent);
      }
    } catch (error: any) {
      console.error('[Orchestrator] Auto-restart failed:', error.message);
      // Try to resume mining anyway
      if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
        this.startMining();
      }
    }
  }

  /**
   * Start periodic stability checks and repairs
   * Detects and fixes bad states that can occur during mining
   */
  private startStabilityChecks(): void {
    // Clear any existing interval
    if (this.stabilityCheckInterval) {
      clearInterval(this.stabilityCheckInterval);
    }

    // Run stability checks every 2 minutes
    this.stabilityCheckInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        return; // Don't check if not mining
      }

      this.performStabilityChecks();
    }, 120000); // 2 minutes

    console.log('[Orchestrator] Stability checks started (runs every 2 minutes)');
  }

  /**
   * Perform comprehensive stability checks and repairs
   * Detects and fixes various bad states
   */
  private performStabilityChecks(): void {
    const now = Date.now();
    let repairsMade = 0;
    let issuesFound = 0;
    const details: { staleAddresses?: number; stuckWorkers?: number; orphanedWorkers?: number; memoryLeaks?: number } = {};
    
    // Emit stability check start
    this.emit('stability_check', {
      type: 'stability_check',
      state: 'running',
      issuesFound: 0,
      repairsMade: 0,
      message: 'Running stability checks...',
    } as MiningEvent);

    // Check 1: Clean up stale paused addresses (for old challenges)
    const pausedAddressesToClean: string[] = [];
    for (const pausedKey of this.pausedAddresses) {
      // Extract address and challenge from key (format: "address:challengeId")
      const parts = pausedKey.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':'); // Handle challenge IDs with colons
        // If challenge changed, clean it up
        if (this.currentChallengeId !== challengeId || !this.currentChallengeId) {
          pausedAddressesToClean.push(pausedKey);
        }
      }
    }
    for (const key of pausedAddressesToClean) {
      this.pausedAddresses.delete(key);
      repairsMade++;
    }
    if (pausedAddressesToClean.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${pausedAddressesToClean.length} stale paused addresses`);
    }

    // Check 2: Clean up stale submitting addresses (for old challenges)
    const submittingAddressesToClean: string[] = [];
    for (const submittingKey of this.submittingAddresses) {
      const parts = submittingKey.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':');
        // If challenge changed, clean it up
        if (this.currentChallengeId !== challengeId || !this.currentChallengeId) {
          submittingAddressesToClean.push(submittingKey);
        }
      }
    }
    for (const key of submittingAddressesToClean) {
      this.submittingAddresses.delete(key);
      repairsMade++;
    }
    if (submittingAddressesToClean.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${submittingAddressesToClean.length} stale submitting addresses`);
      issuesFound += submittingAddressesToClean.length;
      if (!details.staleAddresses) details.staleAddresses = 0;
      details.staleAddresses += submittingAddressesToClean.length;
    }

    // Check 3: Clean up stale failure counters (for old challenges)
    const failureCountersToClean: string[] = [];
    for (const [key, count] of this.addressSubmissionFailures.entries()) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':');
        // If challenge changed, clean up old failure counters
        if (this.currentChallengeId !== challengeId || !this.currentChallengeId) {
          failureCountersToClean.push(key);
        }
      }
    }
    for (const key of failureCountersToClean) {
      this.addressSubmissionFailures.delete(key);
      repairsMade++;
    }
    if (failureCountersToClean.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${failureCountersToClean.length} stale failure counters`);
      issuesFound += failureCountersToClean.length;
      if (!details.staleAddresses) details.staleAddresses = 0;
      details.staleAddresses += failureCountersToClean.length;
    }

    // Check 4: Clean up stuck worker stats (workers in submitting state for > 5 minutes)
    // CRITICAL: Also verify worker count doesn't exceed configured value
    const stuckWorkers: number[] = [];
    const workerStatsCount = this.workerStats.size;
    const workerAssignmentCount = this.workerAddressAssignment.size;
    
    // CRITICAL: Log worker counts to detect duplication or memory leaks
    if (workerStatsCount > this.workerThreads * 2) {
      console.warn(`[Orchestrator] ⚠️  Worker stats count (${workerStatsCount}) exceeds 2x configured workers (${this.workerThreads})! Potential memory leak detected.`);
    }
    if (workerAssignmentCount > this.workerThreads * 2) {
      console.warn(`[Orchestrator] ⚠️  Worker assignment count (${workerAssignmentCount}) exceeds 2x configured workers (${this.workerThreads})! Potential memory leak detected.`);
    }
    
    for (const [workerId, workerData] of this.workerStats.entries()) {
      // CRITICAL: Verify worker ID doesn't exceed configured worker count (with margin for dev fee)
      // Dev fee uses worker IDs >= userWorkers (80% of total), so max should be workerThreads
      if (workerId >= this.workerThreads * 1.5) {
        console.warn(`[Orchestrator] ⚠️  Worker ID ${workerId} exceeds configured worker count (${this.workerThreads})! Cleaning up orphaned worker.`);
        stuckWorkers.push(workerId);
        repairsMade++;
        issuesFound++;
        details.orphanedWorkers = (details.orphanedWorkers || 0) + 1;
        continue;
      }
      
      // Check if worker is in a stuck state (submitting for > 5 minutes)
      if (workerData.status === 'submitting') {
        const timeSinceUpdate = now - workerData.lastUpdateTime;
        if (timeSinceUpdate > 5 * 60 * 1000) { // 5 minutes
          // Worker stuck in submitting state - reset to idle
          workerData.status = 'idle';
          workerData.lastUpdateTime = now;
          stuckWorkers.push(workerId);
          repairsMade++;
          issuesFound++;
          details.stuckWorkers = (details.stuckWorkers || 0) + 1;
        }
      }
      // Check if worker stats are for wrong challenge
      if (workerData.currentChallenge !== this.currentChallengeId && this.currentChallengeId) {
        // Worker stats are stale - mark for cleanup
        stuckWorkers.push(workerId);
      }
    }
    // CRITICAL FIX: Don't delete idle workers too aggressively - they need to be reusable!
    // Only clean up idle workers that have been idle for > 30 minutes (not 10 minutes)
    // This ensures workers are available for immediate reuse when new addresses need them
    for (const [workerId, workerData] of this.workerStats.entries()) {
      if (workerData.status === 'idle') {
        const timeSinceUpdate = now - workerData.lastUpdateTime;
        // Only delete if idle for > 30 minutes (increased from 10 minutes)
        // This prevents workers from being deleted when they're needed for new addresses
        if (timeSinceUpdate > 30 * 60 * 1000) { // 30 minutes
          this.workerStats.delete(workerId);
          // Also clean up assignment and stopped status
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          repairsMade++;
        }
      }
    }
    if (stuckWorkers.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Repaired ${stuckWorkers.length} stuck/orphaned worker stats`);
    }
    
    // CRITICAL: Aggressive cleanup of orphaned worker assignments
    const orphanedAssignments: number[] = [];
    for (const [workerId, address] of this.workerAddressAssignment.entries()) {
      // If worker ID exceeds configured count, it's orphaned
      if (workerId >= this.workerThreads * 1.5) {
        orphanedAssignments.push(workerId);
      } else if (!this.workerStats.has(workerId)) {
        // If worker stats don't exist, it's orphaned
        orphanedAssignments.push(workerId);
      }
    }
    for (const workerId of orphanedAssignments) {
      this.workerAddressAssignment.delete(workerId);
      this.stoppedWorkers.delete(workerId);
      repairsMade++;
    }
    if (orphanedAssignments.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${orphanedAssignments.length} orphaned worker assignments (exceeded configured count or no stats)`);
    }

    // Check 5: Clean up stale worker assignments (for old challenges or non-existent workers)
    const staleAssignments: number[] = [];
    for (const [workerId, address] of this.workerAddressAssignment.entries()) {
      // Check if worker exists in stats and is for current challenge
      const workerData = this.workerStats.get(workerId);
      if (!workerData || (workerData.currentChallenge !== this.currentChallengeId && this.currentChallengeId)) {
        staleAssignments.push(workerId);
      }
    }
    for (const workerId of staleAssignments) {
      this.workerAddressAssignment.delete(workerId);
      repairsMade++;
    }
    if (staleAssignments.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${staleAssignments.length} stale worker assignments`);
    }

    // Check 6: Clean up stopped workers that are no longer relevant
    // (workers that were stopped for a solution but challenge changed)
    const stoppedWorkersToClean: number[] = [];
    for (const workerId of this.stoppedWorkers) {
      const workerData = this.workerStats.get(workerId);
      // If worker doesn't exist or is for wrong challenge, clean it up
      if (!workerData || (workerData.currentChallenge !== this.currentChallengeId && this.currentChallengeId)) {
        stoppedWorkersToClean.push(workerId);
      }
    }
    for (const workerId of stoppedWorkersToClean) {
      this.stoppedWorkers.delete(workerId);
      repairsMade++;
    }
    if (stoppedWorkersToClean.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${stoppedWorkersToClean.length} stale stopped workers`);
    }

    // Check 7: Verify hash rate tracking is sane
    // If hash rate is being calculated but no hashes are being computed, reset
    const timeSinceLastHashUpdate = now - this.lastHashRateUpdate;
    if (timeSinceLastHashUpdate > 60 * 1000 && this.totalHashesComputed > 0) {
      // No hash updates in 1 minute but we have computed hashes - reset tracking
      console.log(`[Orchestrator] 🔧 Stability: Resetting hash rate tracking (stale update time)`);
      this.totalHashesComputed = 0;
      this.lastHashRateUpdate = now;
      repairsMade++;
    }

    // Check 8: Clean up submittedSolutions if it's getting too large (prevent memory leak)
    // CRITICAL FIX: More efficient cleanup - only when significantly over threshold
    if (this.submittedSolutions.size > this.submittedSolutionsMaxSize * 1.5) {
      // Remove oldest 50% of entries (more efficient: only convert to array once)
      const entriesToRemove = Math.floor(this.submittedSolutions.size / 2);
      const entriesArray = Array.from(this.submittedSolutions);
      // Delete in batches to avoid blocking
      let deleted = 0;
      for (let i = 0; i < entriesToRemove && i < entriesArray.length; i++) {
        this.submittedSolutions.delete(entriesArray[i]);
        deleted++;
      }
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${deleted} old submitted solutions (prevented memory leak, size: ${this.submittedSolutions.size})`);
      repairsMade++;
    }

    // Check 8b: Clean up stale worker stats (workers that haven't been active for > 10 minutes)
    // CRITICAL FIX: Prevent workerStats map from growing unbounded
    const staleWorkerStats: number[] = [];
    const tenMinutesAgo = now - (10 * 60 * 1000);
    for (const [workerId, workerData] of this.workerStats.entries()) {
      // If worker is idle and hasn't updated in 10 minutes, it's stale
      if (workerData.status === 'idle' && workerData.lastUpdateTime < tenMinutesAgo) {
        staleWorkerStats.push(workerId);
      }
      // Also clean up workers that are for old challenges
      if (workerData.currentChallenge !== this.currentChallengeId && this.currentChallengeId) {
        staleWorkerStats.push(workerId);
      }
    }
    for (const workerId of staleWorkerStats) {
      this.workerStats.delete(workerId);
      repairsMade++;
    }
    if (staleWorkerStats.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${staleWorkerStats.length} stale worker stats (prevented memory leak)`);
    }

    // Check 8c: Clean up cachedSubmissionKeys if it's getting too large
    const maxCachedKeys = 1000;
    if (this.cachedSubmissionKeys.size > maxCachedKeys * 1.5) {
      // Clear half of the cache (simple cleanup)
      const keysToRemove = Array.from(this.cachedSubmissionKeys.keys()).slice(0, Math.floor(this.cachedSubmissionKeys.size / 2));
      for (const key of keysToRemove) {
        this.cachedSubmissionKeys.delete(key);
      }
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${keysToRemove.length} cached submission keys (prevented memory leak)`);
      repairsMade++;
    }

    // Check 8d: Clean up addressSubmissionFailures for old challenges
    // Keep only failures for current challenge to prevent unbounded growth
    if (this.currentChallengeId) {
      const failuresToClean: string[] = [];
      for (const [key, _] of this.addressSubmissionFailures.entries()) {
        // Key format: "address:challengeId"
        if (!key.endsWith(`:${this.currentChallengeId}`)) {
          failuresToClean.push(key);
        }
      }
      for (const key of failuresToClean) {
        this.addressSubmissionFailures.delete(key);
        repairsMade++;
      }
      if (failuresToClean.length > 0) {
        console.log(`[Orchestrator] 🔧 Stability: Cleaned ${failuresToClean.length} old address submission failures (prevented memory leak)`);
      }
    }

    // Check 9: Verify currentMiningAddress is valid (if in single address mode)
    if (this.maxConcurrentAddresses === 1 && this.currentMiningAddress) {
      const addressExists = this.addresses.some(a => a.bech32 === this.currentMiningAddress);
      if (!addressExists) {
        console.log(`[Orchestrator] 🔧 Stability: Reset invalid currentMiningAddress`);
        this.currentMiningAddress = null;
        repairsMade++;
      }
    }

    // Check 10: Ensure solution timestamps don't grow unbounded
    const maxSolutionTimestamps = 10000; // Keep last 10k solutions
    if (this.solutionTimestamps.length > maxSolutionTimestamps) {
      // Remove oldest entries (keep most recent)
      const toRemove = this.solutionTimestamps.length - maxSolutionTimestamps;
      this.solutionTimestamps = this.solutionTimestamps.slice(toRemove);
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${toRemove} old solution timestamps (prevented memory leak)`);
      repairsMade++;
    }

    // Check 11: Verify cachedRegisteredAddresses is not too stale (> 5 minutes)
    const timeSinceCacheUpdate = now - this.lastRegisteredAddressesUpdate;
    if (timeSinceCacheUpdate > 5 * 60 * 1000) {
      // Cache is stale, invalidate it
      this.cachedRegisteredAddresses = null;
      this.lastRegisteredAddressesUpdate = 0;
      console.log(`[Orchestrator] 🔧 Stability: Invalidated stale registered addresses cache`);
      repairsMade++;
    }

    // Check 12: Clean up solvedAddressChallenges for old challenges (prevent unbounded growth)
    // Keep only challenges from current challenge to prevent memory leak
    const solvedAddressesToClean: string[] = [];
    for (const [address, solvedChallenges] of this.solvedAddressChallenges.entries()) {
      // We can't track timestamps per challenge, so we use a heuristic:
      // If this address has solved the current challenge, keep it
      // Otherwise, if it has many solved challenges (>10) and none are current, it's likely old - clean it up
      const hasCurrentChallenge = this.currentChallengeId && solvedChallenges.has(this.currentChallengeId);
      if (!hasCurrentChallenge && solvedChallenges.size > 10) {
        // Likely old challenges - clear the entire set for this address
        solvedAddressesToClean.push(address);
      } else if (!hasCurrentChallenge && solvedChallenges.size > 0 && this.currentChallengeId) {
        // Address has solved challenges but not current - clear old ones
        solvedChallenges.clear();
        repairsMade++;
      }
    }
    for (const address of solvedAddressesToClean) {
      this.solvedAddressChallenges.delete(address);
      repairsMade++;
    }
    if (solvedAddressesToClean.length > 0) {
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${solvedAddressesToClean.length} old solved address challenges (prevented memory leak)`);
    }

    // Check 13: Clean up cachedSubmissionKeys if it's getting too large (prevent unbounded growth)
    const maxCachedSubmissionKeys = 1000;
    if (this.cachedSubmissionKeys.size > maxCachedSubmissionKeys) {
      // Clear oldest 50% of entries (simple LRU-style cleanup)
      const entriesToRemove = Math.floor(this.cachedSubmissionKeys.size / 2);
      const entriesArray = Array.from(this.cachedSubmissionKeys.entries());
      for (let i = 0; i < entriesToRemove; i++) {
        this.cachedSubmissionKeys.delete(entriesArray[i][0]);
      }
      console.log(`[Orchestrator] 🔧 Stability: Cleaned ${entriesToRemove} old cached submission keys (prevented memory leak)`);
      repairsMade++;
    }

    // Check 14: Clean up addressSubmissionFailures for old challenges (prevent unbounded growth)
    // This is already done in Check 3, but add bounds checking as well
    const maxFailureCounters = 1000;
    if (this.addressSubmissionFailures.size > maxFailureCounters) {
      // Clear oldest 50% of entries (simple cleanup - keep only current challenge failures)
      const entriesToClean: string[] = [];
      for (const [key, count] of this.addressSubmissionFailures.entries()) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const challengeId = parts.slice(1).join(':');
          // Keep only failures for current challenge
          if (this.currentChallengeId !== challengeId && this.currentChallengeId) {
            entriesToClean.push(key);
          }
        }
      }
      // If still too large after cleaning old challenges, remove oldest entries
      if (this.addressSubmissionFailures.size > maxFailureCounters) {
        const entriesArray = Array.from(this.addressSubmissionFailures.entries());
        const toRemove = Math.floor((this.addressSubmissionFailures.size - maxFailureCounters) / 2);
        for (let i = 0; i < toRemove; i++) {
          this.addressSubmissionFailures.delete(entriesArray[i][0]);
        }
        repairsMade += toRemove;
      }
      for (const key of entriesToClean) {
        this.addressSubmissionFailures.delete(key);
        repairsMade++;
      }
      if (entriesToClean.length > 0 || this.addressSubmissionFailures.size > maxFailureCounters) {
        console.log(`[Orchestrator] 🔧 Stability: Cleaned address submission failures (prevented memory leak)`);
      }
    }

    // Check 15: Clean up old idle workers (been idle for > 5 minutes - more aggressive)
    // This was in Check 4, but we make it more aggressive here
    for (const [workerId, workerData] of this.workerStats.entries()) {
      if (workerData.status === 'idle') {
        const timeSinceUpdate = now - workerData.lastUpdateTime;
        if (timeSinceUpdate > 5 * 60 * 1000) { // 5 minutes (reduced from 10)
          this.workerStats.delete(workerId);
          // Also clear assignment and stopped status
          this.deleteWorkerAssignment(workerId);
          this.stoppedWorkers.delete(workerId);
          repairsMade++;
        }
      }
    }

    // Log summary if repairs were made
    // Emit stability check complete
    const message = repairsMade > 0 
      ? `Stability check complete: ${repairsMade} repairs made, ${issuesFound} issues found`
      : 'Stability check complete: No issues detected';
    
    this.emit('stability_check', {
      type: 'stability_check',
      state: 'complete',
      issuesFound,
      repairsMade,
      message,
      details: Object.keys(details).length > 0 ? details : undefined,
    } as MiningEvent);
    
    if (repairsMade > 0) {
      console.log(`[Orchestrator] ✓ Stability check complete: ${repairsMade} repairs made`);
    } else if (this.logLevel === 'debug') {
      console.log(`[Orchestrator] ✓ Stability check complete: No issues detected`);
    }
  }

  /**
   * CRITICAL FAILSAFE: Start automatic recovery mechanism
   * Detects when no workers are active (same logic as UI) and automatically restarts mining
   * This prevents the app from getting stuck in a state where all workers are idle
   * Uses the same detection logic as the UI's "No active workers" message
   * 
   * @param password - Wallet password for restarting mining
   * @param addressOffset - Address offset for restarting mining
   */
  private startAutomaticRecovery(password: string, addressOffset: number): void {
    // Clear any existing recovery check
    if (this.automaticRecoveryCheckInterval) {
      clearInterval(this.automaticRecoveryCheckInterval);
    }

    // Track when we first detected no active workers
    let noActiveWorkersStartTime: number | null = null;
    const NO_ACTIVE_WORKERS_THRESHOLD = 120000; // 2 minutes of no active workers before recovery

    // Check every 30 seconds for no active workers
    this.automaticRecoveryCheckInterval = setInterval(() => {
      if (!this.isRunning || !this.isMining) {
        // Reset tracking if not running
        noActiveWorkersStartTime = null;
        this.consecutiveRecoveryAttempts = 0;
        return;
      }

      const now = Date.now();

      // CRITICAL: Use the SAME logic as the UI to detect "No active workers"
      // The UI checks: workers.size === 0
      // We check: workerStats with status 'mining' or 'submitting' and updated recently
      let activeWorkerCount = 0;
      for (const [workerId, workerData] of this.workerStats.entries()) {
        // Worker is active if:
        // 1. Status is 'mining' or 'submitting' (not 'idle' or 'completed')
        // 2. Updated in the last 2 minutes (actually working, not stuck)
        if (workerData && (workerData.status === 'mining' || workerData.status === 'submitting')) {
          const timeSinceUpdate = now - workerData.lastUpdateTime;
          if (timeSinceUpdate < 120000) { // Updated in last 2 minutes
            activeWorkerCount++;
          }
        }
      }

      // Check if we have no active workers
      if (activeWorkerCount === 0) {
        // First time detecting no active workers - start tracking
        if (noActiveWorkersStartTime === null) {
          noActiveWorkersStartTime = now;
          console.warn(`[Orchestrator] ⚠️  FAILSAFE: No active workers detected (0/${this.workerThreads}). Monitoring for ${NO_ACTIVE_WORKERS_THRESHOLD / 1000}s before auto-recovery...`);
        } else {
          // We've been in no-active-workers state for a while
          const timeInNoWorkersState = now - noActiveWorkersStartTime;
          
          if (timeInNoWorkersState >= NO_ACTIVE_WORKERS_THRESHOLD) {
            // CRITICAL: Check cooldown and consecutive recovery limits
            const timeSinceLastRecovery = now - this.lastAutomaticRecovery;
            if (timeSinceLastRecovery < this.automaticRecoveryCooldown) {
              // Still in cooldown - wait
              return;
            }

            // Check consecutive recovery attempts to prevent infinite loops
            if (this.consecutiveRecoveryAttempts >= this.maxConsecutiveRecoveries) {
              // Too many consecutive recoveries - something is fundamentally wrong
              const timeSinceLastReset = now - this.lastRecoveryResetTime;
              if (timeSinceLastReset < this.recoveryResetWindow) {
                // Still within reset window - don't recover again
                console.error(`[Orchestrator] ❌ FAILSAFE: Max consecutive recoveries (${this.maxConsecutiveRecoveries}) reached. Waiting ${Math.ceil((this.recoveryResetWindow - timeSinceLastReset) / 1000)}s before allowing recovery again.`);
                this.emit('error', {
                  type: 'error',
                  message: `Automatic recovery disabled: ${this.maxConsecutiveRecoveries} consecutive recoveries failed. Manual intervention may be required.`,
                } as MiningEvent);
                return;
              } else {
                // Reset window passed - reset consecutive count and allow recovery
                console.log(`[Orchestrator] 🔄 FAILSAFE: Recovery reset window passed - resetting consecutive recovery count`);
                this.consecutiveRecoveryAttempts = 0;
                this.lastRecoveryResetTime = now;
              }
            }

            // Perform automatic recovery
            console.error(`[Orchestrator] 🚨 FAILSAFE TRIGGERED: No active workers for ${Math.floor(timeInNoWorkersState / 1000)}s. Performing automatic recovery (attempt ${this.consecutiveRecoveryAttempts + 1}/${this.maxConsecutiveRecoveries})...`);
            
            this.consecutiveRecoveryAttempts++;
            this.lastAutomaticRecovery = now;
            noActiveWorkersStartTime = null; // Reset tracking

            // Emit error event to notify UI
            this.emit('error', {
              type: 'error',
              message: `Automatic recovery triggered: No active workers detected. Restarting mining...`,
            } as MiningEvent);

            // Perform recovery: mimic stop/start behavior
            this.performAutomaticRecovery(password, addressOffset).catch((error: any) => {
              console.error(`[Orchestrator] ❌ FAILSAFE: Automatic recovery failed:`, error);
              this.emit('error', {
                type: 'error',
                message: `Automatic recovery failed: ${error.message}`,
              } as MiningEvent);
            });
          }
        }
      } else {
        // We have active workers - reset tracking
        if (noActiveWorkersStartTime !== null) {
          console.log(`[Orchestrator] ✓ FAILSAFE: Active workers restored (${activeWorkerCount}/${this.workerThreads}). Recovery not needed.`);
          noActiveWorkersStartTime = null;
          
          // Reset consecutive recovery count after successful mining period
          if (this.consecutiveRecoveryAttempts > 0) {
            const timeSinceLastRecovery = now - this.lastAutomaticRecovery;
            if (timeSinceLastRecovery >= this.recoveryResetWindow) {
              console.log(`[Orchestrator] ✓ FAILSAFE: Successful mining for ${Math.floor(timeSinceLastRecovery / 1000)}s - resetting consecutive recovery count`);
              this.consecutiveRecoveryAttempts = 0;
              this.lastRecoveryResetTime = now;
            }
          }
        }
      }
    }, 30000); // Check every 30 seconds

    console.log('[Orchestrator] ✅ Automatic recovery failsafe started (checks every 30s, triggers after 2min of no active workers)');
  }

  /**
   * Perform automatic recovery - mimics stop/start behavior
   * Clears all blocked state and restarts mining
   */
  private async performAutomaticRecovery(password: string, addressOffset: number): Promise<void> {
    console.log('[Orchestrator] 🔄 Performing automatic recovery: clearing blocked state and restarting mining...');

    // CRITICAL: Clear ALL blocked state (same as stop/start does)
    const failuresBefore = this.addressSubmissionFailures.size;
    const blockedBefore = this.lastMineAttempt.size;
    const pausedBefore = this.pausedAddresses.size;
    const submittingBefore = this.submittingAddresses.size;
    const assignmentsBefore = this.workerAddressAssignment.size;

    // Clear failure counters
    this.addressSubmissionFailures.clear();
    
    // Clear blocked addresses
    this.lastMineAttempt.clear();
    
    // Clear paused and submitting states
    this.pausedAddresses.clear();
    this.submittingAddresses.clear();
    
    // Clear worker assignments (workers will be reassigned)
    this.workerAddressAssignment.clear();
    this.addressToWorkers.clear();
    
    // Reset all workers to idle so they can be reused
    for (const [workerId, workerData] of this.workerStats.entries()) {
      if (workerData) {
        workerData.status = 'idle';
        workerData.lastUpdateTime = Date.now();
        workerData.addressIndex = -1;
        workerData.address = '';
      }
    }
    
    // Clear stopped workers set
    this.stoppedWorkers.clear();

    console.log(`[Orchestrator] 🔄 Recovery: Cleared ${failuresBefore} failures, ${blockedBefore} blocked, ${pausedBefore} paused, ${submittingBefore} submitting, ${assignmentsBefore} assignments`);

    // If mining is still running, the startMining loop will pick up the cleared addresses
    // We don't need to manually restart - the existing loop will handle it
    // But we do need to ensure isMining is true so the loop continues
    if (!this.isMining && this.isRunning && this.currentChallengeId) {
      console.log('[Orchestrator] 🔄 Recovery: Restarting mining loop...');
      // Restart mining loop
      this.startMining().catch((error: any) => {
        console.error(`[Orchestrator] ❌ Recovery: Failed to restart mining:`, error);
        throw error;
      });
    } else {
      console.log('[Orchestrator] ✓ Recovery: State cleared. Mining loop will pick up addresses automatically.');
    }

    // Emit recovery event using system_status
    this.emit('system_status', {
      type: 'system_status',
      state: 'running',
      message: `Automatic recovery completed: ${blockedBefore + pausedBefore + submittingBefore} blocked addresses cleared`,
      details: {
        recoveryPerformed: true,
        addressesUnblocked: blockedBefore + pausedBefore + submittingBefore,
      },
    } as MiningEvent);
  }

  /**
   * Clean up all state related to an old challenge ID
   * Called when challenge changes to prevent stale state
   */
  private cleanupStaleChallengeState(oldChallengeId: string | null): void {
    if (!oldChallengeId) return; // Nothing to clean if no old challenge

    let cleaned = 0;

    // Clean up paused addresses for old challenge
    const pausedToClean: string[] = [];
    for (const pausedKey of this.pausedAddresses) {
      const parts = pausedKey.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':');
        if (challengeId === oldChallengeId) {
          pausedToClean.push(pausedKey);
        }
      }
    }
    for (const key of pausedToClean) {
      this.pausedAddresses.delete(key);
      cleaned++;
    }

    // Clean up submitting addresses for old challenge
    const submittingToClean: string[] = [];
    for (const submittingKey of this.submittingAddresses) {
      const parts = submittingKey.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':');
        if (challengeId === oldChallengeId) {
          submittingToClean.push(submittingKey);
        }
      }
    }
    for (const key of submittingToClean) {
      this.submittingAddresses.delete(key);
      cleaned++;
    }

    // Clean up failure counters for old challenge
    const failuresToClean: string[] = [];
    for (const [key, count] of this.addressSubmissionFailures.entries()) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const challengeId = parts.slice(1).join(':');
        if (challengeId === oldChallengeId) {
          failuresToClean.push(key);
        }
      }
    }
    for (const key of failuresToClean) {
      this.addressSubmissionFailures.delete(key);
      cleaned++;
    }

    // Clean up worker stats for old challenge
    for (const [workerId, workerData] of this.workerStats.entries()) {
      if (workerData.currentChallenge === oldChallengeId) {
        // Reset worker to idle if it's not completed
        if (workerData.status !== 'completed') {
          workerData.status = 'idle';
          workerData.currentChallenge = null;
          cleaned++;
        }
      }
    }

    // Clean up worker assignments for old challenge
    const assignmentsToClean: number[] = [];
    for (const [workerId, address] of this.workerAddressAssignment.entries()) {
      const workerData = this.workerStats.get(workerId);
      if (workerData && workerData.currentChallenge === oldChallengeId) {
        assignmentsToClean.push(workerId);
      }
    }
    for (const workerId of assignmentsToClean) {
      this.workerAddressAssignment.delete(workerId);
      cleaned++;
    }

    // Clean up stopped workers for old challenge
    const stoppedToClean: number[] = [];
    for (const workerId of this.stoppedWorkers) {
      const workerData = this.workerStats.get(workerId);
      if (workerData && workerData.currentChallenge === oldChallengeId) {
        stoppedToClean.push(workerId);
      }
    }
    for (const workerId of stoppedToClean) {
      this.stoppedWorkers.delete(workerId);
      cleaned++;
    }

    if (cleaned > 0) {
      console.log(`[Orchestrator] 🔧 Challenge change: Cleaned ${cleaned} stale state entries for old challenge ${oldChallengeId.slice(0, 8)}...`);
    }
  }
}

// Singleton instance
// CRITICAL: Create singleton instance
export const miningOrchestrator = new MiningOrchestrator();

// CRITICAL FIX: Add global error handlers for unhandled promise rejections
if (typeof process !== 'undefined') {
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('[Orchestrator] Unhandled Promise Rejection:', reason);
    console.error('[Orchestrator] Promise:', promise);
    // Emit error event so UI can display it
    miningOrchestrator.emit('error', {
      type: 'error',
      message: `Unhandled promise rejection: ${reason?.message || String(reason)}`,
    } as MiningEvent);
  });
  
  process.on('uncaughtException', (error: Error) => {
    console.error('[Orchestrator] Uncaught Exception:', error);
    // Emit error event
    miningOrchestrator.emit('error', {
      type: 'error',
      message: `Uncaught exception: ${error.message}`,
    } as MiningEvent);
    // Don't exit - let the application handle it
  });
}

// Auto-startup: Trigger when orchestrator singleton is first created
// This runs automatically when the server starts (when the module is first imported)
// No web UI required - mining will start in the background
if (typeof window === 'undefined') {
  // Only run on server side
  setTimeout(() => {
    import('./auto-startup-server').then(({ autoStartMining }) => {
      console.log('[Orchestrator] Triggering server-side auto-startup...');
      autoStartMining().catch((error) => {
        console.error('[Orchestrator] Failed to auto-start mining:', error);
      });
    }).catch((error) => {
      console.error('[Orchestrator] Failed to import auto-startup module:', error);
    });
  }, 10000); // Wait 10 seconds for server to fully initialize and hash server to be ready
}
