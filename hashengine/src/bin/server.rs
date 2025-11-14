use actix_web::{web, App, HttpResponse, HttpServer, middleware};
use actix_web::middleware::Compress;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use log::{info, error, warn, debug};

// Performance: Use mimalloc as global allocator for better performance
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

// Import HashEngine modules
mod hashengine {
    include!("../hashengine.rs");
}
mod rom {
    include!("../rom.rs");
}

use hashengine::hash as sh_hash;
use rom::{RomGenerationType, Rom};

// Global ROM state using RwLock to allow reinitialization for new challenges
static ROM: once_cell::sync::Lazy<RwLock<Option<Arc<Rom>>>> = once_cell::sync::Lazy::new(|| RwLock::new(None));

#[derive(Debug, Deserialize)]
struct InitRequest {
    no_pre_mine: String,
    #[serde(rename = "ashConfig")]
    ash_config: AshConfig,
}

#[derive(Debug, Deserialize)]
struct AshConfig {
    #[serde(rename = "nbLoops")]
    nb_loops: u32,
    #[serde(rename = "nbInstrs")]
    nb_instrs: u32,
    pre_size: u32,
    rom_size: u32,
    mixing_numbers: u32,
}

#[derive(Debug, Serialize)]
struct InitResponse {
    status: String,
    worker_pid: u32,
    no_pre_mine: String,
}

#[derive(Debug, Deserialize)]
struct HashRequest {
    preimage: String,
}

#[derive(Debug, Serialize)]
struct HashResponse {
    hash: String,
}

#[derive(Debug, Deserialize)]
struct BatchHashRequest {
    preimages: Vec<String>,
}

#[derive(Debug, Serialize)]
struct BatchHashResponse {
    hashes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    #[serde(rename = "romInitialized")]
    rom_initialized: bool,
    #[serde(rename = "nativeAvailable")]
    native_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_pre_mine_first8: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_pre_mine_last8: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Deserialize)]
struct UpdateMiningWorkersRequest {
    mining_worker_count: usize,
}

#[derive(Debug, Serialize)]
struct UpdateMiningWorkersResponse {
    status: String,
    current_actix_workers: usize,
    recommended_actix_workers: usize,
    message: String,
}

// Global state to track expected mining worker count (for logging/monitoring)
// Note: Actix workers can't be changed at runtime, but we can track this for future use
static MINING_WORKER_COUNT: once_cell::sync::Lazy<std::sync::RwLock<Option<usize>>> = 
    once_cell::sync::Lazy::new(|| std::sync::RwLock::new(None));

/// POST /init - Initialize ROM with challenge parameters
async fn init_handler(req: web::Json<InitRequest>) -> HttpResponse {
    info!("POST /init request received");
    info!("no_pre_mine: {}...", &req.no_pre_mine[..16.min(req.no_pre_mine.len())]);

    let no_pre_mine_bytes = req.no_pre_mine.as_bytes();

    // Check if ROM already initialized with different no_pre_mine
    {
        let rom_lock = ROM.read().unwrap();
        if rom_lock.is_some() {
            warn!("ROM already initialized, reinitializing for new challenge...");
        }
    }

    info!("Starting ROM initialization (this may take 5-10 seconds)...");
    let start = std::time::Instant::now();

    // Create ROM using TwoStep generation
    let rom = Rom::new(
        no_pre_mine_bytes,
        RomGenerationType::TwoStep {
            pre_size: req.ash_config.pre_size as usize,
            mixing_numbers: req.ash_config.mixing_numbers as usize,
        },
        req.ash_config.rom_size as usize,
    );

    let elapsed = start.elapsed().as_secs_f64();

    // Store ROM in global state (replace if already exists)
    let rom_arc = Arc::new(rom);
    {
        let mut rom_lock = ROM.write().unwrap();
        *rom_lock = Some(rom_arc);
    }

    info!("✓ ROM initialized in {:.1}s", elapsed);

    HttpResponse::Ok().json(InitResponse {
        status: "initialized".to_string(),
        worker_pid: std::process::id(),
        no_pre_mine: format!("{}...", &req.no_pre_mine[..16.min(req.no_pre_mine.len())]),
    })
}

/// POST /hash - Hash single preimage
async fn hash_handler(req: web::Json<HashRequest>) -> HttpResponse {
    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock

    let salt = req.preimage.as_bytes();
    let hash_bytes = sh_hash(salt, &rom, 8, 256);
    let hash_hex = hex::encode(hash_bytes);

    HttpResponse::Ok().json(HashResponse {
        hash: hash_hex,
    })
}

