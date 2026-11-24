# Siphon — Drain Every EVM Chain into Solana USDC

Multi-chain EVM dust, DeFi smart-contract position, and zero-liquidity token migrator routing native **USDC** directly to **Solana** via **Circle CCTP (Domain 5)**.

## Capabilities

- **Live Multi-Chain Multicall3 Scanner (`src/scanner/`):** Queries Ethereum, Base, Arbitrum, Optimism, Polygon, and Avalanche in parallel via zero-key public RPCs + live DeFiLlama USD pricing.
- **Smart-Contract DeFi Exits:** Detects and prepares withdrawals from Aave v3, Compound v3, Lido (`stETH` / `wstETH`), and Spark ERC-4626 vaults.
- **Safe Zero-Liquidity Burning:** Routes $0-liquidity dead/rugged tokens to `0x000000000000000000000000000000000000dEaD` inside isolated `try/catch` blocks while skipping reverting honeypots and exporting CSV/JSON hygiene receipts.
- **Circle CCTP 1:1 Bridge (`src/bridge/cctp.ts`, `contracts/SiphonRouter.sol`):** Encodes exact Solana Ed25519 `bytes32` `mintRecipient` and `TokenMessenger.depositForBurn` calldata per chain.

## Quick Start

```bash
npm install
npm run typecheck && npm run build && npm test
npm run start
# Open http://127.0.0.1:4420
```
