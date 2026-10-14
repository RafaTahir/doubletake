#!/usr/bin/env bash
set -euo pipefail

# Native Linux or `wsl -d Ubuntu -- bash onchain/scripts/test.sh` from npm.
onchain_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="$(cd -- "$onchain_root/.." && pwd)"
mode="${1:---unit}"
case "$mode" in --unit|--sbf|--fork|--all) ;; *) printf 'Usage: test.sh [--unit|--sbf|--fork|--all]\n' >&2; exit 2;; esac
export NO_DNA=1
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/var/tmp/doubletake-build-cache/doubletake-cargo-target}"
mkdir -p "$CARGO_TARGET_DIR"
cd "$onchain_root"
rustc --version
cargo --version
cargo test --locked

run_node() {
  cd "$project_root"
  if command -v node.exe >/dev/null 2>&1; then
    # Use the Windows Node install when node_modules was installed on Windows.
    # This avoids accidentally loading an esbuild binary for another platform.
    node.exe --import tsx "$(wslpath -w "$1")"
  else
    node --import tsx "$1"
  fi
}
run_node "$onchain_root/tests/program-client.test.ts"
[[ "$mode" == --unit ]] && exit 0

cd "$onchain_root"
solana --version
surfpool --version
export CARGO_TARGET_DIR="${SBF_TARGET_DIR:-/var/tmp/doubletake-build-cache/doubletake-sbf-target}"
cargo build-sbf --manifest-path programs/doubletake/Cargo.toml --sbf-out-dir target/deploy
sha256sum target/deploy/doubletake.so

test_log_root="$(mktemp -d /var/tmp/doubletake-integration.XXXXXX)"
children=()
cleanup() { for child in "${children[@]}"; do kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
wait_rpc() {
  for _attempt in $(seq 1 80); do
    if curl -fsS -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}' "$1" | grep -q 'ok'; then return; fi
    sleep 0.25
  done
  printf 'Local Surfpool did not start; logs: %s\n' "$test_log_root" >&2
  exit 1
}
export LOCAL_RPC_URL="${LOCAL_RPC_URL:-http://127.0.0.1:18089}"
export FORK_RPC_URL="${FORK_RPC_URL:-http://127.0.0.1:18099}"
# Only loopback targets may receive signed fixtures, enforced again in TS.
case "$LOCAL_RPC_URL:$FORK_RPC_URL" in http://127.0.0.1:*:http://127.0.0.1:*) ;; *) printf 'Test endpoints must be loopback URLs\n' >&2; exit 2;; esac
export WSLENV="${WSLENV:+$WSLENV:}LOCAL_RPC_URL:FORK_RPC_URL:FORK_ASSET_SYMBOL:FORK_PUSH_AMOUNTS"

if [[ "$mode" == --sbf || "$mode" == --all ]]; then
  offline_port="${LOCAL_RPC_URL##*:}"
  surfpool start --offline --port "$offline_port" --ws-port "$((offline_port+1))" --no-deploy --no-tui --no-studio --airdrop-amount 0 --log-level warn --log-path "$test_log_root/offline" >"$test_log_root/offline.log" 2>&1 &
  children+=("$!")
  wait_rpc "$LOCAL_RPC_URL"
  run_node "$onchain_root/tests/runtime-controls.integration.ts"
fi
if [[ "$mode" == --fork || "$mode" == --all ]]; then
  fork_port="${FORK_RPC_URL##*:}"
  # This downloads public state only. All signatures go to local Surfpool.
  surfpool start --network mainnet --port "$fork_port" --ws-port "$((fork_port+1))" --no-deploy --no-tui --no-studio --airdrop-amount 0 --log-level warn --log-path "$test_log_root/fork" >"$test_log_root/fork.log" 2>&1 &
  children+=("$!")
  wait_rpc "$FORK_RPC_URL"
  if [[ -n "${FORK_ASSET_SYMBOL:-}" ]]; then
    run_node "$onchain_root/tests/fork-cycles.integration.ts"
  else
    export FORK_ASSET_SYMBOL=SOL
    run_node "$onchain_root/tests/fork-cycles.integration.ts"
    export FORK_ASSET_SYMBOL=AAPLx
    run_node "$onchain_root/tests/fork-cycles.integration.ts"
  fi
fi
printf 'Integration logs: %s\n' "$test_log_root"
