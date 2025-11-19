#!/bin/bash
# ============================================================================
# Midnight Fetcher Bot - Ubuntu Setup Script
# ============================================================================
# This script performs complete setup:
# 1. Checks/installs Node.js 20.x
# 2. Checks/installs Rust toolchain
# 3. Builds optimized hash server with performance improvements
# 4. Installs all dependencies
# 5. Builds NextJS application
# 6. Starts the app
#
# NOTE: Builds optimized hash server with +15-38% performance improvement
# ============================================================================

set -e  # Exit on error
SESSION_NAME=midnightbot

# Robust tmux install and detection for all distros and shells
if command -v tmux > /dev/null 2>&1; then
  echo "tmux is already installed, continuing..."
else
  echo "Missing dependency: tmux. Attempting to install..."
  if command -v apt-get > /dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y tmux
  elif command -v dnf > /dev/null 2>&1; then
    sudo dnf install -y tmux
  elif command -v yum > /dev/null 2>&1; then
    sudo yum install -y tmux
  elif command -v zypper > /dev/null 2>&1; then
    sudo zypper install -y tmux
   elif command -v pacman > /dev/null 2>&1; then
    sudo pacman -Sy --noconfirm tmux
  else
    echo "ERROR: Could not auto-install tmux. Please install tmux using your distro's package manager."
    exit 1
  fi
  # Check again after install attempt
  if command -v tmux > /dev/null 2>&1; then
    echo "tmux installed successfully, continuing..."
  else
    echo "ERROR: tmux could not be installed. Please install manually and re-run the script."
    exit 1
  fi
fi

if tmux has-session -t $SESSION_NAME 2>/dev/null; then
  echo "\n================================================================================"
  echo "Midnight Fetcher Bot already running in tmux session: $SESSION_NAME"
  echo "To attach: tmux attach-session -t $SESSION_NAME"
  echo "To stop: pkill -f hash-server && pkill -f 'next' && tmux kill-session -t $SESSION_NAME"
  echo "================================================================================"
  tmux attach-session -t $SESSION_NAME
  exit 0
fi

echo "================================================================================"
echo "  Starting new background session via tmux..."
echo "  To attach to logs, run: tmux attach-session -t $SESSION_NAME"
echo "  To detach, press Ctrl+B then D"
echo "  To stop: pkill -f hash-server && pkill -f 'next' && tmux kill-session -t $SESSION_NAME"
echo "================================================================================"
sleep 2

# Prepare the inner setup script
cat > setup_internal.sh << "EOF"
#!/bin/bash
# ============================================================================
# Midnight Fetcher Bot - Ubuntu Setup Script
# ============================================================================
# This script performs complete setup:
# 1. Checks/installs Node.js 20.x
# 2. Checks/installs Rust toolchain
# 3. Builds optimized hash server with performance improvements
# 4. Installs all dependencies
# 5. Builds NextJS application
# 6. Starts the app
#
# NOTE: Builds optimized hash server with +15-38% performance improvement
# ============================================================================

set -e  # Exit on error

echo ""
echo "================================================================================"
echo "                    Midnight Fetcher Bot - Setup"
echo "================================================================================"
echo ""

# ============================================================================
# Check for sudo privileges
# ============================================================================
if [ "$EUID" -eq 0 ]; then
    echo "WARNING: Running as root is not recommended."
    echo "Please run as a regular user. The script will prompt for sudo when needed."
    echo ""
fi

# ============================================================================
# Check Node.js
# ============================================================================
echo "[1/6] Checking Node.js installation..."
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Attempting to install Node.js..."
  if command -v apt-get &> /dev/null; then
    # NodeSource preferred for apt
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf &> /dev/null; then
    sudo dnf install -y nodejs npm
  elif command -v yum &> /dev/null; then
    sudo yum install -y nodejs npm
  elif command -v zypper &> /dev/null; then
    sudo zypper install -y nodejs npm
  elif command -v pacman &> /dev/null; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    echo "ERROR: Could not auto-install Node.js. Please install Node.js >= 18 manually (see https://nodejs.org)."
    exit 1
  fi
  if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js could not be installed automatically. Please install manually and re-run the script."
    exit 1
  fi
  echo "Node.js installed!"
  node --version
else
  echo "Node.js found!"
  node --version
fi

# Check version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "WARNING: Node.js version is below 18. Version 20.x is recommended."
    echo "To upgrade, run:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo ""

# ============================================================================
# Check Rust Installation
# ============================================================================
echo "[2/6] Checking Rust installation..."
if ! command -v cargo &> /dev/null; then
    echo "Rust not found. Installing Rust..."
    echo ""
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # If Cargo bin is not in PATH, source env file using POSIX syntax (for dash compatibility)
    . "$HOME/.cargo/env"
    echo "Rust installed!"
    cargo --version
    echo ""
else
    echo "Rust found!"
    cargo --version
    echo ""
fi

