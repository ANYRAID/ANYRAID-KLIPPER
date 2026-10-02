#!/bin/bash
# Generate the multilingual documentation site without Python.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if (( $# > 2 )); then
    echo "Usage: $0 [NEW_OUTPUT_DIRECTORY [TRANSLATIONS_DIRECTORY]]" >&2
    exit 1
fi
OUTPUT="${1:-${ROOT}/site}"
if (( $# == 2 )); then
    exec "${NODE:-node}" "${ROOT}/scripts/build-docs.ts" "$OUTPUT" "$2"
fi
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/klipper-docs.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
git clone --depth 1 https://github.com/Klipper3d/klipper-translations "$STAGING/translations"
"${NODE:-node}" "${ROOT}/scripts/build-docs.ts" "$OUTPUT" "$STAGING/translations"
