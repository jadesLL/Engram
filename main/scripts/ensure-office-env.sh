#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="$ROOT/.env.onlyoffice"

SECRET=""
if [ -f "$ENV_FILE" ]; then
  SECRET="$(sed -n 's/^ONLYOFFICE_JWT_SECRET=//p' "$ENV_FILE" | head -n 1)"
fi
if [ "${#SECRET}" -lt 32 ]; then
  SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
fi
printf 'ONLYOFFICE_JWT_SECRET=%s\nJWT_SECRET=%s\n' "$SECRET" "$SECRET" > "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true
echo ">> 已生成 $ENV_FILE"
