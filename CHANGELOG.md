# Changelog

All notable changes to Turgalium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-26

### Highlights
- **Zero-Fee MIT Open-Source 30-Chain Launch**: Turgalium charges **0% protocol fees (`0 bps`)** out of the box across all 30 supported chains and 7 blockchain ecosystems — 100% of net bridged funds settle directly to your Solana wallet.

### Added
- **30-Chain / 7-Ecosystem Discovery & Live Execution**:
  - **19 EVM chains** (12 on live Circle CCTP V2: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Sonic, Unichain, Linea, World Chain, HyperEVM `999`, and Ink `57073`, plus BNB Chain, Scroll, Mantle, Blast, Berachain `80094`, zkSync Era `324`, and Gnosis `100`).
  - **11 non-EVM chains across 6 families**: Cosmos/IBC (Cosmos Hub, Osmosis, Noble, Celestia, Injective, Neutron), Bitcoin (BIP-174 PSBT + `mempool.space`), Sui, Aptos (Panora + CCTP), TON (TonConnect 2), and Tron (TronLink TVM).
- **Live Parallel Route Auction & Two-Level ROI Guard**:
  - Races **Circle CCTP V2 Fast Transfer (`minFinalityThreshold=1000`)**, **Mayan Swift**, **deBridge DLN**, **Relay**, and **LI.FI** in parallel, selecting strictly by highest net USD arrival.
  - Signed Two-Level Negative-ROI Guard with automatic dust batching (`EIP-5792` / `EIP-7702`) and dynamic gas-reserve protection.
- **1-Click DeFi Extraction & Live Unlock-Queue Readers**:
  - Extractors for Aave v2/v3 (safe partial exits keeping Health Factor >= 1.6), Compound v2/v3, ERC-4626 vaults (Morpho, Yearn, Spark `sDAI`, Sky, Fluid, Euler), and Uniswap v2/v3 / Aerodrome / Kodiak / BEX LPs.
  - Live on-chain readers for Ethereum Lido Withdrawal Queue NFTs, Ethena `sUSDe` cooldowns, and Cosmos staking unbonding delegations.
- **Solana Native Tools & Post-Arrival Workflows**:
  - **Empty-ATA SOL Rent Reclaim**: Reclaims `0.00203928 SOL` per empty SPL / Token-2022 account via compiled `VersionedTransaction` (`MessageV0`) with strict client-side `CloseAccount` verification.
  - **Solana SPL Dust Consolidation**: Batch-consolidates small SPL / Token-2022 balances into SOL or USDC with Jupiter routing and ROI protection.
  - **Solana Yield Park & Prediction Markets**: 1-click post-arrival split into **JupSOL**, **Jupiter Lend (`jlUSDC`)**, or **Kamino USDC**, plus optional read-only/capped Jupiter Prediction Markets support.
- **Wallet Hygiene, Treasury & Accounting**:
  - **Stale ERC-20 Approval Revoker**: Multicall3 allowance scan across all 19 EVM chains with EIP-5792 batch `approve(spender, 0)` revocations.
  - **Safe Multisig Batch Support**: Export and execute multi-step migration transactions as Safe Transaction Builder JSON batches.
  - **Migration Tax & Accounting Export**: Export timestamped multi-chain migration receipts, cost basis, gas fees, and destination settlement records as CSV/JSON.
- **Hardened Solidity v2 Suite & Deterministic Foundry CREATE2 Deployment**:
  - `TurgaliumRouter`, `TurgaliumSweepDelegate` (EIP-7702), `TurgaliumAgentVault`, `TurgaliumDelegateRegistry`, and `TurgaliumFeeVault` verified with unit, fuzz, adversarial exploit-proof, and Ethereum Mainnet-fork tests.
  - Added `contracts/script/DeployTurgaliumCreate2.s.sol` for deterministic multi-chain `CREATE2` deployment with `0 bps` default fee, per-chain Circle CCTP V2 defaults, atomic allowlist wiring, two-step governance handoff, and post-deploy sanity assertions.
- **Public SDK, Claude MCP Package & Self-Hosting**:
  - Public TypeScript SDK entrypoint (`src/sdk/index.ts`, exported via `"."`) and `turgalium-mcp` CLI binary (`npx turgalium-mcp` / `"./mcp"`).
  - Production multi-stage `node:22-slim` `Dockerfile`, one-command `docker-compose.yml` (with persistent `/data` volume, non-root user, fail-closed auth, and `/api/health` healthcheck), `.dockerignore`, and `fly.toml`.
  - Community templates (`.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`) and Contributor Covenant v2.1 `CODE_OF_CONDUCT.md`.
