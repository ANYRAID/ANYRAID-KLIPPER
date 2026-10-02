#!/bin/bash
# Script to check whitespace in Klipper and Node host source code.
set -euo pipefail

SRCDIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )"/.. && pwd )"
cd "${SRCDIR}"

# Use NUL separators so paths containing whitespace remain individual arguments.
find config/ docs/ klippy/ scripts/ src/ test/ \
    host/src/ host/test/ host/scripts/ host/bench/ \
    -path scripts/kconfig -prune -o -type f \( \
    -iname '*.[csh]' -o -name '*.py' -o -name '*.sh' \
    -o -name '*.md' -o -name '*.cfg' -o -name '*.txt' \
    -o -name '*.html' -o -name '*.css' \
    -o -name '*.yaml' -o -name '*.yml' \
    -o -name '*.test' -o -name '*.config' \
    -o -name '*.ts' -o -name '*.mts' \
    -o -iname '*.lds' -o -iname 'Makefile' -o -iname 'Kconfig' \
    \) -print0 | xargs -0 -r "${NODE:-node}" scripts/check_whitespace.ts
