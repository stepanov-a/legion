#!/usr/bin/env bash

set -e

SECRETS_DIR="./secrets"

echo "[+] Creating secrets directory: $SECRETS_DIR"
mkdir -p "$SECRETS_DIR"

generate_base64() {
  openssl rand -base64 32 | tr -d '\n'
}

generate_hex() {
  openssl rand -hex 50 | tr -d '\n'
}

write_secret() {
  local filename=$1
  local value=$2
  echo -n "$value" > "$SECRETS_DIR/$filename"
  echo "[+] Created $filename"
}

echo "[+] Generating secrets..."

# PostgreSQL
write_secret "zulip__postgres_password" "$(generate_base64)"

# Memcached
write_secret "zulip__memcached_password" "$(generate_base64)"

# RabbitMQ
write_secret "zulip__rabbitmq_password" "$(generate_base64)"

# Redis
write_secret "zulip__redis_password" "$(generate_base64)"

# Django secret key (важный)
write_secret "zulip__secret_key" "$(generate_hex)"

# SMTP (заглушка — потом поменяешь)
write_secret "zulip__email_password" "CHANGE_ME_SMTP_PASSWORD"

echo "[+] Done."
echo
echo "⚠️ Не забудь заменить zulip__email_password на реальный SMTP пароль"
echo "📁 Secrets лежат в: $SECRETS_DIR"