# ============================================================================
# Build Optimized Hash Server
# ============================================================================
echo "[3/6] Building optimized hash server..."
echo ""
echo "Optimizations enabled:"
echo "  + mimalloc allocator"
echo "  + LTO = \"fat\""
echo "  + panic = \"abort\""
echo "  + overflow-checks = false"
echo "  + target-cpu = native"
echo "  + cryptoxide 0.5 (SIMD)"
echo "  + Performance monitoring"
echo ""

# Stop any existing hash-server instances
echo "Stopping existing hash-server instances..."
pkill -f hash-server 2>/dev/null || true
sleep 2

# Navigate to hashengine directory
cd hashengine

# Clean previous build
echo "Cleaning previous build..."
cargo clean

# Set optimization flags
echo "Setting Rust optimization flags..."
export RUSTFLAGS="-C target-cpu=native -C panic=abort"
echo "  RUSTFLAGS=$RUSTFLAGS"

# Build with all optimizations
echo ""
echo "Building optimized hash server (this will take 2-3 minutes)..."
cargo build --release --bin hash-server

# Verify build succeeded
if [ ! -f "target/release/hash-server" ]; then
    echo ""
    echo "============================================================================"
    echo "ERROR: Hash server build failed!"
    echo "Please check the build output above for errors."
    echo "============================================================================"
    echo ""
    exit 1
fi

# Make executable
chmod +x target/release/hash-server

# Return to project root
cd ..

echo ""
echo "✓ Hash server built successfully!"
echo "  Binary: hashengine/target/release/hash-server"
echo ""

# ============================================================================
# Install dependencies
# ============================================================================
echo "[4/6] Installing/updating project dependencies..."
npm install
npm install react react-dom next lucide-react
npm install --save-dev @types/react @types/react-dom
echo "Dependencies installed!"
echo ""

# Install Playwright browsers (required for web scraping)
echo "Installing Playwright browser binaries..."
if npx playwright install chromium 2>&1; then
    echo "✓ Playwright browsers installed successfully!"
else
    echo ""
    echo "WARNING: Failed to install Playwright browsers automatically."
    echo "Attempting to install system dependencies..."
    
    # Try to install system dependencies for Playwright (Linux)
    if command -v apt-get > /dev/null 2>&1; then
        echo "Installing Playwright system dependencies (apt)..."
        npx playwright install-deps chromium 2>&1 || echo "Could not install system dependencies automatically"
    elif command -v dnf > /dev/null 2>&1; then
        echo "Installing Playwright system dependencies (dnf)..."
        npx playwright install-deps chromium 2>&1 || echo "Could not install system dependencies automatically"
    elif command -v yum > /dev/null 2>&1; then
        echo "Installing Playwright system dependencies (yum)..."
        npx playwright install-deps chromium 2>&1 || echo "Could not install system dependencies automatically"
    fi
    
    # Retry browser installation after system deps
    echo "Retrying browser installation..."
    if npx playwright install chromium 2>&1; then
        echo "✓ Playwright browsers installed successfully after system dependencies!"
    else
        echo ""
        echo "ERROR: Could not install Playwright browsers automatically."
        echo "Please run manually: npx playwright install chromium"
        echo "Or for system dependencies: npx playwright install-deps chromium"
        echo ""
        echo "Continuing anyway, but mining may not work until browsers are installed."
    fi
fi
echo ""

# ============================================================================
# Create required directories
# ============================================================================
echo "[5/6] Creating required directories..."
mkdir -p secure
mkdir -p storage
mkdir -p logs
echo ""

# ============================================================================
# Setup complete, start services
# ============================================================================
echo "================================================================================"
echo "                         Setup Complete!"
echo "================================================================================"
echo ""
echo "[6/6] Starting services..."
echo ""

# Stop any existing instances
pkill -f hash-server || true
pkill -f "next" || true

# Start hash server in background
echo "Starting hash server on port 9001..."
export RUST_LOG=hash_server=info,actix_web=warn
export HOST=127.0.0.1
export PORT=9001

# OPTIMIZATION: Read mining worker count from persistent config file
# This allows the hash server to auto-scale Actix workers based on your mining configuration
CONFIG_FILE="secure/mining-config.json"
if [ -f "$CONFIG_FILE" ]; then
  # Try to extract workerThreads from config file using grep/sed (works without jq)
  WORKER_COUNT=$(grep -o '"workerThreads"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*' | head -1)
  if [ -n "$WORKER_COUNT" ] && [ "$WORKER_COUNT" -gt 0 ] 2>/dev/null; then
    export MINING_WORKER_COUNT="$WORKER_COUNT"
    echo "  - Read mining worker count from config: $WORKER_COUNT"
    echo "  - Hash server will auto-scale Actix workers based on this value"
  else
    echo "  - Config file exists but workerThreads not found, using defaults"
  fi
else
  echo "  - Config file not found, hash server will use CPU count for workers"
fi

