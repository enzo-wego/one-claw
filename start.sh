#!/bin/bash
# Auto-restart wrapper for EnzoBot
# Usage: ./start.sh

while true; do
  echo "[$(date)] Starting EnzoBot..."
  npx tsx src/index.ts
  EXIT_CODE=$?
  echo "[$(date)] EnzoBot exited with code $EXIT_CODE. Restarting in 3 seconds..."
  sleep 3
done
