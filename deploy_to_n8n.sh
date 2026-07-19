#!/bin/bash
set -e

SERVER="vdc-kvaz-n8n01"
REMOTE_DIR="~/legion"
LOCAL_DIR="/home/neo/Projects/legion_new/legion"

echo "=== Deploy Legion → $SERVER:$REMOTE_DIR ==="

rsync -avz --delete \
  --exclude '.git' \
  --exclude '.legion/integration.log' \
  --exclude 'node_modules' \
  $LOCAL_DIR/ \
  $SERVER:$REMOTE_DIR/

echo ""
echo "=== Installing dependencies ==="
ssh $SERVER "cd $REMOTE_DIR && ~/.bun/bin/bun install --ignore-scripts 2>&1 | tail -3"

echo ""
echo "=== Restarting server ==="
ssh $SERVER "lsof -ti:3000 | xargs kill -9 2>/dev/null; sleep 1; cd $REMOTE_DIR && setsid ~/.bun/bin/bun run start-legion.ts </dev/null > /tmp/legion.log 2>&1 &"
sleep 3

echo ""
echo "=== Health check ==="
ssh $SERVER "curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/webhook/zulip"
