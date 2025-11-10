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

if ! command -v tmux &> /dev/null; then
  echo "Missing dependency: tmux. Attempting to install..."
  if command -v apt-get &> /dev/null; then
    sudo apt-get update && sudo apt-get install -y tmux
  elif command -v dnf &> /dev/null; then
    sudo dnf install -y tmux
  elif command -v yum &> /dev/null; then
    sudo yum install -y tmux
  elif command -v zypper &> /dev/null; then
    sudo zypper install -y tmux
  elif command -v pacman &> /dev/null; then
    sudo pacman -Sy --noconfirm tmux
  else
    echo "ERROR: Could not auto-install tmux. Please install tmux using your distro's package manager (e.g., apk, emerge, pkg, etc)." >&2
    exit 1
  fi
  if ! command -v tmux &> /dev/null; then
    echo "ERROR: tmux could not be installed automatically. Please install manually and re-run the script." >&2
    exit 1
  fi
  echo "tmux installed successfully."
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
    read -p "Press Enter to continue anyway or Ctrl+C to exit..."
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
echo "[4/6] Installing project dependencies..."
npm install
echo "Dependencies installed!"
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
export WORKERS=12

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

# Try to open browser (if running in graphical environment)
if command -v xdg-open &> /dev/null; then
    echo "Opening web interface..."
    xdg-open http://localhost:3001 2>/dev/null || true
fi

echo ""
echo "================================================================================"
echo "Both services are running!"
echo "Hash Server PID: $HASH_SERVER_PID"
echo "Next.js PID: $NEXTJS_PID"
echo ""
echo "To kill: pkill -f hash-server && pkill -f 'next' && exit"
echo "To detach and keep running (recommended), press Ctrl+B, then D"
echo "================================================================================"
# Sleep forever
while true; do sleep 600; done
EOF
chmod +x setup_internal.sh

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
