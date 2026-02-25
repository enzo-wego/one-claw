#!/bin/bash
# Auto-restart wrapper for EnzoBot
# Usage: ./start.sh

CHILD_PID=
trap 'kill $CHILD_PID 2>/dev/null; exit 0' SIGTERM SIGINT

while true; do
  echo "[$(date)] Starting EnzoBot..."
  npx tsx src/index.ts &
  CHILD_PID=$!
  wait $CHILD_PID
  EXIT_CODE=$?
  echo "[$(date)] EnzoBot exited with code $EXIT_CODE. Restarting in 3 seconds..."
  sleep 3
done
