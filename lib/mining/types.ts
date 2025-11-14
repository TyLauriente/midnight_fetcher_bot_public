export interface Challenge {
  challenge_id: string;
  difficulty: string;
  no_pre_mine: string;
  latest_submission: string;
  no_pre_mine_hour: string;
}

export interface ChallengeResponse {
  code: 'before' | 'active' | 'after';
  challenge?: Challenge;
  starts_at?: string;
}

export interface MiningStats {
  active: boolean;
  challengeId: string | null;
  solutionsFound: number;
  registeredAddresses: number;
  totalAddresses: number;
  hashRate: number;
  uptime: number;
  startTime: number | null;
  cpuUsage: number; // CPU usage percentage (0-100)
  addressesProcessedCurrentChallenge: number; // How many addresses have processed the current challenge
  solutionsThisHour: number; // Solutions found in current hour
  solutionsPreviousHour: number; // Solutions found in previous hour
  solutionsToday: number; // Solutions found today (since midnight)
  solutionsYesterday: number; // Solutions found yesterday
  workerThreads: number; // Number of parallel mining threads
}

export interface SolutionEvent {
  type: 'solution';
  address: string;
  challengeId: string;
  preimage: string;
  timestamp: string;
}

export interface StatusEvent {
  type: 'status';
  active: boolean;
  challengeId: string | null;
}

export interface StatsEvent {
  type: 'stats';
  stats: MiningStats;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface MiningStartEvent {
  type: 'mining_start';
  address: string;
  addressIndex: number;
  challengeId: string;
}

export interface HashProgressEvent {
  type: 'hash_progress';
  address: string;
  addressIndex: number;
  hashesComputed: number;
  totalHashes: number;
}

export interface SolutionSubmitEvent {
  type: 'solution_submit';
  address: string;
  addressIndex: number;
  challengeId: string;
  nonce: string;
  preimage: string;
}

export interface SolutionResultEvent {
  type: 'solution_result';
  address: string;
  addressIndex: number;
  preimage?: string;
  success: boolean;
  message: string;
}

export interface RegistrationProgressEvent {
  type: 'registration_progress';
  addressIndex: number;
  address: string;
  current: number;
  total: number;
  success: boolean;
  message?: string;
}

export interface WorkerStats {
  workerId: number;
  addressIndex: number;
  address: string;
  hashesComputed: number;
  hashRate: number;
  solutionsFound: number;
  startTime: number;
  lastUpdateTime: number;
  lastHashRateUpdateTime?: number; // Track last hash rate update for incremental calculation
  status: 'idle' | 'mining' | 'submitting' | 'completed';
  currentChallenge: string | null;
}

export interface WorkerUpdateEvent {
  type: 'worker_update';
  workerId: number;
  addressIndex: number;
  address: string;
  hashesComputed: number;
  hashRate: number;
  solutionsFound: number;
  status: 'idle' | 'mining' | 'submitting' | 'completed';
  currentChallenge: string | null;
}

export interface SystemStatusEvent {
  type: 'system_status';
  state: 'initializing' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  substate?: string;
  message: string;
  progress?: number; // 0-100
  details?: {
    addressesLoaded?: number;
    addressesValidated?: boolean;
    workersConfigured?: number;
    workersActive?: number;
    batchSize?: number;
    challengeId?: string;
    registrationComplete?: boolean;
    hashRateBaseline?: number;
    hashRateCurrent?: number;
  };
}

export interface AddressValidationEvent {
  type: 'address_validation';
  stage: 'loading' | 'validating' | 'fixing' | 'complete' | 'error';
  message: string;
  progress?: number; // 0-100
  issues?: string[];
  addressesChecked?: number;
  addressesTotal?: number;
}

export interface WorkerDistributionEvent {
  type: 'worker_distribution';
  configured: number;
  effective: number;
  active: number;
  addressesInProgress: number;
  addressesWaiting: number;
  addressesRegistered: number;
  addressesTotal: number;
  mode: 'registration' | 'full';
  message: string;
}

export interface MiningStateEvent {
  type: 'mining_state';
  state: 'idle' | 'waiting_challenge' | 'mining' | 'submitting' | 'paused' | 'error';
  substate?: 'registration' | 'baseline_collection' | 'normal' | 'recovery' | 'stability_check';
  message: string;
  addressesAvailable?: number;
  addressesInProgress?: number;
  addressesWaitingRetry?: number;
  addressesSolved?: number;
  challengeId?: string;
}

export interface HashRateMonitoringEvent {
  type: 'hash_rate_monitoring';
  state: 'collecting_baseline' | 'monitoring' | 'dropped' | 'recovering' | 'stable';
  currentHashRate: number;
  baselineHashRate?: number;
  threshold?: number;
  dropPercentage?: number;
  message: string;
  timeRemaining?: number; // seconds until baseline complete
}

export interface StabilityCheckEvent {
  type: 'stability_check';
  state: 'running' | 'complete';
  issuesFound: number;
  repairsMade: number;
  message: string;
  details?: {
    staleAddresses?: number;
    stuckWorkers?: number;
    orphanedWorkers?: number;
    memoryLeaks?: number;
  };
}

export interface TechnicalMetricsEvent {
  type: 'technical_metrics';
  timestamp: number;
  workers: {
    totalConfigured: number;
    totalActive: number;
    totalIdle: number;
    totalMining: number;
    totalSubmitting: number;
    totalCompleted: number;
    byStatus: Record<string, number>;
  };
  threads: {
    totalInUse: number;
    maxAvailable: number;
    utilizationPercent: number;
  };
  failures: {
    totalSubmissionFailures: number;
    addressesWithFailures: number;
    averageFailuresPerAddress: number;
    maxFailuresForAnyAddress: number;
  };
  hashService: {
    timeoutCount: number;
    lastTimeout: number | null;
    adaptiveBatchSizeActive: boolean;
    currentBatchSize: number;
    baseBatchSize: number;
  };
  hashing: {
    totalHashesComputed: number;
    totalHashesPerWorker: Record<number, number>;
    averageHashesPerWorker: number;
  };
  addresses: {
    total: number;
    registered: number;
    unregistered: number;
    inProgress: number;
    waitingRetry: number;
    solved: number;
    failed: number;
  };
  performance: {
    cpuUsage: number;
    uptime: number;
    solutionsFound: number;
    solutionsPerHour: number;
  };
  memory: {
    workerStatsSize: number;
    addressAssignmentsSize: number;
    submittedSolutionsSize: number;
    pausedAddressesSize: number;
    submittingAddressesSize: number;
  };
}

export type MiningEvent = SolutionEvent | StatusEvent | StatsEvent | ErrorEvent | MiningStartEvent | HashProgressEvent | SolutionSubmitEvent | SolutionResultEvent | RegistrationProgressEvent | WorkerUpdateEvent | SystemStatusEvent | AddressValidationEvent | WorkerDistributionEvent | MiningStateEvent | HashRateMonitoringEvent | StabilityCheckEvent | TechnicalMetricsEvent;
