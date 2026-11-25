# Siphon — One Chain. Fresh Start.

Multi-chain EVM-to-Solana migrator that unwinds dormant DeFi positions, sells liquid ERC-20 dust and native balances into native Solana **USDC** or **SOL**, safely burns zero-liquidity dead coins, and collapses execution into **1 click per chain** via **EIP-5792** (`wallet_sendCalls`).

## Capabilities

- **6-Chain Live Multicall3 Scanner (`src/scanner/`):** Parallel live scanning across Ethereum, Base, Arbitrum, Optimism, Polygon, and Avalanche with automatic 3-endpoint RPC failover per chain.
- **Spam & Fake-Price Liquidity Filter:** Batch-verifies discovered long-tail ERC-20 tokens against live DexScreener liquidity (`>= $2,500`) so unsellable spam tokens never inflate portfolio totals.
- **Aave v3 Debt / Health-Factor Guard:** Reads `AaveV3Pool.getUserAccountData(user)` onchain before preparing `MAX` withdrawals, blocking unsafe exits when active borrows exist.
- **EIP-5792 1-Click-Per-Chain Atomic Batching (`src/execution/tx-builder.ts`, `public/wallets.js`):** Bundles withdrawals, deduplicated exact approvals, Relay/LI.FI/Circle CCTP bridges, and `eth_call`-verified burns into one `wallet_sendCalls` batch per chain, with automatic sequential fallback (waiting for receipts between dependent calls) for legacy wallets.
- **Circle CCTP Solana Claim Support (`src/bridge/cctp.ts`, `POST /api/cctp/attestation`):** Extracts `MessageSent(bytes)` from EVM receipts, polls Circle's Iris Attestation API, and verifies Solana USDC ATA + SOL rent readiness.
- **Unified Dual-Ecosystem Wallet Connectors (`public/wallets.js`, `src/client/wallet-sdks.ts`):** Supports EIP-6963 extensions (MetaMask, Rabby, Phantom EVM, OKX, Trust), locally bundled `@coinbase/wallet-sdk` (Coinbase Smart Wallet passkey/popup with zero extension required), `@walletconnect/ethereum-provider` (mobile/hardware QR), and W3C Solana Wallet Standard (Phantom, Backpack, Solflare, Jupiter, Glow).
- **Hardened Smart Contracts (`contracts/SiphonRouter.sol`, `contracts/SiphonFeeVault.sol`):** SafeERC20 wrappers for USDT compatibility, user aToken pull before Aave v3 withdrawal, exact swap balance deltas, isolated burn calls, bounded 5–10% protocol fee routing (`500–1000 bps`, default `700 bps` = 7.0%), multi-payee treasury vault splitting, and two-step ownership.

## Quick Start

```bash
npm install
npm run typecheck && npm run build && npm test
npm run start
# Open http://127.0.0.1:4420
```

## Production Environment Configuration

All variables are optional for local inspection and recommended for production traffic:

- **EVM RPC Overrides (primary before built-in 3-node failover):** `ETH_RPC_URL`, `BASE_RPC_URL`, `ARB_RPC_URL`, `OP_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL`
- **Solana RPC Override:** `SOLANA_RPC_URL` (Helius / QuickNode / Triton recommended for reliable Solana balance & USDC ATA checks)
- **L2 Arbitrary Token Discovery (all 6 EVM chains):** set any one of `SIM_API_KEY` (Dune Sim), `MORALIS_API_KEY`, or `ALCHEMY_API_KEY` (without these, Ethereum uses Ethplorer public discovery and L2s scan the curated DeFi + token registry)
- **LI.FI Bridge Aggregator:** `LIFI_API_KEY` (`x-lifi-api-key` header; avoids keyless IP rate limits on large wallets)
- **Mobile WalletConnect v2 QR:** `WALLETCONNECT_PROJECT_ID` (from Reown Cloud — can also be pasted directly inside the Wallet Modal)
- **Protocol Fee & Treasury (5–10%, default 7%):**
  - `SIPHON_FEE_BPS` — protocol fee in basis points, strictly clamped to `500–1000` (5%–10%, default `700` = 7.0%)
  - `SIPHON_FEE_RECIPIENT_EVM` — EVM smart contract (`SiphonFeeVault`) or treasury wallet address receiving the 5–10% fee via Relay native `appFees` or atomic EIP-5792 onchain splits
  - `SIPHON_FEE_DESTINATION_TYPE` — `contract` (default, `SiphonFeeVault`) or `wallet`
