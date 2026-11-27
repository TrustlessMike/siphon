# Turgalium — Product, Cost-Efficiency & Gap Research Report (2026)

> **Scope:** Deep codebase audit of `main` (`af526a0`) + unmerged `feat/cost-preservation-autopilot-agents` (`5a841a2`) benchmarked against live 2026 cross-chain, EVM account abstraction, and Jupiter/Solana infrastructure.
> **North Star:** Preserve maximum user capital (0% protocol fees, 99%+ net preservation on principal tiers, positive-ROI-only on dust) while compressing multi-chain migration to **1 click** and keeping **100% of migrated principal safely preserved and compounding** on Solana.

---

## 1. Executive Summary — Top 5 Highest-ROI Moves

Ranked by **Dollars Saved / UX Clicks Cut / Engineering Effort**:

| Rank | Move | Exact Capital Saved (bps / $) | UX Clicks Cut | Effort | Primary Anchors |
| :---: | :--- | :--- | :--- | :---: | :--- |
| **1** | **Progressive Tiered Protocol Fee + Hard Cap** (replace flat `500–1000 bps` floor across TS + Solidity) | **+650 to +695 bps** (**+$675** on $10k; **+$6,950** on $100k) — turns Turgalium from unusable >$1k into a 99.5%+ preservation migrator | 0 (removes #1 conversion blocker) | **S (1–2d)** | `src/scanner/chains.ts:7-9`, `contracts/TurgaliumRouter.sol:196-197`, `contracts/TurgaliumSweepDelegate.sol:112-113` |
| **2** | **Upgrade Major Chains to Circle CCTP V2 (`TokenMessengerV2`) + Fast Transfer + Forwarding Service + Live Parallel Route Auction** (Mayan Swift / deBridge DLN / Relay / CCTP V2) | **+10 to +25 bps** (**+$10–$25** on $10k; **+$100–$250** on $100k) vs current `Relay → LI.FI` waterfall; cuts ETH finality from **13m → ~15s** | **Cuts 1–2 clicks** (eliminates manual Solana `receiveMessage` claim + zero-SOL arrival trap) | **M (3–4d)** | `src/scanner/chains.ts:90-235`, `src/bridge/cctp.ts:156-172`, `src/execution/tx-builder.ts:1069-1186`, `public/wallets.js:238` (live V2 selector bug!) |
| **3** | **True 1-Click Solana Arrival (`VersionedTransaction` + ALTs + 100% Principal-Safe Yield Parking + SPL Dust & Rent Reclaim)** | **+6% to +9% APY** on 100% preserved principal (**+$1,500–$2,250/yr** on $25k) + **$4–$20** free SOL from empty-ATA rent recovery | **Cuts 3–5 clicks** (claim + yield deposit + dust/rent reclaim in 1-click Phantom/Solflare signing) | **M (3–5d)** | `src/bridge/solana-claim.ts:593-605`, `src/solana/yield-park.ts`, `src/bridge/solana-rent.ts` |
| **4** | **Fix On-Chain Security & Persistence Blockers Before Mainnet** (Foundry/Anvil forked-mainnet suite, wire `TurgaliumAgentVault` into Router/Delegate, Postgres/Redis state, rate limiting, fail-closed public deploy) | Prevents **catastrophic contract/quota exploits** (crash-reset of 24h mandate caps, unverified V2 CCTP selector, unbroadcast relayer stub) | Prevents dropped jobs & lost 17m ETH attestations | **L (5–7d)** | `contracts/*.sol`, `src/relayer/sponsor.ts:822-839`, `src/server/jobs.ts`, `src/agent/mandate-engine.ts`, `src/server/app.ts` |
| **5** | **True 1-Click Multi-Wallet & Mobile UX + Real EIP-5792 Paymaster + Dynamic Gas-Reserve Sweeping** | **+$8–$18** recovered stranded native gas dust per multi-chain wallet + **$1.50–$6/token** saved L1 approval gas via Permit2/EIP-2612 | **Cuts 2–6 clicks** (unified Phantom/Coinbase dual-VM connect, WalletConnect default ID, Phantom mobile deep-links, Paymaster URL) | **M (3–4d)** | `public/wallets.js:238,669-712,891-931,1108-1119`, `src/scanner/chains.ts:99-267`, `src/execution/tx-builder.ts:920-1067` |

> [!IMPORTANT]
> **Branch Status Note:** Unmerged branch `feat/cost-preservation-autopilot-agents` (`5a841a2`) already adds `src/execution/preservation-optimizer.ts` (static route-cost modeling + L1 gas-timing advisor + unlock schedule) and `src/agent/preservation-agents.ts` (bounded LRU gas-window watchdog). It should be merged cleanly first, then upgraded from *static fee heuristics* to **live parallel quote execution** and **persistent scheduled agents** per the tickets in Section 7.

---

## 2. Pillar 1 — Capital Preservation & Cost-Reduction Discoveries

### 2.1 Critical Finding: Flat 5%–10% Protocol Fee Floor Breaks Principal Preservation
- **Codebase Evidence:**
  - `src/scanner/chains.ts:7-9` hardcodes `MIN_PROTOCOL_FEE_BPS = 500` (5.0%), `DEFAULT_PROTOCOL_FEE_BPS = 700` (7.0%), `MAX_PROTOCOL_FEE_BPS = 1000` (10.0%).
  - `contracts/TurgaliumRouter.sol:196-197` and `contracts/TurgaliumSweepDelegate.sol:112-113` enforce `MIN_FEE_BPS = 500` on-chain (`FeeOutOfBounds` revert below 5%!).
  - `src/mcp/server.ts:90,141`, `src/agent/plugin-spec.ts:101,151`, and `public/index.html:431-437` clamp fees to `500–1000 bps`.
- **Economic Impact:** A 7% fee is rational *only* for gasless micro-dust rescue ($5–$100) where Turgalium's relayer fronts $0.50–$3.00 of gas and requires 1.5× break-even solvency (`src/scanner/roi.ts:38,685-770`). Applied flatly to principal migrations:
  - **$100 migration:** $7.00 protocol fee (700 bps).
  - **$10,000 migration:** **$700.00** protocol fee vs $3–$25 on Jumper/Relay/Mayan.
  - **$100,000 migration:** **$7,000.00** protocol fee — guaranteed 0% conversion for whales and violates the "keep 90%+ principal preserved" north star before bridge/swap costs even apply.
- **Recommended Progressive Preservation Fee Schedule:**
  - **Micro-Dust / Gasless Sponsored Tier (`< $100`):** `500–700 bps` (5–7%) to sustain 1.5× relayer solvency.
  - **Mid Tier (`$100 – $10,000` self-funded):** `25 bps` (0.25%), capped at `$15`.
  - **Principal / Whale Tier (`> $10,000` self-funded):** `5–10 bps` capped at **$25–$50 max** (or `0 bps` protocol fee on principal, zero protocol fee / open-source MIT model).
  - **Solidity Change:** Lower `MIN_FEE_BPS` to `0` in `TurgaliumRouter.sol` and `TurgaliumSweepDelegate.sol` (keeping `MAX_FEE_BPS = 1000` as an immutable user-protection ceiling), and add an optional `maxFeeUsdcCap` in `SweepParams`/`SweepIntent`.

### 2.2 Circle CCTP V1 Pinning & Missing CCTP V2 Fast Transfer + Forwarding Service
- **Codebase Evidence:**
  - `src/scanner/chains.ts:90-235`: Ethereum (`cctpVersion: 1`, `cctpAttestationSec: 780` = 13 min!), Base, Arbitrum, Optimism, Polygon, and Avalanche are **all pinned to legacy CCTP V1** `TokenMessenger` addresses. Only Sonic, Unichain, Linea, and World Chain use `cctpVersion: 2`.
  - `src/bridge/cctp.ts:156-172`, `src/execution/tx-builder.ts:1069-1075,1956-1962`, `contracts/TurgaliumRouter.sol:173,477-499`, `contracts/TurgaliumSweepDelegate.sol:111,313-340`: Even on V2 chains, Turgalium hardcodes `maxFee = 0` and `minFinalityThreshold = 2000` (Standard Slow finality). It never queries Circle's dynamic fee quote endpoint (`GET /v2/burn/USDC/fees/{sourceDomain}/{destDomain}`), never supports **Fast Transfer (`minFinalityThreshold = 1000`)**, and never integrates **Circle Forwarding Service (`depositForBurnWithHook` / `cctp-forward`)**.
- **Live 2026 Ecosystem Benchmark:**
  - Circle CCTP V2 is deployed via `CREATE2` at the identical canonical address **`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`** (`TokenMessengerV2`) across Ethereum (Domain 0), Avalanche (1), Optimism (2), Arbitrum (3), Base (6), Polygon (7), plus Sonic/Unichain/Linea/World Chain.
  - **CCTP V2 Standard:** **0 bps (0.00%)** protocol fee — exact 1:1 burn-and-mint.
  - **CCTP V2 Fast Transfer:** **~1.0 bps** on Ethereum, **~1.3 bps** on Base, **~1.4 bps** on Arbitrum (~8–20s soft-finality attestation backed by Circle's Fast Transfer Allowance instead of 13–19 minutes on Ethereum!).
  - **Circle Forwarding Service:** Automatically submits `receiveMessage` on Solana (and creates the recipient's USDC ATA if missing) for a small fixed USDC fee deducted at mint — eliminating BOTH the manual Solana claim popup AND the "0 SOL on destination" dead-end!

### 2.3 Waterfall Routing Instead of Live Parallel Quote Auction (Missing Direct Mayan Swift & deBridge DLN)
- **Codebase Evidence:**
  - `src/execution/tx-builder.ts:1132-1186` (`buildBridgeExecution`): In default `auto` mode, Turgalium executes a **blind waterfall**: try Relay → if null, try LI.FI → if null, fall back to CCTP. It **never compares live net output** across providers!
  - Even for **$100,000 of native USDC**, `auto` routes through Relay solver spread instead of 0 bps CCTP V2 Standard or 1 bps CCTP V2 Fast!
  - `src/execution/tx-builder.ts:662-1008`: Turgalium only integrates Relay and LI.FI directly. LI.FI charges up to **25 bps** aggregator fee on top of underlying bridges (Mayan/deBridge).
  - Unmerged `src/execution/preservation-optimizer.ts` (`5a841a2`) models route differences using hardcoded heuristic spreads (`relaySpreadBps`, `lifiSpreadBps = 15–17 bps`) — it does **not** drive live execution in `tx-builder.ts` and omits Mayan Swift and deBridge DLN.
- **2026 Route Benchmark by Migration Tier (EVM → Solana):**

| Tier | Asset Profile | Current Turgalium (`auto`) Cost | Optimal 2026 Route | Optimal Cost | Exact Savings (bps / $) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **$100** | L2 USDC or single token | Relay (~$0.25 + $7.00 fee = **$7.25**) | **Relay** (~$0.05–$0.18 + instant SOL gas drop) w/ tiered fee | **$0.18 – $1.50** (self-funded) | **+$0.15–$0.30** route + **$5.50** fee tier |
| **$100** | 5× L2 ERC-20 dust (no `ENSO_API_KEY`) | 5× Relay bridges (~$0.80–$1.50 bridge fees + 5× spreads) | **Single local multi-input swap** (Enso / Odos / 1inch) → **1× Relay** | **~$0.25** bridge + 1 swap gas | **+$0.60–$1.25** (+60–125 bps) & **4 fewer bridges** |
| **$10,000** | Native USDC (ETH/Base/Arb) | Relay (~10–20 bps = $10–$20) + $700 fee | **CCTP V2 Fast Transfer** (1–1.4 bps = $1.00–$1.40, ~15s) + Forwarding (~$0.50) | **~$1.50–$2.00** bridge (+$15–$25 capped fee) | **+$8.50–$18.50** route (**+9–19 bps**) + **+$675** fee |
| **$10,000** | Non-USDC (WETH/AERO/UNI) | Relay or LI.FI (~15–30 bps = $15–$30) + $700 fee | **Live Parallel Auction**: Mayan Swift (~3 bps) vs Relay vs deBridge DLN (~4 bps + ~$0.50) vs Local DEX + CCTP V2 Fast | **~$5–$12** total spread/bridge | **+$8–$20** route (**+8–20 bps**) + **+$675** fee |
| **$100,000** | Native USDC (ETH/Base/Arb) | Relay (~10–25 bps = $100–$250) + $7,000 fee | **CCTP V2 Standard** (**0 bps = $0.00**) or **CCTP V2 Fast** (1–1.4 bps = $10–$14) | **$0.00 – $14.00** bridge (+$25–$50 cap fee) | **+$86–$250** route (**+9–25 bps**) + **+$6,950** fee |
| **$100,000** | Non-USDC (WBTC/wstETH/WETH) | LI.FI / Relay (~15–35 bps = $150–$350) + $7,000 fee | **MEV-protected Local DEX Swap** (CoW Swap / 1inch Fusion / Enso) → **CCTP V2 Standard/Fast** | **~$15–$40** total | **+$110–$310** route (**+11–31 bps**) + **+$6,950** fee |

### 2.4 Every Additional Hidden Fee Leak Audited in the Codebase
1. **Stranded Static Native Gas Reserves (`src/scanner/chains.ts:99,127,155,183,212,240,267`):**
   - Turgalium permanently leaves behind static `gasReserveNative` (`0.002 ETH` ~$5–$6.50 on Ethereum, `0.0005 ETH` ~$1.25–$1.60 on Base/Arb/OP/Unichain/Blast/World, `0.0008 ETH` ~$2.00 on Linea/Scroll, `0.003 BNB` ~$1.80, `0.02 AVAX` ~$0.56). Across a 6-chain wallet, **$10–$18 of native gas is permanently stranded** even when actual remaining L2 tx gas is `< $0.03`.
   - **Fix:** Dynamically size gas reserve to `ceil(1.25 × exactEstimatedBatchGasUnits × liveGasPrice + l1DataFee)`, and sweep **100% of native gas to `0`** whenever EIP-7702 / Paymaster sponsorship is active!
2. **Double-Swap & N-Bridge Leak When `ENSO_API_KEY` Is Unset (`src/execution/tx-builder.ts:1242-1250,1601-1604`):**
   - Multi-input dust consolidation is hard-gated on `process.env.ENSO_API_KEY`. Without it, `prepareChainBatchExecution` sends every dust ERC-20 through an individual Relay/LI.FI cross-chain bridge, multiplying fixed bridge overhead by `N`.
   - **Fix:** Add a fallback local multi-input swap consolidator (Odos assemble API / KyberSwap / 1inch / TurgaliumRouter multi-swap) so N ERC-20s always collapse into 1 USDC bridge leg even without `ENSO_API_KEY`.
3. **Unnecessary On-Chain L1 ERC-20 Approvals (`src/execution/tx-builder.ts:920-942,1045-1067,2149-2170`):**
   - Turgalium detects `eip2612Supported` and `permit2Approved` in `dust.ts` and `tx-builder.ts:2149-2163`, yet `tryLifiBridgeQuote` and `buildDirectCctpUsdcExecution` still emit on-chain `approve()` txs (~46,000 gas = **$1.50–$6.00/token on L1**).
   - **Fix:** For EIP-2612 tokens (USDC, DAI, UNI, AAVE, LINK, wstETH, sUSDe, etc.) and Permit2-approved tokens, consume off-chain `permit` signatures inside `TurgaliumRouter` / Relay Permit2 mode, saving **46k gas + 1 popup per token**.
4. **Solana Priority Fees & Unreclaimed Empty-ATA Rent (`src/bridge/solana-claim.ts:593-605`):**
   - `buildSolanaCctpClaimInstructionPlan` emits a legacy `Transaction` with **zero `ComputeBudgetProgram` instructions** (no dynamic `setComputeUnitLimit` / `setComputeUnitPrice` via `getRecentPrioritizationFees`), risking dropped claims during congestion or blind overpaying.
   - **Zero Empty-ATA Rent Recovery:** Active Solana wallets accumulate 10–50 empty SPL Token Accounts (`amount === 0`), each locking **0.00203928 SOL (~$0.25–$0.40)**. Scanning and bundling `TokenProgram.closeAccount` instructions during arrival/claim recovers **$3–$20 of native SOL** automatically — funding ATA rent & tx fees for free!
5. **Non-EVM Cross-Chain Fee Leaks (`src/execution/non-evm-converter.ts:392,439,652`):**
   - `quoteLifiNonEvm` and `quoteSkipGoCosmos` hardcode a wide **2% (`0.02` / `'2'`) slippage tolerance**, exposing larger Cosmos/Sui/Tron swaps to MEV sandwiching! Slippage should scale dynamically by tier (`0.3%` for stables/majors >$1k, `0.5–1.0%` for mid-cap, `2.0%` only for illiquid micro-dust).
   - `quoteSkipGoCosmos` (`non-evm-converter.ts:571-583`) routes Cosmos → Solana via `smart_relay: true`, which is great for 1-sig UX, but never compares Noble native CCTP (`0 bps`) vs Skip Smart Relay fee on >$5k Noble USDC transfers.

---

## 3. Pillar 2 — 1-Click / Minimal-Click UX Friction Audit

### 3.1 Real User Journey Click-Count Trace (Lite & Pro)

Tracing `public/index.html` + `public/app.js` + `public/wallets.js` from landing to settled Solana USDC:

| Stage | Lite Mode Clicks | Pro Mode Clicks | Current Friction / Breakpoints |
| :--- | :---: | :---: | :--- |
| **1. Landing → App** | 1–2 | 1–2 | Must click Connect or Launch; pasting an address scans read-only, then still requires 2 wallet connects. |
| **2. Wallet Connect (EVM + Solana)** | **4–6** | **4–6** | Even for dual-chain wallets (**Phantom, OKX, Coinbase**), users must open the modal and connect **EVM** and **Solana** separately (`connectEvmBtn` + `connectSolBtn`). Manual Solana paste forces an extra checkbox (`manualDestConfirmChk`, `public/index.html:383-386`). |
| **3. DeFi Unwind** | **1–4/protocol** | **1–4/protocol** | On non-EIP-5792 wallets (Rabby legacy, hardware), `aave`/`compound`/`erc4626` withdraw runs first, waits for receipt, re-scans after 2.2s (`app.js:3364`), then prompts separate approve + bridge txs. |
| **4. Multi-Chain Sweep** | **1–2 per chain** | **1–2 per chain** | `executeSelectedLiveQueue` (`app.js:3475-3477`) loops sequentially across chains (`for (const chain of activeChains)`): wallet chain-switch prompt + batch/tx confirmation per chain, with **zero background pre-quoting** of chain `N+1` while chain `N` is signing. |
| **5. Solana CCTP Claim** | **3+ clicks + 13m wait** | **3+ clicks + 13m wait** | On CCTP legs, user waits up to **13 min** (ETH V1), switches to Activity tab, clicks `Claim USDC on Solana` (`app.js:2600-2663`), and signs a legacy Solana tx (fails if user has `< 0.003 SOL`!). |
| **Total (3 chains + 1 DeFi + CCTP)** | **11–18 clicks** | **12–20 clicks** | Far from 1-click! |

### 3.2 Live Pre-Sign Bug Discovered During Audit
- **BUG (`public/wallets.js:238`):**
  ```js
  (call.data.toLowerCase().startsWith('0x6fd3504e') || call.data.toLowerCase().startsWith('0x05285a08'))
  ```
  `src/bridge/cctp.ts:18` defines `CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR = '8e0250ee'` (`depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)`). Because `wallets.js:238` checks `0x05285a08` instead of `0x8e0250ee`, **every CCTP V2 burn silently bypasses browser-side `mintRecipient` canonical Solana USDC ATA verification!** Fixing this is a 1-line P0 security fix.

### 3.3 EIP-7702, EIP-5792, Permit2 & Paymaster Readiness (2026)
- **Wallet Ecosystem Reality (2026):**
  - **MetaMask:** Native EIP-5792 `wallet_sendCalls` + on-the-fly EIP-7702 smart-EOA upgrade (`MetaMask Smart Accounts`). Collapses Approve + DeFi Unwind + Swap + Bridge into **1 signature per chain**.
  - **Coinbase Smart Wallet / CDP:** Native EIP-5792 + EIP-7702 + gas-sponsored Paymaster support across Base, Arbitrum, Optimism, Ethereum.
  - **Rabby Wallet:** Added cautious `signAuthorization` / limited EIP-7702 support, with strict anti-drainer simulation warnings against unknown delegation targets. Relying solely on EIP-7702 for Rabby users triggers scary delegation warnings; **Permit2 + Enso single-tx consolidation** is the cleaner UX path for Rabby.
  - **Phantom EVM:** Gradual EIP-5792 alignment; multi-chain users expect 1-click Phantom EVM + Phantom Solana simultaneous connection.
- **Concrete Codebase Gaps:**
  1. **Paymaster Never Passed to `wallet_sendCalls` (`public/wallets.js:641,1108-1119`):** `detectWalletBatchCapabilities` detects `paymasterService.supported` and displays `"+ Paymaster"` in the UI badge (`wallets.js:660`), yet `sendEip5792Batch` **never passes `capabilities: { paymasterService: { url } }`** in the RPC payload! Wiring a real ERC-7677 paymaster URL (e.g., Pimlico/Coinbase CDP paymaster funded by Turgalium's fee) immediately unlocks true **$0-gas 1-click sweeps** for Coinbase Smart Wallet & MetaMask without even needing custom relayer deployment!
  2. **Sequential Chain-Switch Friction (`public/app.js:3475-3477`):** Prefetch `prepare-chain-batch` quotes for ALL selected chains in parallel before the first signature so chain switches happen instantaneously with zero 3–7s quote stalls between popups.

### 3.4 Solana Versioned Transactions (`VersionedTransaction` + ALTs) — 1-Click Arrival Bundle
- **Current State (`src/bridge/solana-claim.ts:593-605`):** Builds a **legacy `Transaction`** supporting only `createAssociatedTokenAccountIdempotent` + `receiveMessage`. Legacy transactions hit Solana's 1,232-byte packet limit quickly and cannot compose downstream DeFi/Jupiter instructions.
- **Upgrade Opportunity:** Migrate `solana-claim.ts` to **`VersionedTransaction` (`MessageV0` + Address Lookup Tables)** + dynamic `ComputeBudgetProgram` instructions so a **single Solana wallet click** can atomically execute:
  1. `ComputeBudget` (dynamic CU limit + median priority fee)
  2. `createAssociatedTokenAccountIdempotent` (if missing)
  3. Circle CCTP `receiveMessage` (mints native USDC)
  4. **Optional Post-Arrival Action (User Preset):**
     - **Park 90% in Yield:** `Jupiter Lend` `getDepositIxs` (`USDC → jlUSDC`) or Kamino USDC Vault, OR
     - **Swap to SOL / JupSOL:** `Jupiter Swap v2` instruction, AND/OR
     - **Close Empty ATAs:** Reclaim `0.00203928 SOL` per empty token account in the same tx!
  - And for plain USDC arrival, default to **Circle CCTP V2 Forwarding Service** so **0 Solana clicks** are required!

### 3.5 Mobile WalletConnect & Phantom/Solflare UX Gaps
- **WalletConnect Project ID Wall (`public/wallets.js:891-901`, `public/app.js:3787`):** If `WALLETCONNECT_PROJECT_ID` is not set in server env, mobile users are asked to paste a 32-char Reown Project ID from `cloud.reown.com`! Production must configure a bundled/server-managed `WALLETCONNECT_PROJECT_ID`.
- **Zero Mobile Solana Connectivity (`public/wallets.js:1318-1322`):** On mobile Safari/Chrome (outside in-app wallet browsers), `window.phantom.solana` and Wallet Standard extensions do not exist. Turgalium currently throws `"No Solana wallet extension found"`.
  - **Fix:** Add **Phantom Universal Deep-Links** (`https://phantom.app/ul/browse/...` + Phantom Connect), **Solflare Mobile Deep-Link**, and **Solana Mobile Wallet Adapter (MWA)** support for Android/Seeker devices, plus **1-Click Dual-VM Connect** when Phantom / OKX / Coinbase / Backpack is detected on desktop (connects BOTH EVM and Solana from a single button click!).

---

## 4. Pillar 3 — High-Utility Autonomous Agents

### 4.1 Audit of Turgalium's Current Agent Stack & Critical Disconnections
1. **`TurgaliumAgentVault.sol` Is Disconnected from Execution Contracts:**
   - `contracts/TurgaliumAgentVault.sol:253-305` implements an excellent policy vault (`lockedSolanaRecipient`, `maxPerTxUsd6`, rolling 24h `dailyCapUsd6`, single-bit `allowedActionsMask`, `maxFeeBps`, `minNetOutBps`, `authorizedRouter`).
   - **CRITICAL GAP:** Neither `contracts/TurgaliumRouter.sol` nor `contracts/TurgaliumSweepDelegate.sol` ever calls `TurgaliumAgentVault.authorizeAgentAction(...)`! There is **zero on-chain linkage** between mandate enforcement and actual fund movement.
2. **Gasless Relayer Broadcast Is Still a Stub (`src/relayer/sponsor.ts:822-839`):**
   - `submitSignedGaslessIntent()` performs solid EIP-712 `ecrecover` + EIP-2 low-`s` + replay protection, then unconditionally returns `broadcasted: false, settlementStatus: 'queued_pending_broadcast'`. Even when `TURGALIUM_RELAYER_PRIVATE_KEY` is configured, no EVM transaction is constructed, signed, gas-priced, or submitted to RPC/Flashbots.
3. **Off-Chain Mandate Engine Gaps (`src/agent/mandate-engine.ts`):**
   - Stored in an in-memory `Map` (restart wipes `spentTodayUsd`, resetting daily caps!).
   - When `agentKey` is omitted (`mandate-engine.ts:272-274`), it generates a SHA-256 hash as a fake address with no corresponding signer key.
   - Only supports 4 action bits (`dust_convert`, `defi_withdraw`, `bridge_solana`, `burn_zero_liq`) — lacks bits for `yield_park_solana`, `revoke_approval`, and `gas_window_sweep`.
4. **Claude MCP & ChatGPT Action Surface (`src/mcp/server.ts`, `src/agent/plugin-spec.ts`):**
   - Currently limited to 5 tools (`turgalium_scan_wallets`, `turgalium_plan_dust_conversion`, `turgalium_list_agent_mandates`, `turgalium_request_sweep_permission`, `turgalium_list_pending_approvals`).
   - Missing high-utility tools: `turgalium_preservation_audit` (live route auction + exact $ saved), `turgalium_watch_gas_window`, `turgalium_list_unlock_schedule`, `turgalium_scan_stale_approvals`, and `turgalium_solana_yield_quotes`.

### 4.2 Five Concrete Autonomous Agent Jobs That Genuinely Save Money or Time

| Agent Job | Concrete Wealth / Time Saved | How It Works (Non-Custodial / Policy-Bounded) | Required Code Additions |
| :--- | :--- | :--- | :--- |
| **1. L1 Gas-Window Sniper** | **$15–$40 saved per Ethereum migration** (executes at 6–10 gwei overnight UTC vs 30–50 gwei peak) | Builds on `feat/cost-preservation-autopilot-agents` (`PreservationAgentStore`). Polls `eth_feeHistory`/baseFee every 60s; when `baseFee <= maxBaseFeeGwei`, either pushes a 1-click sign alert (Telegram/webhook/browser push) or auto-executes a pre-signed EIP-712 `SweepIntent` via the sponsored relayer within `TurgaliumAgentVault` bounds. | Merge `5a841a2`, add persistent cron worker + real relayer broadcaster + signed-intent queue |
| **2. DeFi Unlock & Unbonding Auto-Harvester** | **Prevents 5–15% APY dead-capital drag** on forgotten 7d–21d unlocks | Tracks pending withdrawal queues & unbonding timers: **Ethena sUSDe (7d)**, **Lido stETH withdrawal NFTs (1–5d)**, **Cosmos/Osmosis/Celestia unbonding (14–21d)**, **Aerodrome/Velodrome ve-locks**, and **Pendle/Wayfinder maturities**. Fires the exact hour funds unlock to claim + bridge to Solana via CCTP V2. | Extend `unlockSchedule` (`preservation-optimizer.ts`) with live on-chain queue readers (`Lido WithdrawalQueueERC721`, Cosmos `/cosmos/staking/v1beta1/delegators/{addr}/unbonding_delegations`, Ethena `cooldowns(user)`). |
| **3. Post-Bridge 100% Principal Yield-Parking Agent** | **+$1,500–$2,250/yr** on $25k migrated USDC (6–9% APY vs 0% idle) | Watches Solana destination ATA for incoming migration settlements; auto-proposes (or executes via 1-click Solana session / `VersionedTransaction`) parking 100% principal-safe into **Jupiter Lend (`jlUSDC`)**, **Kamino USDC Earn**, or **JupSOL**. | Solana arrival watcher + `@jup-ag/lend/earn` (`getDepositIxs`) + Kamino SDK adapter + `TurgaliumAgentVault` yield preference metadata |
| **4. Stale Approval Revoker & Solana Empty-ATA Rent Vacuum** | **Eliminates infinite-approval exploit risk** + recovers **+$3–$20 free SOL** | `TurgaliumSweepDelegate.sol:503-507` **already supports `ApprovalRevoke[] revokes`**, yet nothing populates it! Add an approval indexer (RPC `Approval` logs / Moralis / Dune Sim) to auto-attach `approve(spender, 0)` for emptied tokens during sweep, plus a Solana scanner for `amount === 0` ATAs (`closeAccount`). | `src/scanner/approvals.ts`, populate `revokes[]` in `tx-builder.ts` / `sponsor.ts`, `src/bridge/solana-rent.ts` |
| **5. Continuous Multi-Wallet Dust & Airdrop Vacuum** | **Rescues $50–$500+/yr** in forgotten airdrops, LP fees & staking rebates | Weekly background scan across all unified wallets under a tight `TurgaliumAgentVault` mandate (e.g., `maxPerTx: $100`, `minNetOutBps: 8500`). Stays completely silent until new sweepable value exceeds the profitable Level-2 batch threshold, then executes or sends a 1-click digest. | Persistent `watchlists` table + scheduled `scanUnifiedWallets` worker + threshold trigger |

---

## 5. Pillar 4 — Condensed Batch APIs, 1-Click Sweep UX & Principal-Safe Solana Arrival

### 5.1 Condensed Backend Batch Endpoints (Single-Round-Trip Architecture)
To eliminate sequential HTTP waterfalls across wallet hydration, transaction quoting, Solana balance/dust/APY loading, and finality tracking, Turgalium exposes five condensed batch endpoints backed by in-flight promise deduplication and short TTL caching (`refresh: true` bypass):

1. **`POST /api/workspace/hydrate`**: Hydrates wallet `scan`, optimal `plan`, `preservation` analysis, `solanaBalances`, optional `solanaOverview` (`includeSolanaOverview: true`), and `timingMs: { total, scan, plan, solana }` in a single server call.
2. **`POST /api/tx/prepare-batch`**: Prepares up to 12 selected assets in parallel (bounded concurrency) with optional DeFi preflight (`includePreflight`), returning aggregated `totalNetUsd`, `totalGasUsd`, `totalProtocolFeeUsd: 0`, `totalSignatures`, and per-item `prepared` / `preflight` status.
3. **`POST /api/solana/overview`**: Combines Solana balances, SPL dust scan (`dustMaxUsd`, `dustOutputAsset`), and live yield strategy APYs into one parallel request on Solana wallet connect.
4. **`POST /api/bridge/status-batch`**: Polls settlement and bridge finality across all in-flight cross-chain legs in a single batch call.
5. **`POST /api/agent/handoff`**: Produces a non-custodial read-only review & handoff kit for Claude MCP and ChatGPT assistants.

### 5.2 True 1-Click Workflows & 100% Principal-Safe Post-Arrival Yield
- **1-Click Auto-Scan & Plan on Connect**: Connecting an EVM wallet or selecting an address hydrates scan + optimal route plan automatically with zero extra clicks.
- **1-Click Sweep All Ready**: Primary CTA (and sticky mobile sweep bar) prepares all selected profitable assets via `POST /api/tx/prepare-batch`, presents a concise single-card pre-sign summary (total net USD arriving on Solana, `0%` Turgalium fee, exact signature count, chains covered), and walks through signing, auto chain-switching, and live batch finality tracking.
- **100% Principal-Safe Earn on Solana**: Parks 100% of arrived USDC into **JupSOL**, **Jupiter Lend (`jlUSDC`)**, or **Kamino USDC** via 1-click VersionedTransaction signing, paired with 1-click SPL dust consolidation and empty-ATA SOL rent reclaim.
- **Clean Event-Driven Balance Sync**: `public/app.js` dispatches `CustomEvent('turgalium:balance-updated', { detail: { solanaUsdc, solBalance, projectedSweepUsdc, solanaWallet } })` so downstream tools stay synchronized without fragile DOM scraping.

---

## 6. Pillar 5 — Production Readiness & Remaining Technical/Security Gaps

### 6.1 Smart Contract Verification & Security Gaps (`contracts/*.sol`)
- **Zero Foundry / Anvil Compilation or Forked-Mainnet Execution Tests:**
  - Checked repository & environment: no `foundry.toml`, no `script/`, no `test/*.t.sol`, and `forge`/`anvil`/`solc` are not part of `.github/workflows/ci.yml`.
  - `tests/contracts-cctp-proofs.test.ts` performs valuable off-chain TypeScript math and source-regex checks, **but none of the 4 Solidity contracts have ever been compiled in CI or executed against live mainnet forks** (Aave v3 Pool, Compound v3 Comet, Morpho/Spark ERC-4626, Uniswap Permit2, Circle `TokenMessengerV2`!).
- **Specific On-Chain Gaps to Close Before Mainnet Deployment:**
  1. **Wire `TurgaliumAgentVault.authorizeAgentAction`** into `TurgaliumRouter.sol` and `TurgaliumSweepDelegate.sol` (adding `sweepWithMandate(...)`) so on-chain mandate caps actually gate fund movement.
  2. **Support CCTP V2 Fast Transfer & Hooks on-chain:** Update `_bridgeUsdcViaCctp` in `TurgaliumRouter.sol:477-499` and `TurgaliumSweepDelegate.sol:313-340` to accept `cctpMaxFee`, `cctpMinFinalityThreshold` (`1000` Fast vs `2000` Standard), and optional `hookData` (`depositForBurnWithHook` for Circle Forwarding Service).
  3. **Support Progressive / Zero-Floor Fees on-chain:** Lower `MIN_FEE_BPS` from `500` to `0` (`MAX_FEE_BPS = 1000` unchanged) in `TurgaliumRouter.sol:196` and `TurgaliumSweepDelegate.sol:112`.
  4. **Add `TurgaliumDelegateRegistry.sol`:** `TurgaliumSweepDelegate.sol:45-50` declares `ITurgaliumDelegateRegistry`, yet **no concrete registry contract exists in `contracts/`**! Without it, deploying `TurgaliumSweepDelegate` requires `policyRegistry = address(0)`, which disables on-chain relayer and router allowlist enforcement!
  5. **Independent External Audit + Slither/Echidna:** Add Slither static analysis to CI immediately and schedule an external audit before deploying mainnet routers or funding a hot relayer wallet.

### 6.2 Persistence, State Integrity & Multi-Instance Readiness
- **Every stateful store is volatile in-memory (`Map`):**
  - `BackgroundJobStore` (`src/server/jobs.ts:180`, capped at 30 jobs) — server restart loses all in-flight 17-min ETH CCTP attestation pollers and job history.
  - `TurgaliumAgentEngine` (`src/agent/mandate-engine.ts:159-161`) — server restart wipes all mandates, pending approvals, and issued Claude/ChatGPT Bearer tokens, **AND resets `spentTodayUsd` to 0 (security bypass on rolling 24h caps!)**.
  - `issuedIntents` (`src/relayer/sponsor.ts:50`) — restart clears EIP-712 gasless intent tracking and replay records.
  - `PreservationAgentStore` (`5a841a2`) — restart wipes all armed L1 gas-window triggers.
- **Fix:** Introduce a `PersistenceAdapter` abstraction:
  - **PostgreSQL** (Supabase / Neon / Fly Postgres) for durable mandates, rolling 24h spend ledger, approvals, hashed plugin tokens, gas-watch triggers, and background sweep jobs.
  - **Redis** (Upstash / Fly Redis) for shared scan/Jupiter caches, distributed rate-limit counters, and single-leader poller leases across replicas.

### 6.3 API Hardening, Rate Limiting, RPC Circuit Breakers & Deployment Hygiene
1. **Zero HTTP Rate Limiting (`src/server/app.ts`):** Expensive endpoints (`/api/scan`, `/api/scan/unified`, `/api/workspace/hydrate`, `/api/tx/prepare-batch`, `/api/tx/prepare-chain-batch`, `/api/tx/simulate-proof`, `/api/solana/overview`, `/mcp`) need per-IP or per-token rate limits so bursts cannot exhaust upstream Alchemy, LI.FI, Relay, and Jupiter API quotas.
2. **Public Deployment Fail-Closed Guard (`src/server/app.ts:563-564,666-671`):** When `TURGALIUM_ADMIN_SESSION_TOKEN` is unset, `hasValidAdminSession()` returns `true` unconditionally. On localhost (`127.0.0.1`) this is ergonomic; on a public host (`HOST=0.0.0.0`), it would expose `/api/agents/mandates`, `/api/plugin/tokens`, and `/api/jobs` to unauthenticated mutations! Add a startup assertion refusing non-loopback binding unless `TURGALIUM_ADMIN_SESSION_TOKEN` and `TURGALIUM_ALLOWED_HOSTS`/`TURGALIUM_ALLOWED_ORIGIN` are explicitly set.
3. **RPC Provider Circuit-Breaker & Keyed Fallback Tiers (`src/scanner/rpc.ts`, `src/scanner/chains.ts`):**
   - `evmJsonRpcBatch` / `evmJsonRpcCall` iterate `rpcUrls` linearly from index `0` on *every* request with no cooldown memory for degraded/429 endpoints, adding 4–8s latency spikes when a public node degrades.
   - Add per-endpoint exponential backoff circuit breaker (e.g., 60s cooldown after 3 consecutive 429/5xx/timeouts) + keyed Alchemy/Helius/QuickNode/Triton env vars + `.env.example`.
4. **Deployment Artifacts, Graceful Shutdown & Telemetry (`src/server/index.ts`, `.github/workflows/ci.yml`):**
   - Missing `Dockerfile` (multi-stage Node 22 Alpine), `fly.toml` (or Railway/Render/Cloudflare Container spec), and `.env.example`.
   - `src/server/index.ts` lacks `SIGTERM`/`SIGINT` graceful drain (`server.close()` + `jobStore.dispose()`).
   - Missing structured JSON logging (`pino` or lightweight JSON logger), `/api/metrics` (quote latencies, route-auction bps saved, RPC failover rates, job settlement funnels), and CI checks for `node --check public/app.js public/preservation.js public/sw.js` + Playwright E2E + Foundry tests.

---

## 7. Ready-to-Launch Worktree Ticket Queue

Seven crisp, self-contained, non-overlapping engineering tickets designed so **Main Command Center** can spin them into parallel worktree threads immediately with minimal merge conflict:

### Ticket 1 — `feat/tiered-preservation-fees-and-cctp-v2`
- **Goal:** Cut protocol fee drag by up to 695 bps on principal tiers, upgrade the 6 major EVM chains to Circle CCTP V2 (`TokenMessengerV2` `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`) with Fast Transfer (`minFinalityThreshold = 1000`, live Circle fee quote API) + Forwarding Service option, and fix the `public/wallets.js:238` CCTP V2 selector pre-sign bug (`0x05285a08` → `0x8e0250ee`).
- **Owned Files:** `src/scanner/chains.ts`, `src/bridge/cctp.ts`, `src/scanner/roi.ts`, `public/wallets.js` (selector fix only), `tests/contracts-cctp-proofs.test.ts` (new V2 & tiered-fee tests).
- **Acceptance Criteria:** Tiered/capped fee config (0–1000 bps allowed, progressive schedule by gross USD tier); Ethereum/Base/Arbitrum/Optimism/Polygon/Avalanche upgraded to `cctpVersion: 2`; live `/v2/burn/USDC/fees/{src}/{dst}` fetcher with Fast vs Standard mode; `wallets.js` blocks spoofed `mintRecipient` on `0x8e0250ee`.

### Ticket 2 — `feat/live-parallel-route-auction-mayan-dln`
- **Goal:** Replace the static `Relay → LI.FI → CCTP` waterfall in `tx-builder.ts` with a **true live parallel quote auction** across **Circle CCTP V2**, **Relay**, **Mayan Swift** (direct API), **deBridge DLN** (direct API), and **LI.FI**, selecting strictly by highest `liveNetUsd` (net of gas, fees, slippage, and ATA rent), plus dynamic tier-scaled slippage for non-EVM quotes and dynamic `gasReserveNative` sizing.
- **Owned Files:** `src/execution/tx-builder.ts`, `src/execution/route-auction.ts` (new), `src/execution/non-evm-converter.ts`, `tests/route-auction.test.ts` (new).
- **Acceptance Criteria:** Parallel quote race with 3.5s budget + graceful provider degradation; on $10k–$100k USDC, CCTP V2 automatically beats Relay/LI.FI; on non-USDC, Mayan Swift & deBridge DLN compete live without LI.FI's 25 bps markup; dynamic native gas reserve recovers stranded ETH/L2 dust.

### Ticket 3 — `feat/solana-v0-claim-yield-and-ata-rent`
- **Goal:** Upgrade `src/bridge/solana-claim.ts` from legacy `Transaction` to **`VersionedTransaction` (`MessageV0` + ALTs)** with dynamic `ComputeBudget` priority fees, add **empty-ATA rent recovery** (`closeAccount`, reclaiming 0.00203928 SOL/account), and build a **1-Click Post-Arrival Yield Parking** builder (`USDC → Jupiter Lend jlUSDC` / `JupSOL` via Jupiter Swap v2 / Ultra API).
- **Owned Files:** `src/bridge/solana-claim.ts`, `src/bridge/solana-rent.ts` (new), `src/solana/yield-park.ts` (new), `src/server/app.ts` (new `/api/solana/rent-scan` & `/api/solana/yield-deposit-tx` routes), `tests/solana-v0-yield-rent.test.ts` (new).
- **Acceptance Criteria:** Compiled `VersionedTransaction` with `ComputeBudget` + `createAtaIdempotent` + `receiveMessage` + optional `closeAccount` / Jupiter Lend deposit; verified unit tests for PDA/ALT serialization and rent math.

### Ticket 4 — `feat/condensed-batch-apis-and-one-click-sweep`
- **Goal:** Condense multi-step backend waterfalls into high-speed parallel batch endpoints (`POST /api/workspace/hydrate` with `timingMs` & optional `solanaOverview`, `POST /api/tx/prepare-batch` with bounded parallel preparation & optional DeFi preflight, `POST /api/solana/overview`, `POST /api/bridge/status-batch`, and `POST /api/agent/handoff`), add in-flight promise deduplication and short TTL caching (`refresh: true` bypass), wire 1-click Sweep All Ready + 100% principal-safe Earn on Solana, and replace DOM-scraping balance sync with a clean `turgalium:balance-updated` event.
- **Owned Files:** `src/execution/prepare-batch.ts`, `src/solana/*`, `src/server/app.ts`, `public/app.js`, `public/preservation.js`, `public/index.html`, `tests/*.test.ts`.
- **Acceptance Criteria:** Single-round-trip wallet hydration, parallel batch tx prep across up to 12 assets with `0%` Turgalium fee, 1-click Sweep pre-sign summary, 100% principal-safe yield park, and `node --check public/app.js public/preservation.js public/sw.js` passes.

### Ticket 5 — `feat/one-click-wallet-ux-paymaster-and-mobile`
- **Goal:** Cut onboarding & multi-chain clicks in half: (1) **1-Click Unified Dual-VM Connect** for Phantom/OKX/Coinbase/Backpack (connects EVM + Solana in one flow), (2) attach **ERC-7677 Paymaster `capabilities`** inside `sendEip5792Batch` when advertised by Coinbase/MetaMask, (3) **parallel chain pre-quoting** before multi-chain queue execution, (4) **mobile Phantom/Solflare universal deep-links** & server-configured WalletConnect default, and (5) **stale ERC-20 approval scanner** populating `ApprovalRevoke[]`.
- **Owned Files:** `public/wallets.js`, `public/app.js`, `public/index.html`, `src/scanner/approvals.ts` (new), `tests/wallet-connectors.test.ts`.
- **Acceptance Criteria:** Dual-VM wallets connect both EVM + Solana in 1 prompt; `wallet_sendCalls` attaches `paymasterService` capability when configured; mobile browsers show working Phantom/Solflare deep-links instead of dead-end extension errors.

### Ticket 6 — `feat/foundry-mainnet-fork-tests-and-contract-v2`
- **Goal:** Establish real Solidity compilation, Slither static analysis, and **Foundry/Anvil forked-mainnet tests** for all 4 contracts + add missing concrete `TurgaliumDelegateRegistry.sol`, wire `TurgaliumAgentVault.authorizeAgentAction` into `TurgaliumRouter` & `TurgaliumSweepDelegate`, lower `MIN_FEE_BPS` to `0`, and add CCTP V2 Fast Transfer + Hook parameters on-chain.
- **Owned Files:** `foundry.toml` (new), `contracts/TurgaliumRouter.sol`, `contracts/TurgaliumSweepDelegate.sol`, `contracts/TurgaliumAgentVault.sol`, `contracts/TurgaliumFeeVault.sol`, `contracts/TurgaliumDelegateRegistry.sol` (new), `contracts/test/*.t.sol` (new), `.github/workflows/ci.yml`.
- **Acceptance Criteria:** `forge build && forge test` passes against forked Ethereum/Base mainnet (real Aave v3, Compound v3, ERC-4626, Permit2, CCTP V2); fuzz/invariant tests verify zero residual token stranding, exact fee bounds, and `TurgaliumAgentVault` cap enforcement; CI runs `forge test` + Playwright E2E.

### Ticket 7 — `feat/prod-persistence-relayer-ratelimit-and-deploy`
- **Goal:** Make Turgalium production-deployable and resilient across restarts: (1) pluggable **Postgres + Redis persistence** for jobs, mandates (preserving 24h rolling spend across restarts!), approvals, plugin tokens, gas-watch triggers, and replay-protected intents, (2) **real EVM relayer broadcaster** (`src/relayer/broadcaster.ts`) replacing the stub in `sponsor.ts`, (3) **per-IP/token rate limiting**, RPC circuit-breaker cooldowns, and fail-closed non-loopback startup guard, (4) `Dockerfile`, `fly.toml`, `.env.example`, graceful `SIGTERM` shutdown, and structured JSON logging + `/api/metrics`.
- **Owned Files:** `src/storage/*` (new), `src/relayer/broadcaster.ts` (new), `src/relayer/sponsor.ts`, `src/server/jobs.ts`, `src/agent/mandate-engine.ts`, `src/scanner/rpc.ts`, `src/server/app.ts`, `src/server/index.ts`, `Dockerfile` (new), `fly.toml` (new), `.env.example` (new).
- **Acceptance Criteria:** Restarting the server preserves active jobs, mandates, 24h spend totals, and Bearer tokens; rate limiter returns `429` with `Retry-After`; non-loopback startup without `TURGALIUM_ADMIN_SESSION_TOKEN` exits fail-closed; RPC circuit breaker skips 429'd nodes for 60s.

### Ticket 8 — `feat/merge-preservation-autopilot-and-mcp-v2` *(Coordinate after Ticket 1 & 7)*
- **Goal:** Merge `feat/cost-preservation-autopilot-agents` (`5a841a2`) cleanly into `main`, back `PreservationAgentStore` with Ticket 7's persistent store, wire live on-chain unlock-queue readers (Lido Withdrawal Queue, Ethena `cooldowns`, Cosmos `unbonding_delegations`), and expand Claude MCP (`src/mcp/server.ts`) & ChatGPT OpenAPI (`src/agent/plugin-spec.ts`) with `turgalium_preservation_audit`, `turgalium_watch_gas_window`, `turgalium_list_unlock_schedule`, and `turgalium_scan_stale_approvals`.
- **Owned Files:** `src/execution/preservation-optimizer.ts`, `src/agent/preservation-agents.ts`, `src/server/preservation-routes.ts`, `src/mcp/server.ts`, `src/agent/plugin-spec.ts`, `tests/preservation-optimizer.test.ts`.
- **Acceptance Criteria:** Clean rebase/merge with zero conflicts; live MCP & ChatGPT tools pass schema + auth adversarial tests; unlock harvester detects real pending Lido/Ethena/Cosmos unbondings.
