# Turgalium — Zero-Fee Open-Source Multi-Chain Solana Migrator

[![License: MIT](https://img.shields.io/badge/License-MIT-0a0a0a.svg)](LICENSE)
[![Protocol Fee: 0%](https://img.shields.io/badge/Protocol%20Fee-0%25%20Free-059669.svg)](#)
[![Live App](https://img.shields.io/badge/Live%20App-turgalium.vercel.app-0369a1.svg)](https://turgalium.vercel.app)

**Bring every chain home to Solana — 0% protocol fees, 100% open source (MIT).**
*Named after Turgalium — the ancient homeland of Maximus Decimus Meridius.*

Turgalium is a free, MIT-licensed, non-custodial multi-chain portfolio migration engine that scans wallets across **30 live chains / 7 ecosystems** (**19 EVMs**, **6 Cosmos/IBC chains**, **Sui**, **Aptos**, **TON**, **Tron**, and **Bitcoin**), unwinds DeFi positions in 1 click, races cross-chain bridge routes in parallel for maximum net arrival, rescues batchable dust under a signed Two-Level Negative-ROI Guard, settles directly to your **Solana (USDC / SOL)** wallet with **0% protocol fees**, and includes Solana Rent Reclaim, Post-Arrival Yield Park, Stale ERC-20 Approval Revoker, Jupiter Prediction Markets, and Claude MCP / ChatGPT Actions.

- **Live App:** [https://turgalium.vercel.app](https://turgalium.vercel.app)
- **Repository:** [https://github.com/TrustlessMike/turgalium](https://github.com/TrustlessMike/turgalium)
- **License:** [MIT](LICENSE)

---

## Core Capabilities

### 1. 0% Protocol Fees, Parallel Route Auction & Solana Tools
- **0% Protocol Fee (`src/scanner/chains.ts`)**: Turgalium takes **zero protocol fee** (`0 bps` / `$0.00`). You pay only underlying network gas and bridge/DEX market quotes — 100% of net bridged funds land directly in your Solana wallet.
- **Live Parallel Route Auction (`src/execution/route-auction.ts`)**: Races **Circle CCTP V2 Fast Transfer (`minFinalityThreshold=1000`)**, **Mayan Swift**, **deBridge DLN**, **Relay**, and **LI.FI** in parallel, selecting strictly by highest net USD.
- **1-Click Empty-ATA SOL Rent Reclaim (`src/bridge/solana-rent.ts`)**: Reclaims `0.00203928 SOL` per empty SPL / Token-2022 account via compiled `VersionedTransaction` (`MessageV0`) with strict client-side `CloseAccount` & fee-payer verification.
- **1-Click Earn on Solana (`src/solana/yield-park.ts`)**: Parks 90% (or 100%) into **JupSOL**, **Jupiter Lend (`jlUSDC`)**, or **Kamino USDC**, paired with an optional capped **Jupiter Prediction Markets Degen Tab** (`src/degen/jupiter-markets.ts`).
- **1-Click Stale ERC-20 Approval Revoker (`src/scanner/approvals.ts`)**: Multicall3 allowance scan across all 19 EVM chains + EIP-5792 batch `approve(spender, 0)` revocation.

### 2. 30-Chain / 7-Ecosystem Discovery & Live Non-EVM Execution (`src/scanner/`, `src/adapters/`)
- **19 EVM Chains (12 on live Circle CCTP V2)**: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Sonic, Unichain, Linea, World Chain, **HyperEVM (`999`, CCTP V2 Domain 19)**, **Ink (`57073`, CCTP V2 Domain 21)**, plus BNB Chain, Scroll, Mantle, Blast, **Berachain (`80094`)**, **zkSync Era (`324`)**, and **Gnosis (`100`)**.
- **11 Non-EVM Chains across 6 Families**:
  - **Cosmos/IBC (6)**: Cosmos Hub, Osmosis, Noble (`0 bps` CCTP vs Skip Go auction), Celestia, Injective, Neutron — live LCD `account_number`/`sequence` + `signDirect`/Amino + real on-chain broadcast (`sendTx`/LCD).
  - **Bitcoin**: BIP-174 PSBT input parsing, UniSat / Xverse / Phantom BTC signing + `mempool.space` broadcast.
  - **Sui**: Parallel LI.FI + Mayan Swift + Circle CCTP Domain 8 auction.
  - **Aptos**: Panora DEX pre-swap chained into Circle CCTP Domain 9.
  - **TON & Tron**: Live TonConnect 2 & TronLink TVM execution.

### 3. 1-Click DeFi Protocol Extraction & Live Unlock-Queue Readers (`src/defi/`)
- **Extractors**: Aave v3 & v2 (safe partial exits keeping Health Factor ≥ 1.6), Compound v3 & v2 (supplied-balance capped via live `Comet.balanceOf` + `redeem` error-code & `exchangeRateStored` checks), ERC-4626 vaults (Morpho, Yearn, Spark `sDAI`, Sky, Fluid, Euler), and Uniswap v2/v3 / Aerodrome / Kodiak / Berachain BEX LPs.
- **Smart Exit Router & Live Unlock Readers**: Routes liquid yield receipts (`sUSDe`, `wstETH`, `rETH`, `cbETH`, `weETH`, `sDAI`, `sUSDS`) through direct swap to bypass cooldowns, and reads live on-chain **Lido Withdrawal Queue**, **Ethena `sUSDe` cooldowns**, and **Cosmos unbonding delegations**.

### 4. Hardened Solidity v2 Contracts & Foundry Verification (`contracts/`)
- **`TurgaliumRouter.sol`**: Disjoint swap-aggregator vs DeFi-protocol allowlists, Permit2 witness sweeps, explicit `directUsdcAmount`, `MIN_FEE_BPS = 0` zero-fee support, CCTP V2 Fast Transfer & hooks, and `TurgaliumAgentVault` mandate linkage.
- **`TurgaliumSweepDelegate.sol`**: EIP-7702 EOA delegation target with immutable canonical `usdc`/`cctpMessenger`, mandatory `policyRegistry` kill-switch, domain-separated `MANDATE_SWEEP_INTENT_TYPEHASH`, and approval revocations.
- **`TurgaliumAgentVault.sol`**: Policy-bounded agent mandates with immutable locked Solana recipient, per-tx & 24h USD caps, single-bit action bitmask, and strict router pinning.
- **`TurgaliumDelegateRegistry.sol` & `TurgaliumFeeVault.sol`**: Two-step governed allowlist & emergency pause kill-switch; push-DoS & blacklist-isolated vault contract.
- Verified with **37 Foundry unit/fuzz/exploit-proof tests** + **3 live Ethereum Mainnet-fork tests**.

### 5. Permissioned AI Agents: Claude MCP & ChatGPT Actions (`src/agent/`, `src/mcp/`)
- **Claude MCP (`POST /mcp` & `npm run mcp`)**: Exposes 10 scoped tools (`scan:read`, `dust:plan`, `agent:propose`) including `turgalium_preservation_audit`, `turgalium_list_unlock_schedule`, `turgalium_solana_rent_scan`, `turgalium_solana_yield_preview`, and read-only `turgalium_degen_markets`.
- **Production Hardening**: Atomic file-backed persistence (`TURGALIUM_DATA_DIR`) with corrupt-file quarantine, sliding-window rate limiter, RPC circuit breaker with URL redaction, fail-closed non-loopback admin auth, strict HTML/API CSP & CORP headers, Vercel adapter (`api/index.mjs`), `Dockerfile`, and `fly.toml`.

---

## Quick Start (Self-Host in 60 Seconds)

```bash
git clone https://github.com/TrustlessMike/turgalium.git
cd turgalium
npm install
npm run typecheck && npm run build && npm test
npm run start
# Open http://127.0.0.1:4420
```

### Run Smart Contract Foundry Tests & Headless Browser E2E

```bash
# Solidity unit + 256-run fuzz + adversarial proofs
forge build --sizes && forge test --no-match-contract TurgaliumMainnetFork -vv

# Optional live Ethereum Mainnet fork test
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract TurgaliumMainnetFork -vv

# 9-suite Playwright E2E (desktop 1440px, tablet 900px, mobile 390px)
pip install playwright && playwright install chromium
python3 tests/e2e-playwright.py
```

### Connect Claude Code / Claude Desktop via MCP

```bash
# HTTP MCP (while Turgalium server is running on 127.0.0.1:4420)
claude mcp add --transport http turgalium http://127.0.0.1:4420/mcp

# Or stdio MCP proxy pointing to the running Turgalium server
TURGALIUM_API_URL=http://127.0.0.1:4420 npm run mcp
```

---

## Configuration & Contributing

- See [`.env.example`](.env.example) for optional self-hosting environment variables (`TURGALIUM_ADMIN_SESSION_TOKEN`, `TURGALIUM_DATA_DIR`, custom RPC URLs, indexers, `JUPITER_API_KEY`, `ENSO_API_KEY`, `TURGALIUM_PAYMASTER_URL`). No fee or treasury variables are required — Turgalium runs at **0% protocol fees** out of the box.
- Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security Notice

Turgalium interacts with real on-chain assets and smart contracts. While the codebase includes extensive automated adversarial backtests (**227 Node/TS tests**, **37 Foundry unit/fuzz/fork proofs**, and **9 Playwright E2E suites**), **the Solidity contracts have not yet undergone an independent external third-party audit**. Always verify transactions in your wallet and test with small amounts before executing large mainnet migrations. See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

[MIT](LICENSE) — free to use, modify, and self-host with 0% protocol fees.
