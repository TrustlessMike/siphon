# Turgalium — Zero-Fee Open-Source Multi-Chain Solana Migrator

[![License: MIT](https://img.shields.io/badge/License-MIT-0a0a0a.svg)](LICENSE)
[![CI](https://github.com/TrustlessMike/turgalium/actions/workflows/ci.yml/badge.svg)](https://github.com/TrustlessMike/turgalium/actions/workflows/ci.yml)
[![Protocol Fee: 0%](https://img.shields.io/badge/Protocol%20Fee-0%25%20Free-059669.svg)](#)
[![Live App](https://img.shields.io/badge/Live%20App-turgalium.vercel.app-0369a1.svg)](https://turgalium.vercel.app)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTrustlessMike%2Fturgalium)

**Bring every chain home to Solana — 0% protocol fees, 100% open source (MIT).**
*Named after Turgalium — the ancient homeland of Maximus Decimus Meridius.*

Turgalium is a free, MIT-licensed, non-custodial multi-chain portfolio migration engine that scans wallets across **30 live chains / 7 ecosystems** (**19 EVMs**, **6 Cosmos/IBC chains**, **Sui**, **Aptos**, **TON**, **Tron**, and **Bitcoin**), unwinds DeFi positions in 1 click, races cross-chain bridge routes in parallel for maximum net arrival, rescues batchable dust under a signed Two-Level Negative-ROI Guard, settles directly to your **Solana (USDC / SOL)** wallet with **0% protocol fees**, and includes 1-Click Multi-Chain Sweep, Solana Rent Reclaim, Solana SPL Dust Consolidation, 100% Principal-Safe Post-Arrival Yield Park, Safe Multisig Batch Export, Migration Tax Export, Stale ERC-20 Approval Revoker, and Claude MCP / ChatGPT Actions.

- **Live App:** [https://turgalium.vercel.app](https://turgalium.vercel.app)
- **Repository:** [https://github.com/TrustlessMike/turgalium](https://github.com/TrustlessMike/turgalium)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)
- **License:** [MIT](LICENSE)

---

## Core Capabilities

### 1. 0% Protocol Fees, Parallel Route Auction & Solana Tools
- **0% Protocol Fee (`src/scanner/chains.ts`)**: Turgalium takes **zero protocol fee** (`0 bps` / `$0.00`). You pay only underlying network gas and bridge/DEX market quotes — 100% of net bridged funds land directly in your Solana wallet.
- **Live Parallel Route Auction (`src/execution/route-auction.ts`)**: Races **Circle CCTP V2 Fast Transfer (`minFinalityThreshold=1000`)**, **Mayan Swift**, **deBridge DLN**, **Relay**, and **LI.FI** in parallel, selecting strictly by highest net USD.
- **1-Click Empty-ATA SOL Rent Reclaim (`src/bridge/solana-rent.ts`)**: Reclaims `0.00203928 SOL` per empty SPL / Token-2022 account via compiled `VersionedTransaction` (`MessageV0`) with strict client-side `CloseAccount` & fee-payer verification.
- **Solana SPL Dust Consolidation**: Batch-sweeps scattered low-value SPL & Token-2022 balances directly into SOL or USDC with ROI guardrails and optional empty-account rent recovery.
- **1-Click Multi-Chain Sweep UX**: Connecting an EVM wallet or selecting an address automatically hydrates your scan and optimal route plan in one round-trip. A single primary **1-Click Sweep** action prepares all selected profitable assets in parallel, displays a concise single-card pre-sign summary (total net USD arriving on Solana, `0%` Turgalium fee, exact signature count, chains covered), and runs through wallet signing, automatic chain switching, and live batch finality tracking.
- **1-Click Earn on Solana (`src/solana/yield-park.ts`)**: Parks **100% principal-safe** arrived USDC directly into **JupSOL**, **Jupiter Lend (`jlUSDC`)**, or **Kamino USDC** with live APY quotes and 1-click VersionedTransaction signing.
- **Safe Multisig Batching & Tax / Accounting Export**: Export multi-step EVM migration plans as **Safe Transaction Builder** JSON batches for multisig treasuries, and download timestamped migration receipts (source chains, gross/net USD, gas & bridge fees, tx hashes, and Solana settlement details) as CSV/JSON for tax & accounting reconciliation.
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
- **Extractors**: Aave v3 & v2 (safe partial exits keeping Health Factor >= 1.6), Compound v3 & v2 (supplied-balance capped via live `Comet.balanceOf` + `redeem` error-code & `exchangeRateStored` checks), ERC-4626 vaults (Morpho, Yearn, Spark `sDAI`, Sky, Fluid, Euler), and Uniswap v2/v3 / Aerodrome / Kodiak / Berachain BEX LPs.
- **Smart Exit Router & Live Unlock Readers**: Routes liquid yield receipts (`sUSDe`, `wstETH`, `rETH`, `cbETH`, `weETH`, `sDAI`, `sUSDS`) through direct swap to bypass cooldowns, and reads live on-chain **Lido Withdrawal Queue**, **Ethena `sUSDe` cooldowns**, and **Cosmos unbonding delegations**.

### 4. Hardened Solidity v2 Contracts & Foundry Verification (`contracts/`)
- **`TurgaliumRouter.sol`**: Disjoint swap-aggregator vs DeFi-protocol allowlists, Permit2 witness sweeps, explicit `directUsdcAmount`, `MIN_FEE_BPS = 0` zero-fee support, CCTP V2 Fast Transfer & hooks, and `TurgaliumAgentVault` mandate linkage.
- **`TurgaliumSweepDelegate.sol`**: EIP-7702 EOA delegation target with immutable canonical `usdc`/`cctpMessenger`, mandatory `policyRegistry` kill-switch, domain-separated `MANDATE_SWEEP_INTENT_TYPEHASH`, and approval revocations.
- **`TurgaliumAgentVault.sol`**: Policy-bounded agent mandates with immutable locked Solana recipient, per-tx & 24h USD caps, single-bit action bitmask, and strict router pinning.
- **`TurgaliumDelegateRegistry.sol` & `TurgaliumFeeVault.sol`**: Two-step governed allowlist & emergency pause kill-switch; push-DoS & blacklist-isolated vault contract.
- Verified with **37 Foundry unit/fuzz/exploit-proof tests** + **3 live Ethereum Mainnet-fork tests**.

### 5. Permissioned AI Agents, Public SDK & Production Hardening (`src/agent/`, `src/mcp/`, `src/sdk/`)
- **Claude MCP (`POST /mcp` & `npx turgalium-mcp`)**: Exposes scoped read/propose tools (`scan:read`, `dust:plan`, `agent:propose`) including `turgalium_preservation_audit`, `turgalium_list_unlock_schedule`, `turgalium_solana_rent_scan`, and `turgalium_solana_yield_preview`.
- **Public TypeScript SDK (`src/sdk/index.ts`)**: Import the scanner, chain registry, parallel route auction, batch transaction preparer, CCTP V2 builder, Solana rent/yield tools, and server/MCP factories directly from `turgalium-migrator`.
- **Production Hardening**: Atomic file-backed persistence (`TURGALIUM_DATA_DIR`) with corrupt-file quarantine, sliding-window rate limiter, RPC circuit breaker with URL redaction, fail-closed non-loopback admin auth, strict HTML/API CSP & CORP headers, Vercel adapter (`api/index.mjs`), multi-stage Node 22 `Dockerfile`, `docker-compose.yml`, and `fly.toml`.

### 6. Condensed Batch Backend APIs (`src/server/app.ts`)
Turgalium batches multi-step wallet hydration, transaction preparation, Solana overview, bridge finality polling, and AI handoff into condensed server-side endpoints with in-flight request deduplication and short TTL caching (`refresh: true` bypasses caches):

| Endpoint | Purpose | Key Request / Response Fields |
| :--- | :--- | :--- |
| `POST /api/workspace/hydrate` | Single round-trip wallet load (scan + route plan + preservation + optional Solana overview) | Req: `{ address?, presetId?, family?, chains?, refresh?, solanaDestination?, outputAsset?, bridgePreference?, includeSolanaOverview? }` → Res: `{ cached, timingMs: { total, scan, plan, solana }, scan, plan, preservation, solanaBalances, solanaOverview }` |
| `POST /api/tx/prepare-batch` | Parallel transaction preparation + optional DeFi preflight across up to 12 selected assets | Req: `{ assets, userAddress, solanaDestination, outputAsset?, bridgePreference?, hasSolanaUsdcAta?, includePreflight? }` → Res: `{ preparedAt, durationMs, count, readyCount, failedCount, totalNetUsd, totalGasUsd, totalProtocolFeeUsd: 0, totalSignatures, items }` |
| `POST /api/solana/overview` | Single-call Solana wallet hydration (SOL/USDC balances + SPL dust scan + live yield APYs) | Req: `{ address, dustMaxUsd?, dustOutputAsset? }` → Res: `{ address, durationMs, balances, dust, yieldStrategies, rpcUnavailable }` |
| `POST /api/bridge/status-batch` | Parallel cross-chain finality & bridge fill polling for all in-flight legs in 1 request | Req: `{ bridges: [{ id?, chain, txHash, provider?, requestId?, solanaDestination? }] }` → Res: batched per-leg settlement statuses |
| `POST /api/agent/handoff` | Non-custodial read-only AI review & handoff kit for Claude / ChatGPT assistants | Req: `{ wallet?, family?, solanaDestination?, outputAsset?, agentName?, note? }` → Res: scoped workspace hydration URL, MCP/OpenAPI prompts & read-only instructions |

---

## Quick Start (Local Node.js)

```bash
git clone https://github.com/TrustlessMike/turgalium.git
cd turgalium
npm install
npm run typecheck && npm run build && npm test
npm run start
# Open http://127.0.0.1:4420
```

## Self-Hosting with Docker (`docker compose up`)

Turgalium ships with a hardened multi-stage `node:22-slim` [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) (non-root user, persistent `/data` volume, `/api/health` healthcheck, fail-closed auth), and [`fly.toml`](fly.toml).

```bash
# 1. Copy optional configuration (RPC overrides, relayer key, API keys)
cp .env.example .env

# 2. Launch Turgalium + optional gasless relayer in 1 command
TURGALIUM_ADMIN_SESSION_TOKEN="$(openssl rand -hex 32)" docker compose up -d --build

# 3. Verify health
curl -fsS http://127.0.0.1:4420/api/health
```

To enable the optional self-hosted EIP-7702 gasless relayer, set `TURGALIUM_RELAYER_PRIVATE_KEY` and your deployed `TURGALIUM_ROUTER_*` / `TURGALIUM_DELEGATE_*` addresses in `.env` (never commit `.env`). For Fly.io deployments, follow the setup commands at the top of [`fly.toml`](fly.toml).

## Installing & Running MCP (`npx turgalium-mcp`)

Run Turgalium's stdio MCP server directly with `npx` (or point it at a running self-hosted Turgalium HTTP server):

```bash
# Run standalone stdio MCP server
npx turgalium-mcp

# Or proxy stdio MCP calls to a self-hosted Turgalium server
TURGALIUM_API_URL=http://127.0.0.1:4420 TURGALIUM_API_TOKEN="<bearer-token>" npx turgalium-mcp

# Register HTTP MCP in Claude Code (while server runs on 127.0.0.1:4420)
claude mcp add --transport http turgalium http://127.0.0.1:4420/mcp

# Or register stdio MCP in Claude Code
claude mcp add turgalium -- npx -y turgalium-mcp
```

### Public TypeScript SDK

```ts
import {
  scanUnifiedWallets,
  runLiveParallelRouteAuction,
  encodeCctpDepositForBurn,
  scanReclaimableSolanaRent,
  buildSolanaYieldParkPlan,
  createTurgaliumServer,
} from 'turgalium-migrator';
```

## Deterministic Foundry `CREATE2` Contract Deployment

[`contracts/script/DeployTurgaliumCreate2.s.sol`](contracts/script/DeployTurgaliumCreate2.s.sol) deterministically deploys `TurgaliumDelegateRegistry`, `TurgaliumRouter`, `TurgaliumSweepDelegate`, and `TurgaliumAgentVault` via `CREATE2` with **0 bps default fee**, built-in Circle CCTP V2 defaults across all 12 supported EVM mainnets, atomic allowlist wiring, two-step governance handoff (EOA or Safe multisig), and post-deploy sanity assertions.

```bash
# 1. Build contracts & verify unit/fuzz/adversarial tests
forge build --sizes && forge test --no-match-contract TurgaliumMainnetFork -vv

# 2. Dry-run CREATE2 deployment simulation against any RPC (no broadcast)
TURGALIUM_OWNER="0xYourOwnerOrSafeAddress" \
TURGALIUM_FEE_BPS=0 \
forge script contracts/script/DeployTurgaliumCreate2.s.sol:DeployTurgaliumCreate2 \
  --rpc-url "$BASE_RPC_URL" -vvv

# 3. Broadcast when ready (add --verify for block explorer verification)
TURGALIUM_OWNER="0xYourOwnerOrSafeAddress" \
TURGALIUM_FEE_BPS=0 \
forge script contracts/script/DeployTurgaliumCreate2.s.sol:DeployTurgaliumCreate2 \
  --rpc-url "$BASE_RPC_URL" --account deployer --broadcast
```

Supported optional overrides: `TURGALIUM_CREATE2_SALT`, `TURGALIUM_OWNER`, `TURGALIUM_FEE_RECIPIENT`, `TURGALIUM_RELAYER`, `TURGALIUM_FEE_BPS` (default `0`), `TURGALIUM_MAX_FEE_USDC_CAP`, `TURGALIUM_USDC`, `TURGALIUM_CCTP_MESSENGER`, and `TURGALIUM_CCTP_VERSION`.

### Running Mainnet Fork & Playwright E2E Tests

```bash
# Optional live Ethereum Mainnet fork test
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract TurgaliumMainnetFork -vv

# 9-suite Playwright E2E (desktop 1440px, tablet 900px, mobile 390px)
pip install playwright && playwright install chromium
python3 tests/e2e-playwright.py
```

---

## Configuration & Contributing

- See [`.env.example`](.env.example) for optional self-hosting environment variables (`TURGALIUM_ADMIN_SESSION_TOKEN`, `TURGALIUM_DATA_DIR`, custom RPC URLs, indexers, `JUPITER_API_KEY`, `ENSO_API_KEY`, `TURGALIUM_RELAYER_PRIVATE_KEY`). No fee or treasury variables are required — Turgalium runs at **0% protocol fees** out of the box.
- Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Security Notice

Turgalium interacts with real on-chain assets and smart contracts. While the codebase includes extensive automated adversarial backtests (**227 Node/TS tests**, **37 Foundry unit/fuzz/fork proofs**, and **9 Playwright E2E suites**), **the Solidity contracts have not yet undergone an independent external third-party audit**. Always verify transactions in your wallet and test with small amounts before executing large mainnet migrations. See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

[MIT](LICENSE) — free to use, modify, and self-host with 0% protocol fees.
