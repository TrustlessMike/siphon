# Turgalium — Multi-Chain Capital Preservation & Solana Migrator

**One Chain. Fresh Start. Bring Every Chain Home to Solana.**
*Named after Turgalium — the ancient homeland of Maximus Decimus Meridius.*

Turgalium is an open-source, preservation-first multi-ecosystem portfolio migration engine that scans wallets across **30 live chains / 7 ecosystems** (**19 EVMs**, **6 Cosmos/IBC chains**, **Sui**, **Aptos**, **TON**, **Tron**, and **Bitcoin**), unwinds DeFi positions in 1 click, auctions cross-chain routes in parallel for maximum net arrival, rescues batchable dust under a signed Two-Level Negative-ROI Guard, settles natively on **Solana (USDC / SOL)**, and pairs 90% principal yield preservation with an optional capped **Jupiter Degen Tab** plus policy-bounded smart-contract agent mandates (**Claude MCP** & **ChatGPT Actions**).

---

## Core Capabilities

### 1. Capital-Preservation Routing, Tiered Fees & 1-Click Solana Post-Arrival Tools
- **Live Parallel Route Auction (`src/execution/route-auction.ts`)**: Races **Circle CCTP V2 Fast Transfer / Standard (`0–1.4 bps`)**, **Mayan Swift**, **deBridge DLN**, **Relay**, and **LI.FI** in parallel, selecting strictly by highest net USD.
- **Preservation-First Progressive Fee Schedule (`src/scanner/chains.ts`)**: Preserves **99.5%+** on principal migrations (`0.10%` capped at `$50`, `0.25%` mid-tier, `0 bps` self-custody option; `5%` only on `<$50` micro-dust gasless rescue).
- **1-Click Empty-ATA SOL Rent Vacuum (`src/bridge/solana-rent.ts`)**: Reclaims `0.00203928 SOL` per empty SPL / Token-2022 account via compiled `VersionedTransaction` (`MessageV0`) with strict client-side `CloseAccount` & fee-payer verification.
- **1-Click Post-Arrival Yield Park (`src/solana/yield-park.ts`)**: Parks 90% (or 100%) into **JupSOL**, **Jupiter Lend (`jlUSDC`)**, or **Kamino USDC**, paired with an optional **Jupiter Prediction Markets & Arcade Degen Tab** (`src/degen/jupiter-markets.ts`) capped at 10% default / 50% hard max.
- **1-Click Stale ERC-20 Approval Revoker (`src/scanner/approvals.ts`)**: Multicall3 allowance scan + EIP-5792 batch `approve(spender, 0)` revocation.

### 2. 30-Chain / 7-Ecosystem Discovery & Live Non-EVM Execution (`src/scanner/`, `src/adapters/`)
- **19 EVM Chains (12 on live Circle CCTP V2)**: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Sonic, Unichain, Linea, World Chain, **HyperEVM (`999`, CCTP V2 Domain 19)**, **Ink (`57073`, CCTP V2 Domain 21)**, plus BNB Chain, Scroll, Mantle, Blast, **Berachain (`80094`)**, **zkSync Era (`324`)**, and **Gnosis (`100`)**.
- **11 Non-EVM Chains across 6 Families**:
  - **Cosmos/IBC (6)**: Cosmos Hub, Osmosis, Noble (`0 bps` CCTP vs Skip Go auction), Celestia, Injective, Neutron — live LCD `account_number`/`sequence` + `signDirect`/Amino + real on-chain broadcast (`sendTx`/LCD).
  - **Bitcoin**: BIP-174 PSBT input parsing, UniSat / Xverse / Phantom BTC signing + `mempool.space` broadcast.
  - **Sui**: Parallel LI.FI + Mayan Swift + Circle CCTP Domain 8 auction.
  - **Aptos**: Panora DEX pre-swap chained into Circle CCTP Domain 9.
  - **TON & Tron**: Live TonConnect 2 & TronLink TVM execution.

