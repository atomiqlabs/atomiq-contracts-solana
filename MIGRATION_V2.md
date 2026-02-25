# Atomiq V2 Solana Migration

This document summarizes the migration of the legacy Solana swap program to the Atomiq v2 model, aligned with:

- Starknet v2: `/tmp/atomiq-v2-refs/atomiq-contracts-starknet`
- EVM v2: `/tmp/atomiq-v2-refs/atomiq-contracts-evm`

## Scope

Migration was applied to the Solana Anchor program in `swaps/programs/swap-program`, plus supporting test and local-validator harness updates.

## Parity Mapping

### 1) Escrow state and lifecycle

Added v2 lifecycle and routing metadata to `EscrowState`:

- `lifecycle_state` (`NotCommitted`, `Committed`, `Claimed`, `Refunded`)
- `init_slot`, `finish_slot`
- `escrow_hash`
- `claim_handler`, `refund_handler`
- `success_action_commitment`

Files:

- `swaps/programs/swap-program/src/state.rs`
- `swaps/programs/swap-program/src/enums.rs`

### 2) V2 events

Added v2-aligned events:

- `EscrowInitializeEvent`
- `EscrowClaimEvent`
- `EscrowRefundEvent`
- `EscrowExecutionErrorEvent`

Legacy events were retained for backwards compatibility with existing Solana tests and integrations.

Files:

- `swaps/programs/swap-program/src/events.rs`

### 3) V2 error surface

Added v2 state/handler/commitment errors:

- `EscrowAlreadyCommitted`
- `EscrowNotCommitted`
- `EscrowHashMismatch`
- `InvalidClaimHandler`
- `InvalidRefundHandler`
- `InvalidSuccessActionCommitment`

File:

- `swaps/programs/swap-program/src/errors.rs`

### 4) Initialize parity

Added v2 initialize entrypoints:

- `initialize(...)` (non-pay-in)
- `initialize_pay_in(...)`

Added initialization routing metadata and deterministic escrow hash computation.

Files:

- `swaps/programs/swap-program/src/lib.rs`
- `swaps/programs/swap-program/src/ixs/initialize.rs`

### 5) Claim parity

Added v2 claim entrypoints:

- `claim(...)`
- `claim_pay_out(...)`
- `claim_with_success_action(...)`
- `claim_with_success_action_pay_out(...)`

Added lifecycle and handler validation before claim execution.
Added witness result propagation from claim verification into v2 claim event.

Important v2 guard:

- Plain `claim*` now rejects non-zero `success_action_commitment`.
- `claim_with_success_action*` requires exact commitment match.

Files:

- `swaps/programs/swap-program/src/lib.rs`
- `swaps/programs/swap-program/src/ixs/claim.rs`

### 6) Refund parity

Added v2 refund entrypoints:

- `refund(...)`
- `refund_pay_in(...)`
- `cooperative_refund(...)`
- `cooperative_refund_pay_in(...)`

Added lifecycle and refund-handler checks before refund execution.

Files:

- `swaps/programs/swap-program/src/lib.rs`

## Solana-Specific Adaptations

### Handler representation

EVM/Starknet v2 use handler contract addresses. Solana migration maps handlers to enums:

- `ClaimHandlerType` <- `SwapType` mapping
- `RefundHandlerType::Timelock`

This preserves routing semantics while fitting a single-program Solana model.

### Account model / PDA behavior

State transitions are enforced in PDA-backed `EscrowState` and account constraints (`#[derive(Accounts)]`) rather than by external contract dispatch.

### Compute and stack constraints

Anchor account stack pressure fixes were required to avoid runtime `ProgramFailedToComplete` in heavy contexts:

- `Deposit.user_data` boxed
- Several `InitializePayIn` and optional `Initialize` accounts boxed

File:

- `swaps/programs/swap-program/src/instructions.rs`

## Test and Local Harness Changes

### Mocked BTC relay wiring

To preserve chain-claim/refund behavior in tests, local validator genesis now preloads mocked `btc_relay`:

- `swaps/Anchor.toml` adds `[[test.genesis]]`
- `swaps/tests/btc_relay.json` metadata address updated to the mocked relay id

### Sequential deterministic runner

Added `swaps/tests/run-all.sh` and switched Anchor script to `bash ./tests/run-all.sh`.
This avoids accidental concurrent test-file execution via command-token parsing.

### Stability fixes

- Reduced in-file parallelism default (`ParalelizedTest`) from `10` to `2`
- Explicit `"confirmed"` confirmation in selected test helpers
- Retry wrapper for `getTransaction()` in refund event assertions

### New v2 regression coverage

Added `swaps/tests/instructions/v2.ts`:

- verifies plain `claim` is rejected when success-action commitment is set
- verifies `claimWithSuccessAction` succeeds when commitment matches

## Known Differences / Follow-up

1. `success_action_commitment` validation is implemented, but no Solana-side execution contract CPI flow is currently wired.  
2. `EscrowExecutionErrorEvent` type exists for v2 event parity but is not emitted yet because execution action dispatch is not implemented.

## Validation Summary

Validated with `anchor build` and instruction test suites including:

- `deposit.ts`
- `withdraw.ts`
- `initialize.ts`
- `claim.ts`
- `v2.ts`
- `refund.ts`

Final full-run command (local):

```bash
cd swaps
COPYFILE_DISABLE=1 anchor test
```
