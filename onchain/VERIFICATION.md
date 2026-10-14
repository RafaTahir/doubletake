# Local program verification

All results below are from local Surfpool execution. No public-cluster transaction,
mainnet deployment, founder wallet signing or real funding was performed. The
fork fixtures deliberately create price gaps through real local Raydium swaps;
their profits are **not** evidence of a profitable live-market opportunity.

## Final build inputs and artifact

| Input | Version or SHA-256 |
|---|---|
| Anchor crates and macros | Exactly 1.0.2 |
| Raydium CLMM source | `ed1eb41519d5355755f7df52b43fa9610938b60b` |
| Agave / cargo-build-sbf | 3.1.10 |
| Platform tools / SBF rustc | 1.52 / 1.89.0-dev |
| Host rustc and Cargo | 1.97.1 |
| Surfpool / runtime RPC API | 1.5.0 / 4.1.2 |
| `programs/doubletake/src/lib.rs` | `d73cee245996ee048b4624eb69148fc981043221176cfa91a1bc177550d6ea58` |
| `programs/doubletake/Cargo.toml` | `a6049b3955a9f4d424b092c89214c5eaeceae4c7524074f9e436d2dbe64dba7b` |
| `Cargo.lock` | `fc1d076773fe5b7cc9ebc687ecea941f6656eb073ab3668f3f209074182c407d` |
| Clean `target/deploy/doubletake.so` | `f29b7ed413790829893c0e7662e79157d1d07f3bfdeb3fc16107ee76f25b7873` |

The final SBF build completed without stack-frame diagnostics. These identify the
tested **development** artifact, not an approved mainnet deployment. A production
program address requires rebuilding and separately verifying its bytecode and
published upgrade authority. Deployed ProgramData can include allocated padding;
record that bytecode hash separately from the unpadded ELF hash.

## Completed checks

- **12 Rust tests passed:** policy/capital caps, checked accounting, gifts,
  nonce/deadline/expiry/day limits, cooldown, midnight closure, exact pool registry,
  extension parsing, issuer fingerprints, public confidential mint compatibility,
  null/active hooks, paused/frozen states and scaled-amount activation boundaries.
- **8 independent client tests passed:** amount/recipient/message reconstruction,
  rejected extra instructions, bounded fees/permissions, strict account decoding,
  exact execution pools, canonical ProgramData bootstrap and asset registration.
- **Actual offline SBF owner/bootstrap controls passed:** unauthorized withdrawal
  rejected; owner pause/withdraw/close with no service config or worker; close with
  disabled invite; actual SPL transfers and rent recovery; persistent nonce seed
  11 after closing nonce 10; actual recreation starts at nonce 11; bootstrap
  front-runner rejected; actual upgrade-authority initialization accepted.
- **Both actual mainnet-fork suites passed:** SOL and Token-2022 AAPLx. Each runs
  real Associated Token precreation by an unrelated signer, preserves gifts of
  2 USDC and 13 raw asset units during initialization, deposits 100 USDC, rejects
  excess principal and authorizes a per-user keeper through real owner instructions.

The fork suites then verify profitable guarded cycles, actual received-amount
handoff, no new intermediate inventory, confirmed profit accounting, nonce replay
rejection, frozen accounts and missing tick arrays. AAPLx additionally rejects
execution within the scheduled multiplier activation window. Both a negative
quoted reverse route and an intentionally failing second leg invoke both real
Raydium CPIs and revert both pool states, both vault token balances and nonce.
Each processed failed attempt still pays a network fee.

Each suite also uses the actual `SolanaChainGateway` for deployment checks,
execution preview, complete transaction simulation, reviewed keeper signing,
local broadcast, confirmed receipt and fee reconciliation. The receipt must
contain the trusted guard event's exact 64-character issuer fingerprint and
positive actual raw amount received. Finally, the service and invite are paused;
owner withdrawal and intermediate recovery return all principal, profits and gifts.

## Final fork measurements

