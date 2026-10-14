#!/bin/sh
set -eu
# Railway mounts volumes as root. Initialize only the configured /data directory,
# then run the application as the unprivileged node user.
if [ -n "${BACKUP_DIRECTORY:-}" ]; then
  target=$(realpath -m -- "$BACKUP_DIRECTORY")
  case "$target" in /data|/data/*) ;; *) echo "BACKUP_DIRECTORY must resolve within /data" >&2; exit 1 ;; esac
  mkdir -p -- "$target"
  chown node:node -- "$target"
fi
exec runuser -u node -- node build/server/index.js
