#!/usr/bin/env bash
set -euo pipefail

# Deploy with migrations first: schema changes must land before the code
# that queries them (idempotent ALTERs, safe to run every time).

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_root="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$server_root/.." && pwd)"

NEON_URL="$(grep -E '^NEON_URL=' "$repo_root/.env" | head -1 | cut -d= -f2- | tr -d '"')"
if [[ -z "$NEON_URL" ]]; then
  printf 'deploy.sh: NEON_URL not found in %s/.env\n' "$repo_root" >&2
  exit 1
fi

cd "$server_root"
export DATABASE_URL="$NEON_URL"
node scripts/migrate.js
npx wrangler deploy "$@"
