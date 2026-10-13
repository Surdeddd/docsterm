#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

for name in fs sleep stdin interleave loop guess env trap greet; do
  rustc --target wasm32-wasip1 -C opt-level=z -C strip=symbols -C panic=abort -o "$name.wasm" "$name.rs"
done
