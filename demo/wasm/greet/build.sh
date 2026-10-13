#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target_dir="${CARGO_TARGET_DIR:-$here/target}"
out="${1:-$here/../../public/greet.wasm}"

rustup target add wasm32-wasip1 >/dev/null
cargo build --manifest-path "$here/Cargo.toml" --release --target wasm32-wasip1 --target-dir "$target_dir"
cp "$target_dir/wasm32-wasip1/release/greet.wasm" "$out"
wc -c "$out"
