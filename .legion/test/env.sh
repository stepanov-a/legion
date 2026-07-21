#!/usr/bin/env bash
# Test environment config
set -a

# Admin credentials
ADMIN_EMAIL="a.stepanov@2035.university"
ADMIN_KEY="6oOtyKGoUEcn2UFn0vkgyYvtZF7RgA4L"
ZULIP_HOST="https://localhost:8443"
ZULIP_HOST_HEADER="legion.zulip.local:8443"
LEGION_HOST="http://localhost:3000"

# Test users (created below)
declare -A USERS
USERS[user1]="user1@test.legion:test-pass-1"
USERS[user2]="user2@test.legion:test-pass-2"
USERS[user3]="user3@test.legion:test-pass-3"

# Bot configs
CONSULTANT_EMAIL="consultantbot-bot@zulip.local"
ADMINBOT_EMAIL="adminbotv2-bot@zulip.local"
