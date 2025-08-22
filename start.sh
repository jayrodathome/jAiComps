#!/usr/bin/env bash
set -euo pipefail
echo "[startup] Node version: $(node -v)"
echo "[startup] Working dir: $(pwd)"
echo "[startup] Listing app root:"; ls -1
mask(){ local v="$1"; if [ -z "${v}" ]; then echo "(empty)"; else echo "${v:0:4}***${v: -4} (len:${#v})"; fi; }
echo "[startup] PORT=$PORT NODE_ENV=$NODE_ENV"
echo "[startup] GEMINI_API_KEY=$(mask "${GEMINI_API_KEY:-}")"
echo "[startup] GOOGLE_API_KEY=$(mask "${GOOGLE_API_KEY:-}")"
echo "[startup] FBI_API_KEY=$(mask "${FBI_API_KEY:-}")"
echo "[startup] Starting server.js ..."
exec node server.js
