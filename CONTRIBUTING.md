# Contributing to Siphon

Contributions are welcome! Siphon is MIT-licensed and built around strict fund-safety invariants and reproducible tests.

## Development Workflow

```bash
npm install
npm run typecheck
npm run build
npm test
```

For frontend / wallet / UX changes, also run syntax checks and the Playwright regression suite:

```bash
node --check public/app.js && node --check public/wallets.js
python3 tests/e2e-playwright.py
```

## Guidelines

- **Fail Closed on Safety Checks:** Borrow/debt guards, `eth_call` pre-flight simulations, `NaN`/invalid-input ROI gates, and authentication checks must fail closed on errors or timeouts.
- **Never Hardcode User Destinations or Private Keys:** Destination wallets must always come from explicit user input or a connected wallet.
- **Backtest Edge Cases:** Every new DeFi extractor, chain adapter, or security fix should include deterministic unit/backtest tests under `tests/`.
- **Keep Pull Requests Focused:** One clear feature or fix per PR with passing CI checks.
