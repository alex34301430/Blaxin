#!/bin/bash
# BLAXIN — AI Desktop Agent Startup Script

set -e

echo "⚡ BLAXIN — AI Desktop Agent"
echo "==============================="
echo ""

# Determine the absolute directory of this script (project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required. Install it from https://nodejs.org"
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/server/node_modules" ]; then
    echo "Installing server dependencies..."
    (cd "$SCRIPT_DIR/server" && npm install)
fi

if [ ! -d "$SCRIPT_DIR/client/node_modules" ]; then
    echo "Installing client dependencies..."
    (cd "$SCRIPT_DIR/client" && npm install)
fi

echo "✓ Dependencies installed"
echo ""

# Track PIDs for cleanup
SERVER_PID=""
CLIENT_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
    wait 2>/dev/null
    exit 0
}

trap cleanup INT TERM

# Start server
echo "Starting BLAXIN server on port 3001..."
(cd "$SCRIPT_DIR/server" && node --import tsx src/index.ts) &
SERVER_PID=$!

sleep 3

# Start client
echo "Starting BLAXIN client on port 5173..."
(cd "$SCRIPT_DIR/client" && npx vite --host 0.0.0.0 --port 5173) &
CLIENT_PID=$!

echo ""
echo "==============================="
echo "⚡ BLAXIN is running!"
echo ""
echo "  Client:  http://localhost:5173"
echo "  Server:  http://localhost:3001"
echo ""
echo "  Press Ctrl+C to stop"
echo "==============================="

# Wait for background processes
wait