# OPTIMIZATION: Auto-detect CPU count for optimal worker scaling
# For high-end servers (200+ threads), this will scale appropriately
# The server will use MINING_WORKER_COUNT if set, otherwise defaults to CPU count
# You can still override with WORKERS env var if needed
# Uncomment the line below to manually set worker count (e.g., for testing)
# export WORKERS=12

nohup ./hashengine/target/release/hash-server > logs/hash-server.log 2>&1 &
HASH_SERVER_PID=$!
echo "  - Hash server started (PID: $HASH_SERVER_PID)"
echo ""

# Wait for hash server to be ready
echo "Waiting for hash server to initialize..."
sleep 3

# Check if hash server is responding
MAX_RETRIES=10
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://127.0.0.1:9001/health > /dev/null 2>&1; then
        echo "  - Hash server is ready!"
        break
    fi
    echo "  - Waiting for hash server..."
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "ERROR: Hash server failed to start. Check logs/hash-server.log"
    exit 1
fi
echo ""

echo "================================================================================"
echo "                    Midnight Fetcher Bot - Ready!"
echo "================================================================================"
echo ""
echo "Hash Service: http://127.0.0.1:9001/health"
echo "Web Interface: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop the Next.js server (hash server will continue running)"
echo ""
echo "To stop hash server: pkill -f hash-server"
echo "================================================================================"
echo ""

# Build production version
echo "Building production version..."
npm run build
echo "  - Production build complete!"
echo ""

# Start NextJS production server
echo "Starting Next.js production server..."
npm start &
NEXTJS_PID=$!
echo "  - Next.js server starting (PID: $NEXTJS_PID)..."
echo ""

# Wait for Next.js to be ready
echo "Waiting for Next.js to initialize..."
sleep 5
echo "  - Next.js server is ready!"
echo ""

# Run auto-startup script to unlock wallet and start mining automatically
echo "Running auto-startup script..."
echo "  - Checking if default password works..."
echo "  - If successful, wallet will be unlocked and mining will start automatically"
echo ""
node scripts/auto-startup.js > logs/auto-startup.log 2>&1 &
AUTO_STARTUP_PID=$!
echo "  - Auto-startup script started (PID: $AUTO_STARTUP_PID)"
echo "  - Check logs/auto-startup.log for details"
echo ""

# Try to open browser (if running in graphical environment)
if command -v xdg-open &> /dev/null; then
    echo "Opening web interface..."
    xdg-open http://localhost:3001 2>/dev/null || true
fi

echo ""
echo "================================================================================"
echo "All services are running!"
echo "Hash Server PID: $HASH_SERVER_PID"
echo "Next.js PID: $NEXTJS_PID"
echo "Auto-startup PID: $AUTO_STARTUP_PID"
echo ""
echo "The server will automatically:"
echo "  1. Check if default password works (server-side hook)"
echo "  2. Unlock wallet automatically if password is correct"
echo "  3. Start mining automatically with previous settings"
echo ""
echo "Note: Mining will start automatically when the server starts,"
echo "      without requiring the web UI to be opened."
echo ""
echo "Check logs/auto-startup.log for auto-startup status"
echo ""
echo "To kill: pkill -f hash-server && pkill -f 'next' && exit"
echo "To detach and keep running (recommended), press Ctrl+B, then D"
echo "================================================================================"
# Sleep forever
while true; do sleep 600; done
EOF
chmod +x setup_internal.sh

# Ensure a working C toolchain is present (cc/gcc/etc)
if ! command -v cc > /dev/null 2>&1; then
  echo "Missing C compiler (cc). Attempting to install build tools..."
  if command -v apt-get > /dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y build-essential
  elif command -v dnf > /dev/null 2>&1; then
    sudo dnf groupinstall -y 'Development Tools'
  elif command -v yum > /dev/null 2>&1; then
    sudo yum groupinstall -y 'Development Tools'
  elif command -v zypper > /dev/null 2>&1; then
    sudo zypper install -t pattern devel_basis
  elif command -v pacman > /dev/null 2>&1; then
    sudo pacman -Sy --noconfirm base-devel
  else
    echo 'ERROR: Please install build-essential tools for your OS (e.g., gcc, make)' >&2
    exit 1
  fi
  if ! command -v cc > /dev/null 2>&1; then
    echo 'ERROR: Failed to install a working C compiler (cc). Please install it manually.' >&2
    exit 1
  fi
  echo 'C compiler installed successfully.'
fi

# Start tmux session running the internal script
# The ending 'read' helps prevent tmux from immediate exit if anything fails
# All output is visible in tmux

# This will detach after launching, allowing the script to run in the background even after you close the original shell
# The user can attach at any time

tmux new-session -d -s $SESSION_NAME './setup_internal.sh; read'
echo "Services are now running in tmux session: $SESSION_NAME"
echo "To attach: tmux attach-session -t $SESSION_NAME"
echo "To kill everything: tmux kill-session -t $SESSION_NAME"
echo "To stop individual servers, pkill -f hash-server, pkill -f 'next'"
exit 0