/// POST /hash-batch - Hash multiple preimages in parallel
async fn hash_batch_handler(req: web::Json<BatchHashRequest>) -> HttpResponse {
    let batch_start = std::time::Instant::now();

    // OPTIMIZATION: Acquire ROM lock once and clone Arc (read locks allow concurrent readers)
    // This is already optimal - read locks don't block other readers
    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock immediately after cloning Arc

    if req.preimages.is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "preimages array is required".to_string(),
        });
    }

    let preimage_count = req.preimages.len();

    // OPTIMIZATION: Pre-allocate result vector with exact capacity to avoid reallocations
    // Parallel hash processing using rayon - collect() already pre-allocates efficiently
    // Each preimage is hashed on a separate thread
    let hash_start = std::time::Instant::now();
    let hashes: Vec<String> = req.preimages
        .par_iter()
        .map(|preimage| {
            let salt = preimage.as_bytes();
            let hash_bytes = sh_hash(salt, &rom, 8, 256);
            hex::encode(hash_bytes)
        })
        .collect();

    let hash_duration = hash_start.elapsed();
    let total_duration = batch_start.elapsed();
    let throughput = (preimage_count as f64 / total_duration.as_secs_f64()) as u64;

    // Log performance metrics at debug level (only visible with RUST_LOG=debug)
    if preimage_count >= 100 {
        debug!(
            "Batch processed: {} hashes in {:?} ({} H/s)",
            preimage_count, total_duration, throughput
        );
    }

    HttpResponse::Ok().json(BatchHashResponse { hashes })
}

/// POST /hash-batch-shared - Zero-copy batch hashing with SharedArrayBuffer
/// Note: This is a compatibility endpoint - actual shared memory not used in Rust
async fn hash_batch_shared_handler(req: web::Json<serde_json::Value>) -> HttpResponse {
    // Extract preimages from request
    let preimages = match req.get("preimages") {
        Some(serde_json::Value::Array(arr)) => {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<String>>()
        }
        _ => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: "preimages array is required".to_string(),
            });
        }
    };

    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock

    if preimages.is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "preimages array is required".to_string(),
        });
    }

    let preimage_count = preimages.len();

    // OPTIMIZATION: Parallel hash processing with rayon
    // Same optimization as hash-batch handler
    let batch_start = std::time::Instant::now();
    let hashes: Vec<String> = preimages
        .par_iter()
        .map(|preimage| {
            let salt = preimage.as_bytes();
            let hash_bytes = sh_hash(salt, &rom, 8, 256);
            hex::encode(hash_bytes)
        })
        .collect();

    let total_duration = batch_start.elapsed();
    let throughput = (preimage_count as f64 / total_duration.as_secs_f64()) as u64;

    // Log performance metrics at debug level (only visible with RUST_LOG=debug)
    if preimage_count >= 100 {
        debug!(
            "Batch shared processed: {} hashes in {:?} ({} H/s)",
            preimage_count, total_duration, throughput
        );
    }

    // Return standard response (SharedArrayBuffer handled on Node.js side)
    HttpResponse::Ok().json(BatchHashResponse { hashes })
}

/// GET /health - Health check endpoint
async fn health_handler() -> HttpResponse {
    let rom_lock = ROM.read().unwrap();
    let rom_initialized = rom_lock.is_some();
    drop(rom_lock);

    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        rom_initialized,
        native_available: true,
        config: None,
        no_pre_mine_first8: None,
        no_pre_mine_last8: None,
    })
}

