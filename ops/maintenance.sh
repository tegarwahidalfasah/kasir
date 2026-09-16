#!/usr/bin/env sh
# ===========================================================================
#  Pembungkus cron/systemd untuk alat pemeliharaan Kasir.
#  Semua pekerjaan dilakukan skrip Node (node:sqlite) -> tidak perlu sqlite3 CLI.
#    ./ops/maintenance.sh status
#    ./ops/maintenance.sh backup
#    ./ops/maintenance.sh health --api=http://127.0.0.1:4000
#    ./ops/maintenance.sh prune --dry-run
#  Variabel:
#    APP_DIR         default /opt/kasir
#    KASIR_DATA_DIR  direktori pangkalan data (harus sama dengan milik layanan)
#    MAINT_LOCK      default /tmp/kasir-maintenance.lock
# ===========================================================================
set -eu

APP_DIR="${APP_DIR:-/opt/kasir}"
MAINT_LOCK="${MAINT_LOCK:-/tmp/kasir-maintenance.lock}"
cd "$APP_DIR"

# satu job pemeliharaan pada satu waktu (cron bisa mengirim lebih dari satu sinyal)
exec 9>"$MAINT_LOCK"
if ! command -v flock >/dev/null 2>&1 || flock -n 9; then
  npm run --silent maintenance -- "$@"
else
  echo "pemeliharaan lain masih berjalan (lock: $MAINT_LOCK) — lewatkan" >&2
fi
