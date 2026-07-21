#!/usr/bin/env bash
# Сценарий A: простые вопросы, 3 пользователя × 2 бота = 60 сообщений
set -e
cd "$(dirname "$0")/../.."

source .legion/test/env.sh
RESULTS_DIR=".legion/test/results/a"
mkdir -p "$RESULTS_DIR"
rm -f "$RESULTS_DIR"/*.json

# Users: user1(user1@test.legion) user2 user3
declare -A USER_KEYS
USER_KEYS[user1]=xnWOhucuGdaIp12K9wYClAc0fiNuXU3u
USER_KEYS[user2]=STiQLeQktcdkxLD0wUsTVtttwsqSnIMZ
USER_KEYS[user3]=76U4Og4Ckaq5e2UerOAvmNNDEVv98GgQ

BOTS=(consultantbot-bot@zulip.local adminbotv2-bot@zulip.local)
QUESTIONS=("привет" "как дела" "что нового" "расскажи о себе" "помоги")
TIMESTAMP=$(date +%s)
SEQ=0

echo "=== Scenario A: Simple questions ==="
echo "Users: ${!USER_KEYS[*]}"
echo "Bots: ${BOTS[*]}"
echo ""

for user in user1 user2 user3; do
  key="${USER_KEYS[$user]}"
  email="${user}@test.legion"
  for bot in "${BOTS[@]}"; do
    for q in "${QUESTIONS[@]}"; do
      START=$(date +%s%N)
      
      # Send DM
      RESP=$(curl -sk "https://localhost:8443/api/v1/messages" \
        -H "Host: legion.zulip.local:8443" \
        -u "$email:$key" \
        -d "type=private&to=$bot&content=$q" 2>/dev/null)
      MSG_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',0))" 2>/dev/null)
      SENT_AT=$(( $(date +%s%N) / 1000000 ))
      
      if [ "$MSG_ID" = "0" ]; then
        echo "[$SEQ] FAIL send: $user -> $bot"
        continue
      fi
      
      # Wait for ack (max 10s)
      ACK_TIME=0
      for i in 1 2 3 4 5 6 7 8 9 10; do
        sleep 1
        MSGS=$(curl -sk "https://localhost:8443/api/v1/messages?anchor=$MSG_ID&num_before=0&num_after=5" \
          -H "Host: legion.zulip.local:8443" \
          -u "$email:$key" 2>/dev/null | python3 -c "
import sys,json;d=json.load(sys.stdin)
for m in d.get('messages',[]):
    if m['sender_email']=='$bot':
        print(m['id'], '|', m.get('content','')[:50])
" 2>/dev/null)
        if [ -n "$MSGS" ]; then
          ACK_TIME=$(( ($(date +%s%N) / 1000000) - SENT_AT ))
          # Check if it's the real response or just ack
          FIRST_MSG=$(echo "$MSGS" | head -1)
          ACK_TEXT=$(echo "$FIRST_MSG" | cut -d'|' -f2 | xargs)
          echo "[$SEQ] $user -> $bot: sent=${SENT_AT}ms ack=${ACK_TIME}ms msg=\"$ACK_TEXT\""
          
          # Record
          echo "{\"seq\":$SEQ,\"user\":\"$user\",\"bot\":\"$bot\",\"msg_id\":$MSG_ID,\"sent_ms\":$SENT_AT,\"ack_ms\":$ACK_TIME,\"ack_text\":\"$ACK_TEXT\"}" \
            >> "$RESULTS_DIR/ack.json"
          break
        fi
      done
      
      if [ "$ACK_TIME" = "0" ]; then
        echo "[$SEQ] TIMEOUT: $user -> $bot (no ack in 10s)"
      fi
      
      SEQ=$((SEQ + 1))
    done
  done
done

echo ""
echo "=== Results ==="
python3 -c "
import json, statistics
with open('$RESULTS_DIR/ack.json') as f:
    data = [json.loads(l) for l in f if l.strip()]
if not data:
    print('No data')
    exit()
times = [d['ack_ms'] for d in data]
print(f'Total messages: {len(data)}')
print(f'Ack time: min={min(times)}ms avg={statistics.mean(times):.0f}ms max={max(times)}ms')
print(f'Percentiles: p50={sorted(times)[len(times)//2]}ms p95={sorted(times)[int(len(times)*0.95)]}ms')
"
