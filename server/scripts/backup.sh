#!/usr/bin/env bash
set -euo pipefail

# Weekly database backup. Add to cron, e.g.:
#   0 3 * * 1  cd /Users/panbo/Code/Demos/youtube-digest/server && ./scripts/backup.sh

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_root="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$server_root/.." && pwd)"

NEON_URL="$(grep -E '^NEON_URL=' "$repo_root/.env" | head -1 | cut -d= -f2- | tr -d '"')"
[[ -z "$NEON_URL" ]] && { echo "backup.sh: NEON_URL not found" >&2; exit 1; }

export NEON_URL
node "$script_dir/backup.js" "$server_root/backups"
