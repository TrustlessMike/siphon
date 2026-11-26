## Summary
Briefly describe what this pull request changes and why.

Closes #(issue)

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (new chain, DeFi extractor, Solana tool, SDK/MCP capability)
- [ ] Smart contract or deployment script change (`contracts/`)
- [ ] Documentation / DevOps / CI improvement
- [ ] Security hardening

## Verification & Safety Checklist
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds cleanly
- [ ] `npm test` passes (and new edge cases have deterministic unit/backtest coverage under `tests/`)
- [ ] If Solidity contracts or scripts changed: `forge build --sizes && forge test --no-match-contract TurgaliumMainnetFork -vv` passes
- [ ] If frontend files (`public/*`) changed: `node --check` and `python3 tests/e2e-playwright.py` pass
- [ ] Fail-closed safety checks preserved (health-factor/debt guards, pre-flight simulations, negative-ROI gates, auth checks)
- [ ] Default **0% protocol fee** (`0 bps`) and non-custodial signing preserved
- [ ] Zero hardcoded private keys, secrets, user destination addresses, or personal local paths

## Notes for Reviewers
Highlight any subtle invariants, RPC/API dependencies, or manual test steps.