### 3. 1-Click DeFi Protocol Extraction & Live Unlock-Queue Readers (`src/defi/`)
- **Extractors**: Aave v3 & v2 (safe partial exits keeping Health Factor ≥ 1.6), Compound v3 & v2 (supplied-balance capped so over-withdrawals can never open debt), ERC-4626 vaults (Morpho, Yearn, Spark `sDAI`, Sky, Fluid, Euler), and Uniswap v2/v3 / Aerodrome / Kodiak LPs.
- **Smart Exit Router & Live Unlock Readers**: Routes liquid yield receipts (`sUSDe`, `wstETH`, `rETH`, `cbETH`, `weETH`, `sDAI`, `sUSDS`) through direct swap to bypass cooldowns, and reads live on-chain **Lido Withdrawal Queue**, **Ethena `sUSDe` cooldowns**, and **Cosmos unbonding delegations**.

### 4. Hardened Solidity v2 Contracts & Foundry Mainnet-Fork Verification (`contracts/`)
- **`TurgaliumRouter.sol`**: Disjoint swap-aggregator vs DeFi-protocol allowlists, Permit2 witness sweeps, explicit `directUsdcAmount`, `MIN_FEE_BPS = 0` + whale `maxFeeUsdcCap`, CCTP V2 Fast Transfer & hooks, and `TurgaliumAgentVault` mandate linkage.
- **`TurgaliumSweepDelegate.sol`**: EIP-7702 EOA delegation target with immutable canonical `usdc`/`cctpMessenger`, mandatory `policyRegistry` kill-switch, domain-separated `MANDATE_SWEEP_INTENT_TYPEHASH`, and approval revocations.
- **`TurgaliumAgentVault.sol`**: Policy-bounded agent mandates with immutable locked Solana recipient, per-tx & 24h USD caps, single-bit action bitmask, and global router revocation.
- **`TurgaliumDelegateRegistry.sol` & `TurgaliumFeeVault.sol`**: Two-step governed allowlist & emergency pause kill-switch; push-DoS & blacklist-isolated multi-payee fee vault.
- Verified with **37 Foundry unit/fuzz/exploit-proof tests** + **3 live Ethereum Mainnet-fork tests**.

### 5. Permissioned AI Agents: Claude MCP & ChatGPT Actions (`src/agent/`, `src/mcp/`)
- **Claude MCP (`POST /mcp` & `npm run mcp`)**: Exposes 10 scoped tools (`scan:read`, `dust:plan`, `agent:propose`) including `turgalium_preservation_audit`, `turgalium_list_unlock_schedule`, `turgalium_solana_rent_scan`, `turgalium_solana_yield_preview`, and read-only `turgalium_degen_markets`.
- **Production Hardening**: Atomic file-backed persistence (`TURGALIUM_DATA_DIR`) with corrupt-file quarantine, sliding-window rate limiter, RPC circuit breaker with URL redaction, fail-closed non-loopback admin auth, strict HTML `Content-Security-Policy`, `Dockerfile`, and `fly.toml`.

---

## Quick Start

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

# 8-suite Playwright E2E (desktop 1440px, tablet 900px, mobile 390px)
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

## Configuration

See [`.env.example`](.env.example) for all optional production environment variables (server/auth `TURGALIUM_ADMIN_SESSION_TOKEN`, persistence `TURGALIUM_DATA_DIR`, RPC URLs, indexers, `JUPITER_API_KEY`, `ENSO_API_KEY`, `TURGALIUM_PAYMASTER_URL`, and treasury recipients).

---

## Security Notice

Turgalium interacts with real on-chain assets and smart contracts. While the codebase includes extensive automated adversarial backtests, 204 Node/TS tests, 37 Foundry unit/fuzz/fork proofs, and 8 Playwright E2E suites, **the Solidity contracts have not yet undergone an independent external third-party audit**. Always verify transactions in your wallet and test with small amounts before executing large mainnet migrations. See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

[MIT](LICENSE)