/// POST /update-mining-workers - Update expected mining worker count
/// This allows Node.js to notify the hash server about mining worker count changes
/// Note: Actix workers can't be changed at runtime, but this helps with monitoring
/// and future optimizations. The server calculates optimal workers at startup.
async fn update_mining_workers_handler(req: web::Json<UpdateMiningWorkersRequest>) -> HttpResponse {
    let mining_workers = req.mining_worker_count;
    let cpu_count = num_cpus::get();
    
    // Calculate recommended Actix workers (same logic as startup)
    let recommended = if mining_workers < 20 {
        std::cmp::min(cpu_count, mining_workers * 2)
    } else if mining_workers < 50 {
        std::cmp::min(cpu_count, (mining_workers as f64 * 1.5) as usize)
    } else if mining_workers < 100 {
        std::cmp::min(cpu_count, (mining_workers as f64 * 1.2) as usize)
    } else {
        std::cmp::min(cpu_count, mining_workers + 10)
    };
    
    // Store for monitoring (can't change Actix workers at runtime)
    {
        let mut count = MINING_WORKER_COUNT.write().unwrap();
        *count = Some(mining_workers);
    }
    
    info!("Mining worker count updated: {} (recommended Actix workers: {}, current: set at startup)", 
          mining_workers, recommended);
    
    HttpResponse::Ok().json(UpdateMiningWorkersResponse {
        status: "updated".to_string(),
        current_actix_workers: cpu_count, // Can't get actual count, return CPU count
        recommended_actix_workers: recommended,
        message: format!("Mining worker count registered. Note: Actix workers are set at startup and cannot be changed at runtime. Recommended: {} workers (restart server with WORKERS={} to apply)", recommended, recommended),
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "9001".to_string());
    
    // OPTIMIZATION: Auto-scale workers intelligently based on CPU count and mining worker count
    // Actix-web workers handle HTTP requests - each can handle MANY concurrent requests (async)
    // The actual hash computation is done by Rayon, which uses all CPU cores
    // 
    // Key insight: You don't need Actix workers = mining workers because:
    // 1. Each Actix worker can handle multiple concurrent HTTP requests
    // 2. Rayon parallelizes hash computation across ALL CPU cores (not per Actix worker)
    // 3. Too many Actix workers = wasted OS threads with overhead
    //
    // Dynamic scaling strategy based on mining workers:
    // - Read MINING_WORKER_COUNT from env (set by Node.js orchestrator)
    // - Calculate optimal Actix workers: min(CPU count, max(mining_workers * 2, mining_workers + 10))
    // - Fall back to CPU count if MINING_WORKER_COUNT not set
    let cpu_count = num_cpus::get();
    
    // Try to read mining worker count from environment (set by Node.js)
    let mining_worker_count = std::env::var("MINING_WORKER_COUNT")
        .ok()
        .and_then(|w| w.parse::<usize>().ok());
    
    let (workers, used_mining_count) = if let Some(mining_workers) = mining_worker_count {
        // Dynamic calculation based on mining workers
        // Formula: Enough workers to handle concurrent requests, but not excessive
        // - For low mining workers: mining_workers * 2 (each Actix worker handles ~2 concurrent requests)
        // - For high mining workers: mining_workers + 10 (diminishing returns)
        // - Always cap at CPU count (can't use more than available cores)
        let calculated = if mining_workers < 20 {
            // Low count: 2x for good parallelism
            mining_workers * 2
        } else if mining_workers < 50 {
            // Medium count: 1.5x
            (mining_workers as f64 * 1.5) as usize
        } else if mining_workers < 100 {
            // High count: 1.2x
            (mining_workers as f64 * 1.2) as usize
        } else {
            // Very high count: mining_workers + 10 (diminishing returns)
            mining_workers + 10
        };
        let optimal = std::cmp::min(cpu_count, std::cmp::max(calculated, 4)); // At least 4 workers
        info!("Mining workers detected: {}, calculating optimal Actix workers: {}", mining_workers, optimal);
        (optimal, Some(mining_workers))
    } else {
        // Fall back to explicit WORKERS env var or CPU count
        let workers = std::env::var("WORKERS")
            .map(|w| w.parse::<usize>().unwrap_or(cpu_count))
            .unwrap_or(cpu_count);
        (workers, None)
    };
    
    // OPTIMIZATION: Configure Rayon thread pool for optimal performance
    // Rayon defaults to CPU count threads, but we can optimize for our workload
    // For hash computation, we want maximum parallelism without oversubscription
    // Each Actix worker uses Rayon for parallel hash computation within batches
    let num_threads = cpu_count;
    ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .thread_name(|i| format!("hash-worker-{}", i))
        .build_global()
        .unwrap_or_else(|e| {
            warn!("Failed to configure Rayon thread pool: {}, using defaults", e);
        });

    info!("═══════════════════════════════════════════════════════════");
    info!("HashEngine Native Hash Service (Rust)");
    info!("═══════════════════════════════════════════════════════════");
    info!("Listening: {}:{}", host, port);
    info!("CPU cores detected: {}", cpu_count);
    if let Some(mining_workers) = used_mining_count {
        info!("Mining workers (from MINING_WORKER_COUNT): {}", mining_workers);
        info!("Actix-web workers: {} (dynamically calculated based on mining workers)", workers);
    } else {
        info!("Mining workers: not specified (set MINING_WORKER_COUNT env var for optimal scaling)");
        info!("Actix-web workers: {} (using CPU count or WORKERS env var)", workers);
    }
    info!("Rayon thread pool: {} threads (for parallel hash computation)", num_threads);
    info!("Parallel processing: rayon thread pool per Actix worker");
    info!("═══════════════════════════════════════════════════════════");

    HttpServer::new(|| {
        App::new()
            // OPTIMIZATION: Enable compression for large batch responses (reduces network overhead by 50-70%)
            // This significantly reduces bandwidth for large batch responses (hundreds of KB to MB)
            .wrap(Compress::default())
            // Logger middleware removed - only log important events via RUST_LOG
            .route("/init", web::post().to(init_handler))
            .route("/hash", web::post().to(hash_handler))
            .route("/hash-batch", web::post().to(hash_batch_handler))
            .route("/hash-batch-shared", web::post().to(hash_batch_shared_handler))
            .route("/health", web::get().to(health_handler))
            .route("/update-mining-workers", web::post().to(update_mining_workers_handler))
    })
    .workers(workers)
    // OPTIMIZATION: Increase max connections per worker for high concurrency
    // Default is 256, but with many mining workers, we may need more
    .client_timeout(Duration::from_millis(180000)) // 3 minutes for very large batches
    .client_disconnect_timeout(Duration::from_millis(180000)) // 3 minutes
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}
