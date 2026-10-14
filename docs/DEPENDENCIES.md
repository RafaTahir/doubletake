# Dependency decisions

SDK/program dependencies are pinned. Existing wallet/Raydium interoperability uses web3.js v1 behind the ChainGateway boundary. A modern Kit migration is separate work and must preserve transaction verification.

Upstream bigint-buffer 1.1.5 contains a native path affected by [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg). The local compatibility package replaces four conversions with bounds-checked JavaScript, without native code, install hooks or bindings dependencies. Overflow/negative inputs throw. Tests cover both byte orders and exact-width boundaries. This is source remediation, not an upstream fix claim.

Overrides pin source-map-js 1.2.2 and uuid 11.1.1. An explicit `rpc-websockets` override also pins its uuid dependency to 11.1.1: rpc-websockets 9.3.9 loads uuid through CommonJS `require`, whereas uuid 14 is ESM-only. The lockfile must resolve that nested dependency to 11.1.1; a global override without the correct resolved entry did not prevent the serverless startup failure. Node 24 hosting therefore needs an actual module-load check as well as a successful TypeScript/Vite build.

Jayson 5 removes the vulnerable stream-json dependency; its browser-client interface used by web3.js remains covered by real RPC checks and the build. On October 15, 2026, a clean `npm ci` installed 334 packages, `npm ls` reported no invalid dependencies, and `npm audit --json` returned zero known advisories after the hosting lockfile correction. A direct rpc-websockets CommonJS load with experimental require-module support disabled also passed, followed by successful hosted preview responses. This does not prove absence of undiscovered vulnerabilities. Avoid `npm audit fix --force`, whose proposed downgrade removes Token-2022 support.

Raydium SDK/program code retains upstream licenses. Program source is pinned at `ed1eb41519d5355755f7df52b43fa9610938b60b`; Cargo.lock fixes the graph. Dependency pinning is not an audit.