The offline runtime also exercises native SOL allowance funding and a complete
refund through `SolanaChainGateway`. A fresh isolated wallet receives exactly
1,500,000 lamports through the owner-reviewed funding transaction. The confirmed
refund returns 1,493,600 lamports to that owner, charges 6,400 lamports of network
fee, and leaves the fee wallet at zero. Assertions verify the fixed recipient,
actual owner/fee-wallet balance changes, receipt conservation and a public-only
signed-message journal written before broadcast. No private keys are written.
Persistent database durability and idempotent settlement are tested separately
by the application/API suite.

Both vaults start with 102 USDC: 100 deposited principal plus 2 unsolicited USDC.
The cycle size is 25 USDC and the on-chain minimum profit is 0.05 USDC. Preexisting
13 raw intermediate units remain unchanged through both successful cycles and
are subsequently recovered by the owner.

| Measurement | SOL | AAPLx |
|---|---:|---:|
| Direct guarded profit, raw USDC | `59873` | `77677` |
| Direct guarded compute units | `210180` | `332243` |
| Reverse-route quoted profit, raw USDC | `-91869` | `-252617` |
| Reverse-route state/nonce outcome | Fully reverted | Fully reverted |
| Reverse-route confirmed failed fee, lamports | `5000` | `5000` |
| Product gateway confirmed profit, raw USDC | `52615` | `76513` |
| Product gateway confirmed fee, lamports | `5253` | `5398` |
| Product gateway simulation compute units | `210177` | `331007` |
| Actual received intermediate quantity, raw | `239066613` | `7218622` |
| Execution-time multiplier | `1` | `1.0032690125398187` |
| Multiplier effective time | None | `2026-08-08T00:30:00.000Z` |

Verified issuer fingerprints:

- SOL: `5eed30a36fb7e9af01b130124133ce2e7dd820b38bcb768536df24a3f9f96dc9`.
- AAPLx: `ead15d507d6f95aaeec2195f4494f4c27859107b681b5d62abb8ce105ae80ed3`.

Successful product-gateway signatures, **local bank only**:

- SOL: `3GfAT4HY6UfZiPzzCwzM95np3Sxkt7h4J24HCY3ggQpX86NktDike85HDcguQWQRgy7GpA6Y6bBbwd33a2jicZoG`.
- AAPLx: `DvGhYRZyxESRHXf8QSMAVRhUVVVQoUQbYdfNxUqnDT1TBMsVF9CpkHeh6r5P55AeNQjncm6uYToXpLLMdCs9oKz`.

## Fee authority and reproduction

Production reconciliation treats confirmed Solana `meta.fee` as the fee authority
and cross-checks account balance conservation; disagreement defers verification.
Surfpool 1.5.0 omits priority fees from `meta.fee` in these local receipts. Only the
explicit `localnet` test path permits balance conservation to supply that missing
priority fee. The recorded gateway fees equal actual fee-wallet debits; no
estimated or fabricated fee replaces a production receipt.

Run `bash onchain/scripts/test.sh --all` on Linux, or
`npm run test:program -- --all` on Windows with WSL Ubuntu. The final source's
offline suite was recorded by `--all`; the completed updated fork harness was
recorded by `--fork`, which also reran all Rust/client tests and verified the same
SBF hash. Final fork runtime logs: `/var/tmp/doubletake-integration.LpVTGW`.

The runner creates and stops its own loopback instances. Every signing harness
rejects non-loopback RPCs. Test keypairs stay in memory and never enter logs,
snapshots or the repository. Generated public/local-state snapshots and JSON
results are under ignored `fixtures/generated/`. The bounded fixture setup stops
if actual pool depth or profitability cannot satisfy its tests; it never invents
an opportunity to make a run pass.

Production funding remains disabled pending the actual deployment identity,
reproducible deployment verification, published upgrade authority, completed
product/provider checks, independent engineering review, issuer eligibility and
a founder-approved small canary. Internal peer review is not a formal external
audit and does not satisfy these remaining launch gates by itself.
