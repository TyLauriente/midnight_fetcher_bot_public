#!/bin/bash
# Build script for HashEngine native Node.js addon

set -e

echo "Building HashEngine native addon..."

# Build Rust code
cargo build --release

# Copy the built library to index.node
if [ -f "target/release/libHashEngine_napi.so" ]; then
    cp target/release/libHashEngine_napi.so index.node
elif [ -f "target/release/libHashEngine_napi.dylib" ]; then
    cp target/release/libHashEngine_napi.dylib index.node
elif [ -f "target/release/HashEngine_napi.dll" ]; then
    cp target/release/HashEngine_napi.dll index.node
else
    echo "Error: Could not find compiled library"
    exit 1
fi

echo "✓ HashEngine native addon built successfully"
echo "  Output: index.node"
