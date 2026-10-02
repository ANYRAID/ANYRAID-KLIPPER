#!/bin/bash
# Offline SD bootloader maintenance using Node.js 26.
set -euo pipefail
SRCDIR="$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)"
exec "${NODE:-node}" "$SRCDIR/scripts/flash-sdcard.ts" "$@"
