#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# FinFlow — macOS Launcher
# Double-click this file to start the app
# Works from anywhere — finds the project folder automatically
# ═══════════════════════════════════════════════════════════════

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║       FinFlow — Starting...              ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# --- Locate the project folder ---
PROJECT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$HOME/.finflow_path"

# 1) Check if we're already inside the project folder
if [ -f "$SCRIPT_DIR/server/src/index.ts" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
  echo "$PROJECT_DIR" > "$CONFIG_FILE"
fi

# 2) Check saved path from a previous launch
if [ -z "$PROJECT_DIR" ] && [ -f "$CONFIG_FILE" ]; then
  SAVED="$(cat "$CONFIG_FILE")"
  if [ -f "$SAVED/server/src/index.ts" ] && [ -f "$SAVED/package.json" ]; then
    PROJECT_DIR="$SAVED"
  fi
fi

# 3) Search common locations
if [ -z "$PROJECT_DIR" ]; then
  for DIR in \
    "$HOME/Documents/Claude Ai Software/Budget Planning/finflow" \
    "$HOME/Desktop/finflow" \
    "$HOME/Documents/finflow" \
    "$HOME/Downloads/finflow" \
    "$HOME/Projects/finflow" \
    "$HOME/dev/finflow"; do
    if [ -f "$DIR/server/src/index.ts" ] && [ -f "$DIR/package.json" ]; then
      PROJECT_DIR="$DIR"
      echo "$PROJECT_DIR" > "$CONFIG_FILE"
      break
    fi
  done
fi

# 4) If still not found, ask the user
if [ -z "$PROJECT_DIR" ]; then
  echo "  ✗ Can't find the FinFlow project folder."
  echo ""
  echo "  Drag the finflow folder into this window and press Enter:"
  echo ""
  read -r PROJECT_DIR
  PROJECT_DIR="$(echo "$PROJECT_DIR" | sed "s/^['\"]//;s/['\"]$//;s/ *$//")"
  if [ -f "$PROJECT_DIR/server/src/index.ts" ] && [ -f "$PROJECT_DIR/package.json" ]; then
    echo "$PROJECT_DIR" > "$CONFIG_FILE"
  else
    echo "  ✗ That doesn't look like the FinFlow folder."
    echo "  Press any key to exit..."
    read -n 1
    exit 1
  fi
fi

echo "  ✓ Project folder: $PROJECT_DIR"
cd "$PROJECT_DIR"

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found!"
  echo "    Install it from: https://nodejs.org"
  echo ""
  echo "  Press any key to exit..."
  read -n 1
  exit 1
fi

echo "  ✓ Node.js $(node -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "  → Installing dependencies (first time only)..."
  npm install
  echo ""
fi

echo "  ✓ Dependencies ready"

# Seed database if it doesn't exist
if [ ! -f "server/finflow.db" ]; then
  echo "  → Setting up database with sample data..."
  npx tsx server/src/db/seed.ts
  echo ""
fi

echo "  ✓ Database ready"
echo ""

# Kill any existing processes on our ports
lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null

# Start backend server
echo "  → Starting API server on port 3001..."
npx tsx server/src/index.ts &
SERVER_PID=$!
sleep 2

# Start Vite dev server
echo "  → Starting frontend on port 5173..."
cd client && npx vite --host &
VITE_PID=$!
cd "$PROJECT_DIR"
sleep 3

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   FinFlow is running!                    ║"
echo "  ║                                          ║"
echo "  ║   Open: http://localhost:5173            ║"
echo "  ║                                          ║"
echo "  ║   Login: demo@finflow.com / password123  ║"
echo "  ║                                          ║"
echo "  ║   Press Ctrl+C to stop                   ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Open browser
if command -v open &>/dev/null; then
  open "http://localhost:5173"
fi

# Wait and handle shutdown
cleanup() {
  echo ""
  echo "  Shutting down FinFlow..."
  kill $SERVER_PID 2>/dev/null
  kill $VITE_PID 2>/dev/null
  lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null
  lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null
  echo "  Done. Goodbye!"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Keep running
wait
