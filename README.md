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

## Configuration

All optional, read from the environment:

- `ETH_RPC_URL`, `BASE_RPC_URL`, `ARB_RPC_URL`, `OP_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL`, `SOLANA_RPC_URL`: override the public RPC endpoints.
- `LIFI_API_KEY`: sent as `x-lifi-api-key` on LI.FI quotes. Without it LI.FI's keyless limit is exhausted after a few large-wallet batches, and affected assets are skipped with a "rate-limited" reason until it resets.
