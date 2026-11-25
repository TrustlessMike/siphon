# Siphon — Multi-Chain DeFi & Dust Migrator to Solana

**One Chain. Fresh Start.**

Siphon is an open-source, multi-ecosystem portfolio migration engine that scans wallets across **25 chains / 7 ecosystems** (14 EVMs, 6 Cosmos/IBC chains, Sui, Aptos, TON, Tron, and Bitcoin), unwinds DeFi positions with 1-click guided extraction, rescues batchable dust under a signed Two-Level Negative-ROI Guard, bridges assets into native Solana **USDC** or **SOL**, and exposes policy-bounded smart-contract agent mandates with **Claude MCP** and **ChatGPT Action** support.

---

## Core Capabilities

### 1. Simple 1-Click DeFi Protocol Asset Extraction (`src/defi/`, `src/execution/tx-builder.ts`)
- **Modular Protocol Extractors:** Aave v3 & v2 (including safe partial exits maintaining Health Factor ≥ 1.6 when active debt exists and fail-closed RPC borrow guards), Compound v3 & v2 (`Comet.withdraw` / `cToken.redeem` with borrow guards), ERC-4626 vaults (Morpho, Yearn v3, Spark, Sky, Fluid, Euler with `convertToAssets`/`previewRedeem`/`maxRedeem` pricing), and Uniswap v2/v3 & Aerodrome LP position extractors.
- **Smart Exit Router (Direct Swap vs Protocol Unwind):** Automatically routes liquid yield receipts (`sUSDe`, `wstETH`, `rETH`, `cbETH`, `weETH`, `ezETH`, `sDAI`, `sUSDS`) through direct swap & bridge to bypass withdrawal cooldowns (like Ethena's 7-day unstake lock) and minimize gas.
- **Live `eth_call` Pre-Flight Verification & 1-Click Chaining:** Simulates DeFi exits before signing and chains Withdraw → Swap → Bridge atomically in EIP-5792 batches (with a guided auto-advancing stepper for legacy wallets and protocol-grouped quick-unwind cards in the UI).

### 2. 25-Chain / 7-Ecosystem Discovery & Unified Multi-Wallet Scanning (`src/scanner/`, `src/adapters/`)
- **14 EVM Chains:** Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Chain, Sonic, Unichain, Linea, Scroll, Mantle, Blast, and World Chain with multi-RPC failover and Multicall3 scanning.
- **6 Non-EVM Ecosystems:** Cosmos/IBC (Cosmos Hub, Osmosis, Noble, Celestia, Injective, Neutron), Sui, Aptos, TON, Tron, and Bitcoin.
- **Multi-Wallet Unification (`src/scanner/unify.ts`):** Scan and unify multiple wallets across ecosystems in one view while keeping per-`(sourceWallet, chain)` atomic batching boundaries intact.

### 3. Signed Two-Level Negative-ROI Guard & Dust Converter (`src/scanner/roi.ts`, `src/scanner/dust.ts`)
- Preserves **signed** `netRoiUsd` (`worth_it` / `low_efficiency` / `negative_roi`) across Level 1 marginal per-asset ROI and Level 2 monotonic chain-batch rescue economics.
- Accounts for swap gas, L1 data/blob fees, liquidity-scaled slippage, bridge fixed fees, one-time Solana USDC ATA rent, live-quote >50% haircut gates, and 1.5× relayer break-even solvency.
- Dedicated **Dust Converter** identifies batch-rescuable small balances and skips value-destroying micro-dust automatically.

### 4. Hardened Smart Contracts, Circle CCTP & Real-Time Proofs (`contracts/`, `src/bridge/`, `src/execution/`, `src/relayer/`)
- **`SiphonRouter.sol`**: Split swap-aggregator vs DeFi-protocol allowlists, Permit2 witness-bound sweeps, isolated burn calls, and bounded 5–10% (`500–1000 bps`) protocol fee routing.
- **`SiphonSweepDelegate.sol`**: EIP-7702 EOA delegation target with EIP-712 `SweepIntent` (`callsHash` bound), slippage protection against pre-existing EOA USDC cannibalization, and approval revocation hygiene.
- **`SiphonAgentVault.sol`**: Policy-bounded agent mandates with immutable locked Solana recipient, per-tx & rolling 24h USD caps, single-bit action bitmask validation, and authorized router guards.
- **`SiphonFeeVault.sol`**: Reentrancy-guarded multi-payee basis-point fee splitter.
- **Circle CCTP Bridge (`src/bridge/cctp.ts`)**: Derives the canonical 32-byte **Solana USDC Associated Token Account (ATA) PDA** for `mintRecipient` and handles CCTP V1 & V2 chain configurations.
- **Pre-Sign & Post-Execution Proof Engine (`src/execution/proof.ts`)**: Live `eth_call` pre-sign simulation checking JSON-RPC revert errors and on-chain receipt + Solana balance verification.

### 5. Permissioned AI Agents: Claude MCP & ChatGPT Actions (`src/agent/`, `src/mcp/`)
- **Claude MCP (`POST /mcp` & `npm run mcp` stdio proxy):** Exposes read-only scanning, dust planning, mandate inspection, and human-permissioned sweep proposals (mandate creation is strictly owner-only in the UI/on-chain — never exposed to AI tool calls).
- **ChatGPT Action Spec:** Serves `/.well-known/ai-plugin.json` and `/openapi.json` (OpenAPI 3.1.0 with `x-openai-isConsequential` annotations).
- **Localhost Security Hardening:** Loopback CORS/Host validation (DNS-rebinding defense), `Content-Type` CSRF checks, owner admin session & scoped Bearer token authentication, bounded LRU/TTL caches, and strict DOM XSS escaping.

---

## Quick Start

```bash
git clone https://github.com/TrustlessMike/siphon.git
cd siphon
npm install
npm run typecheck && npm run build && npm test
npm run start
# Open http://127.0.0.1:4420
```

### Run End-to-End Headless Browser Tests (Playwright)

```bash
pip install playwright && playwright install chromium
python3 tests/e2e-playwright.py
```

### Connect Claude Code / Claude Desktop via MCP

```bash
# HTTP MCP (while Siphon server is running on 127.0.0.1:4420)
claude mcp add --transport http siphon http://127.0.0.1:4420/mcp

# Or stdio MCP proxy pointing to the running Siphon server
SIPHON_API_URL=http://127.0.0.1:4420 npm run mcp
```

---

## Configuration (Optional Environment Variables)

All variables are optional for local inspection and recommended for production deployments:

- **Server & Auth:**
  - `PORT` (default `4420`), `HOST` (default `127.0.0.1`)
  - `SIPHON_ADMIN_SESSION_TOKEN` — enforces `X-Siphon-Admin-Session` on owner admin endpoints
  - `SIPHON_REQUIRE_PLUGIN_AUTH` — require scoped Bearer token on `/mcp` and plugin endpoints
  - `SIPHON_ALLOWED_ORIGIN` — additional allowed CORS origin beyond loopback
- **EVM & Solana RPCs:** `ETH_RPC_URL`, `BASE_RPC_URL`, `ARB_RPC_URL`, `OP_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL`, `SOLANA_RPC_URL`
- **L2 Arbitrary Token Indexers:** `SIM_API_KEY` (Dune Sim), `MORALIS_API_KEY`, or `ALCHEMY_API_KEY`
- **Bridge & Wallet SDKs:** `LIFI_API_KEY`, `WALLETCONNECT_PROJECT_ID`
- **Protocol Fee & Router Deployment:**
  - `SIPHON_FEE_BPS` — clamped to `500–1000` (5%–10%, default `700`)
  - `SIPHON_FEE_RECIPIENT_EVM` — server-configured treasury wallet or `SiphonFeeVault` address (client overrides rejected)
  - `SIPHON_FEE_DESTINATION_TYPE` — `contract` (default) or `wallet`
  - `SIPHON_ROUTER_<CHAIN>` — deployed `SiphonRouter` address per EVM chain (e.g., `SIPHON_ROUTER_BASE`)

---

## Project Structure

```text
contracts/          Solidity smart contracts (SiphonRouter, SiphonSweepDelegate, SiphonAgentVault, SiphonFeeVault)
public/             Frontend web console, multi-ecosystem wallet connectors, 3D/SVG visuals, protocol logos
src/adapters/       7-ecosystem chain adapters (EVM, Cosmos, Sui, Aptos, TON, Tron, Bitcoin)
src/agent/          Off-chain mandate policy engine & OpenAPI/ChatGPT plugin specs
src/bridge/         Circle CCTP ATA PDA derivation, V1/V2 calldata & Iris attestation tracking
src/client/         Bundled browser wallet SDK entrypoint (Coinbase Smart Wallet + WalletConnect)
src/defi/           Modular DeFi protocol extractors & live eth_call pre-flight verifier
src/execution/      Transaction builder, EIP-5792 batching & pre/post proof engine
src/mcp/            Claude MCP JSON-RPC 2.0 server (HTTP + stdio proxy)
src/relayer/        Gasless EIP-712 Permit2 / EIP-7702 intent builder & ecrecover verifier
src/scanner/        Multicall3 scanner, discovery, Two-Level ROI engine, dust converter & wallet unifier
src/server/         HTTP API server, bounded LRU/TTL cache & background settlement job store
tests/              Unit, adversarial security, DeFi backtest, ROI/job stress & Playwright E2E suites
```

---

## Security Notice

Siphon interacts with real on-chain assets and smart contracts. While the codebase includes extensive automated adversarial backtests and security hardening, **the Solidity contracts have not yet undergone an independent external third-party audit**. Always verify transactions in your wallet and test with small amounts before deploying or executing large mainnet migrations. See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

[MIT](LICENSE)
