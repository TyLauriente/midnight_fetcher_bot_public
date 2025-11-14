import { NextResponse } from 'next/server';
import * as os from 'os';
import { execSync } from 'child_process';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

/**
 * Get CPU core count, trying to detect physical cores on Linux
 * Falls back to logical cores if detection fails
 */
function getCpuCoreCount(platform: string): { logical: number; physical: number | null } {
  const cpus = os.cpus();
  const logicalCores = cpus.length;
  
  // Try to get physical cores on Linux
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
              return { logical: logicalCores, physical: physicalCores };
            }
          } else {
            return { logical: logicalCores, physical: physicalCores };
          }
        }
      } catch (lscpuErr) {
        // lscpu not available, continue with other methods
      }
      
      // Method 2: Check /proc/cpuinfo for physical cores
      // Count UNIQUE physical IDs (not total count)
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
              return { logical: logicalCores, physical: physicalCores };
            }
          }
        }
      } catch (cpuinfoErr) {
        // Continue to next method
      }
      
      // Method 3: Count unique core IDs (fallback)
      try {
        const coreIds = execSync('grep "^core id" /proc/cpuinfo | sort -u | wc -l', { encoding: 'utf8' }).trim();
        const physicalCores = parseInt(coreIds) || null;
        if (physicalCores && physicalCores > 0 && physicalCores <= logicalCores) {
          return { logical: logicalCores, physical: physicalCores };
        }
      } catch (coreIdErr) {
        // Fall through to default
      }
    } catch (err) {
      // If all methods fail, fall back to logical cores
      console.warn('[System Specs] Failed to detect physical cores on Linux:', err);
    }
  }
  
  // Default: return logical cores, physical unknown
  return { logical: logicalCores, physical: null };
}

/**
 * System Specs API - Returns hardware specifications for scaling recommendations
 */
