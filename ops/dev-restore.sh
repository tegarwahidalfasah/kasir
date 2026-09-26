#!/usr/bin/env bash
# ============================================================================
#  Pemulihan lingkungan kerja setelah sandbox di-restart.
#  node_modules + DB demo tidak ikut snapshot, dan HEAD git kadang mundur
#  (walau seluruh berkas masih utuh) — skrip ini membereskan keduanya.
#  Pemakaian: bash ops/dev-restore.sh
# ============================================================================
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)
[ -n "$ROOT" ] || ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

echo "▶ sinkronisasi git dengan remote  ($ROOT)"
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --quiet
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null && [ -z "$(git log --oneline "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
  if [ -z "$(git status --porcelain)" ]; then
    git reset --hard "origin/$BRANCH" --quiet && echo "   HEAD dipulihkan ke $BRANCH @ $(git rev-parse --short HEAD)"
  elif [ -z "$(git diff "origin/$BRANCH" --stat)" ]; then
    # isi area kerja IDENTIK dengan remote (hanya HEAD yang mundur) -> aman direset.
    # Pakai `git diff` biasa supaya tidak ada berkas yang ikut ter-stage.
    git reset --hard "origin/$BRANCH" --quiet && echo "   area kerja dipulihkan ke $BRANCH @ $(git rev-parse --short HEAD)"
  elif git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
    # HEAD tertinggal, area kerja berisi komit remote + pekerjaan baru.
    # `--soft` hanya memindahkan HEAD; berkas & indeks tidak disentuh.
    git reset --soft "origin/$BRANCH" --quiet && echo "   HEAD dinaikkan ke $BRANCH @ $(git rev-parse --short HEAD) — pekerjaan di area kerja dipertahankan"
  else
    echo "   ⚠️  area kerja berbeda dari remote — TIDAK disentuh. Periksa: git status / git diff"
  fi
else
  echo "   dilewati (ada komit lokal yang belum ada di remote)"
fi

echo "▶ dependensi"
if [ -f node_modules/express/package.json ]; then
  echo "   sudah terpasang"
else
  npm install --no-audit --no-fund 2>&1 | tail -2 || echo "   ⚠️  npm install gagal — jalankan manual sebelum lanjut"
fi

echo "▶ build SPA + data demo"
[ -d client/dist ] || npm run build 2>&1 | tail -1
if [ -f server/src/data/kasir.db ]; then
  echo "   DB demo sudah ada (npm run reset && npm run seed bila ingin data bersih)"
else
  npm run seed 2>&1 | tail -1
fi

echo "✅ siap: jalankan  npm start   (atau npm run dev untuk mode pengembangan)"
