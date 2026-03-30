#!/bin/bash

# Helper script to properly restart the menu bar app

echo "Stopping all Electron instances..."
ps aux | grep -i "electron.*repo-radar" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null

# Wait for processes to die
sleep 2

# Verify they're dead
REMAINING=$(ps aux | grep -i "electron.*repo-radar" | grep -v grep | wc -l | xargs)
if [ "$REMAINING" != "0" ]; then
    echo "Warning: $REMAINING processes still running, trying harder..."
    pkill -9 -f "repo-radar"
    sleep 1
fi

echo "Starting app..."
cd "$(dirname "$0")"
npm start > /tmp/sync-menubar.log 2>&1 &

# Wait and check
sleep 3
RUNNING=$(ps aux | grep -i "electron.*repo-radar" | grep -v grep | wc -l | xargs)
echo "App started. Running processes: $RUNNING"

if [ "$RUNNING" == "0" ]; then
    echo "ERROR: App failed to start. Check /tmp/sync-menubar.log"
    exit 1
fi

echo "App running successfully!"
echo "Logs: /tmp/sync-menubar.log"