export async function GET() {
  try {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const platform = os.platform();
    const arch = os.arch();
    const loadAvg = os.loadavg();

    // Get CPU info with improved detection
    const cpuModel = cpus[0]?.model || 'Unknown';
    const { logical: logicalCores, physical: physicalCores } = getCpuCoreCount(platform);
    // CRITICAL FIX: For mining, use LOGICAL cores (not physical) to maximize performance
    // Hyperthreading provides real performance benefits for mining workloads
    // Physical cores are useful for recommendations, but logical cores are what we can actually use
    // Only use physical if logical detection failed
    const cpuCount = logicalCores > 0 ? logicalCores : (physicalCores !== null ? physicalCores : cpus.length);
    const cpuSpeed = cpus[0]?.speed || 0;

    // Calculate memory in GB
    const totalMemoryGB = (totalMemory / (1024 ** 3)).toFixed(2);
    const freeMemoryGB = (freeMemory / (1024 ** 3)).toFixed(2);
    const usedMemoryGB = ((totalMemory - freeMemory) / (1024 ** 3)).toFixed(2);
    const memoryUsagePercent = (((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1);

    // Get current configuration from orchestrator
    const currentConfig = miningOrchestrator.getCurrentConfiguration();

    // Calculate recommendations
    const recommendations = calculateRecommendations({
      cpuCount,
      cpuSpeed,
      totalMemoryGB: parseFloat(totalMemoryGB),
      platform,
      currentWorkerThreads: currentConfig.workerThreads,
      currentBatchSize: currentConfig.batchSize,
    });

    return NextResponse.json({
      success: true,
      specs: {
        cpu: {
          model: cpuModel,
          cores: cpuCount,
          logicalCores: logicalCores,
          physicalCores: physicalCores,
          speed: cpuSpeed,
          loadAverage: loadAvg,
        },
        memory: {
          total: totalMemoryGB,
          free: freeMemoryGB,
          used: usedMemoryGB,
          usagePercent: memoryUsagePercent,
        },
        system: {
          platform,
          arch,
          uptime: os.uptime(),
        },
      },
      recommendations,
    });
  } catch (error: any) {
    console.error('[System Specs API] Failed to get system specs:', error.message);

    return NextResponse.json({
      success: false,
      error: 'Failed to retrieve system specifications',
      specs: null,
      recommendations: null,
    }, { status: 500 });
  }
}

/**
 * Calculate optimal BATCH_SIZE and workerThreads based on system specs
 */
function calculateRecommendations(specs: {
  cpuCount: number;
  cpuSpeed: number;
  totalMemoryGB: number;
  platform: string;
  currentWorkerThreads: number;
  currentBatchSize: number;
}) {
  const { cpuCount, cpuSpeed, totalMemoryGB, currentWorkerThreads, currentBatchSize } = specs;

  // Worker threads recommendation
  // Rule: Use 80% of CPU cores to leave headroom for OS and other processes
  // Absolute maximum: 1024 (matches API limit, but practical max is usually much lower)
  const ABSOLUTE_MAX_WORKERS = 1024;

  // Calculate max workers based on CPU count
  // For systems with hyperthreading, we can use up to logical core count
  // But we'll recommend based on physical cores for stability
  let maxWorkers: number;
  if (cpuCount >= 64) {
    maxWorkers = Math.min(ABSOLUTE_MAX_WORKERS, Math.floor(cpuCount * 0.9)); // 90% for very high-end (64+ cores)
  } else if (cpuCount >= 32) {
    maxWorkers = Math.min(ABSOLUTE_MAX_WORKERS, Math.floor(cpuCount * 0.85)); // 85% for high-end (32+ cores)
  } else if (cpuCount >= 16) {
    maxWorkers = Math.min(ABSOLUTE_MAX_WORKERS, Math.floor(cpuCount * 0.8)); // 80% for high-end (16+ cores)
  } else if (cpuCount >= 8) {
    maxWorkers = Math.floor(cpuCount * 0.75); // 75% for mid-range (8+ cores)
  } else if (cpuCount >= 4) {
    maxWorkers = Math.max(4, cpuCount - 1); // Leave 1 core free for low-end (4+ cores)
  } else {
    maxWorkers = Math.max(1, cpuCount); // Use all cores for very low-end (<4 cores)
  }

  // Optimal workers (recommended for best balance of performance and stability)
  let optimalWorkers: number;
  if (cpuCount >= 24) {
    optimalWorkers = Math.floor(cpuCount * 0.67); // ~67% for very high-end (16 workers for 24 cores)
  } else if (cpuCount >= 16) {
    optimalWorkers = Math.floor(cpuCount * 0.7); // 70% for high-end (11 workers for 16 cores)
  } else if (cpuCount >= 8) {
    optimalWorkers = Math.floor(cpuCount * 0.65); // 65% for mid-range (5-6 workers for 8 cores)
  } else if (cpuCount >= 4) {
    optimalWorkers = Math.max(2, cpuCount - 2); // Leave 2 cores free for low-end
  } else {
    optimalWorkers = Math.max(1, Math.floor(cpuCount * 0.5)); // 50% for very low-end
  }

  // Conservative workers (for systems with other workloads running)
  const conservativeWorkers = Math.max(2, Math.floor(cpuCount * 0.5));

  // Ensure optimal is never higher than max
  optimalWorkers = Math.min(optimalWorkers, maxWorkers);

  // Ensure conservative is never higher than optimal
  const finalConservativeWorkers = Math.min(conservativeWorkers, optimalWorkers);

  // Batch size recommendation
  // Rule: Larger batches = fewer API calls but more memory usage
  // Base on CPU speed and memory
  // Maximum allowed: 50,000 (matches API limit)
  const ABSOLUTE_MAX_BATCH_SIZE = 50000;
  
  let optimalBatchSize = 300; // Default
  let maxBatchSize = ABSOLUTE_MAX_BATCH_SIZE; // Allow up to API limit
  let conservativeBatchSize = 200;

  // Adjust optimal and conservative based on CPU cores and speed
  // But max is always 50,000 to allow users to go higher if needed
  if (cpuCount >= 12 && cpuSpeed >= 2500 && totalMemoryGB >= 16) {
    // High-end system
    optimalBatchSize = 400;
    conservativeBatchSize = 300;
  } else if (cpuCount >= 8 && cpuSpeed >= 2000 && totalMemoryGB >= 8) {
    // Mid-range system
    optimalBatchSize = 350;
    conservativeBatchSize = 250;
  } else if (cpuCount >= 4 && totalMemoryGB >= 4) {
    // Entry-level system
    optimalBatchSize = 250;
    conservativeBatchSize = 150;
  } else {
    // Low-end system
    optimalBatchSize = 150;
    conservativeBatchSize = 100;
  }

  // System tier classification
  let systemTier: 'low-end' | 'entry-level' | 'mid-range' | 'high-end';
  if (cpuCount >= 12 && totalMemoryGB >= 16) {
    systemTier = 'high-end';
  } else if (cpuCount >= 8 && totalMemoryGB >= 8) {
    systemTier = 'mid-range';
  } else if (cpuCount >= 4 && totalMemoryGB >= 4) {
    systemTier = 'entry-level';
  } else {
    systemTier = 'low-end';
  }

  return {
    systemTier,
    workerThreads: {
      current: currentWorkerThreads,
      optimal: optimalWorkers,
      conservative: finalConservativeWorkers,
      max: maxWorkers,
      explanation: `Based on ${cpuCount} CPU cores. Optimal uses ~${Math.round((optimalWorkers / cpuCount) * 100)}% of cores, leaving headroom for OS tasks.`,
    },
    batchSize: {
      current: currentBatchSize,
      optimal: optimalBatchSize,
      conservative: conservativeBatchSize,
      max: maxBatchSize,
      explanation: `Larger batches reduce API calls but increase memory usage. Optimal based on ${cpuCount} cores, ${cpuSpeed}MHz CPU, and ${totalMemoryGB}GB RAM.`,
    },
    warnings: generateWarnings(specs, optimalWorkers, optimalBatchSize),
    performanceNotes: [
      'Worker threads should not exceed CPU core count to avoid context switching overhead',
      'Batch size affects hash computation time and memory usage',
      'Monitor CPU usage and hash rate to fine-tune these values',
      'If you see 408 timeouts, reduce batch size',
      'If CPU usage is low, increase worker threads',
    ],
  };
}

/**
 * Generate warnings based on system specs
 */
function generateWarnings(
  specs: { cpuCount: number; cpuSpeed: number; totalMemoryGB: number; platform: string },
  optimalWorkers: number,
  optimalBatchSize: number
): string[] {
  const warnings: string[] = [];

  if (specs.totalMemoryGB < 4) {
    warnings.push('⚠️ Low memory detected. Consider reducing batch size to avoid out-of-memory errors.');
  }

  if (specs.cpuCount < 4) {
    warnings.push('⚠️ Limited CPU cores. Mining performance may be limited. Consider using conservative settings.');
  }

  if (specs.cpuSpeed < 2000) {
    warnings.push('⚠️ Low CPU clock speed. May experience slower hash rates. Consider reducing batch size.');
  }

  if (specs.totalMemoryGB >= 32 && specs.cpuCount >= 16) {
    warnings.push('✅ High-performance system detected. You can push settings higher for maximum throughput.');
  }

  if (optimalWorkers > 12) {
    warnings.push('💡 System has many cores. Consider testing with max worker threads for optimal performance.');
  }

  return warnings;
}
