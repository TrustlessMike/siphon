#!/usr/bin/env python3
"""
Deterministic end-to-end headless Chromium regression & safety backtest suite for Turgalium.
Verifies Desktop (1440x900), Tablet (900x800), and Mobile (390x844) across all 5 views
(Sweep, Activity, AI, Agents, Contracts):
  1. Zero-default Solana destination guard & disconnect clearing (C-2)
  2. Stored DOM XSS & injection immunity on leg.assetCount, symbols, protocols (C-1)
  3. Execution safety: atomicRequired:true for fee batches, sequential receipt failure abort,
     ton_rawSign removal, ensureEvmChain eth_chainId verification, and client pre-sign assertions (C-3, C-4, H-3)
  4. DeFi quick-unwind panel, guided 2-stage auto-bridge, Dust Converter CTA sync,
     mobile 390px visible Honeypot/ROI safety badges, connected 390px/900px 0px overflow,
     constrained mobile toast rect, non-EVM modal footer copy, and turgalium-3d.js rAF pause when hidden.
  5. Condensed backend batch endpoints (POST /api/workspace/hydrate, POST /api/tx/prepare-batch,
     POST /api/solana/overview), 1-Click Sweep UX flow, 100% principal-safe Earn on Solana,
     and strict regression checks that zero gambling / prediction-market UI or endpoints exist.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get("TURGALIUM_E2E_PORT", "4439"))
BASE = f"http://127.0.0.1:{PORT}"
SHOT_DIR = os.environ.get("TURGALIUM_E2E_SCREENSHOT_DIR", "")
VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
VET_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
SOL_PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
SOL_PUBKEY_ALT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"


def wait_ready(srv=None, log_file=None):
    for _ in range(80):
        if srv is not None and srv.poll() is not None:
            err_out = ""
            if log_file is not None:
                log_file.seek(0)
                err_out = log_file.read().decode("utf-8", errors="replace")[-2000:]
            raise RuntimeError(
                f"Turgalium server exited early (code={srv.returncode}) on {BASE}:\n{err_out}"
            )
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Turgalium server failed to start on {BASE}")


def fetch_veteran_scan():
    req = urllib.request.Request(
        f"{BASE}/api/scan",
        data=json.dumps({"presetId": "veteran_defi"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def maybe_shot(page, filename, full_page=True):
    if SHOT_DIR:
        os.makedirs(SHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SHOT_DIR, filename), full_page=full_page)


def build_plan_for_scan(scan, body=None):
    body = body or {}
    default_ids = [a["id"] for a in scan.get("assets", []) if a.get("selectedByDefault")]
    payload = {
        "scan": scan,
        "selectedAssetIds": default_ids,
        "solanaDestination": body.get("solanaDestination") or "",
        "outputAsset": body.get("outputAsset") or "USDC",
        "bridgePreference": body.get("bridgePreference") or "auto",
        "usePermit2Batch": body.get("usePermit2Batch", True),
        "includeBurns": bool(body.get("includeBurns", False)),
    }
    req = urllib.request.Request(
        f"{BASE}/api/plan",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def make_solana_overview_payload(address=SOL_PUBKEY, dust_output_asset="USDC"):
    return {
        "address": address,
        "durationMs": 22,
        "dustOutputAsset": dust_output_asset,
        "balances": {"usdcBalance": 12.5, "solBalance": 0.42, "hasUsdcAta": True},
        "dust": {
            "ownerAddress": address,
            "dustCount": 1,
            "totalDustUsd": 1.45,
            "reclaimableRentSol": 0.00203928,
            "dustAccounts": [
                {
                    "tokenAccount": "7dustAcct11111111111111111111111111111111111",
                    "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
                    "symbol": "BONK",
                    "uiAmount": 42000,
                    "estimatedUsd": 1.45,
                    "rentSol": 0.00203928,
                    "closeable": True,
                }
            ],
        },
        "yieldStrategies": [
            {
                "id": "jupsol",
                "name": "Jupiter Staked SOL (JupSOL)",
                "protocol": "Jupiter / Sanctum LST",
                "symbol": "JupSOL",
                "baselineApyPct": 7.1,
                "executionMode": "jupiter_swap_v0",
                "preservesUsdPeg": False,
            },
            {
                "id": "jupiter_lend_usdc",
                "name": "Jupiter Lend USDC (jlUSDC)",
                "protocol": "Jupiter Lend",
                "symbol": "jlUSDC",
                "baselineApyPct": 8.4,
                "executionMode": "vault_deposit",
                "preservesUsdPeg": True,
            },
            {
                "id": "kamino_usdc",
                "name": "Kamino USDC Lending Vault",
                "protocol": "Kamino Finance",
                "symbol": "kUSDC",
                "baselineApyPct": 6.8,
                "executionMode": "vault_deposit",
                "preservesUsdPeg": True,
            },
        ],
        "rpcUnavailable": False,
    }


def make_sol_overview_route(hits=None):
    def _route(route):
        body = route.request.post_data_json or {}
        if hits is not None:
            hits.append(body)
        addr = body.get("address") or SOL_PUBKEY
        dust_out = body.get("dustOutputAsset") or "USDC"
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(make_solana_overview_payload(addr, dust_out)),
        )

    return _route


def make_hydrate_route(scan_builder, hits=None):
    def _route(route):
        body = route.request.post_data_json or {}
        if hits is not None:
            hits.append(body)
        if body.get("family") and body.get("family") != "evm":
            route.continue_()
            return
        scan_copy = scan_builder(body)
        plan = build_plan_for_scan(scan_copy, body)
        sol_dest = (body.get("solanaDestination") or "").strip()
        sol_bal = {"usdcBalance": 12.5, "solBalance": 0.42, "hasUsdcAta": True} if sol_dest else None
        sol_ov = (
            make_solana_overview_payload(sol_dest, body.get("outputAsset") or "USDC")
            if sol_dest and body.get("includeSolanaOverview")
            else None
        )
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "cached": False,
                "timingMs": {"total": 18, "scan": 10, "plan": 4, "solana": 4 if sol_dest else 0},
                "scan": scan_copy,
                "plan": plan,
                "preservation": None,
                "solanaBalances": sol_bal,
                "solanaOverview": sol_ov,
            }),
        )

    return _route


def assert_zero_gambling_in_dom(page, context_label):
    """Negative regression assertion: zero gambling/degen/prediction-market elements or copy in DOM."""
    audit = page.evaluate("""() => {
      const bannedSelectors = [
        '#view-degen',
        "[data-view='degen']",
        '#degenRoot',
        '[data-yield-split]',
        "script[src*='degen.js']",
        "link[href*='degen.css']",
      ];
      const matchedSelectors = bannedSelectors.filter((sel) => document.querySelectorAll(sel).length > 0);
      const bodyText = document.body?.innerText || '';
      const fullHtml = document.documentElement?.innerHTML || '';
      const bannedTextPatterns = [
        { name: 'degen', re: /\\bdegen\\b/i },
        { name: 'side-pocket', re: /side[-_ ]pocket/i },
        { name: '10% degen', re: /10%\\s*degen/i },
        { name: '90% yield', re: /90%\\s*yield/i },
        { name: 'prediction market', re: /prediction\\s*market/i },
        { name: 'jup.ag/prediction', re: /jup\\.ag\\/prediction/i },
        { name: 'gambling', re: /gambl/i },
      ];
      const matchedText = bannedTextPatterns.filter((p) => p.re.test(bodyText)).map((p) => p.name);
      const hasDegenAssetRef = /degen\\.js|degen\\.css|view-degen/i.test(fullHtml);
      return { matchedSelectors, matchedText, hasDegenAssetRef };
    }""")
    assert not audit["matchedSelectors"], f"[{context_label}] Banned gambling selectors present: {audit}"
    assert not audit["matchedText"], f"[{context_label}] Banned gambling copy present in DOM: {audit}"
    assert not audit["hasDegenAssetRef"], f"[{context_label}] Banned degen asset reference in HTML: {audit}"


def verify_condensed_backend_endpoints(veteran_fixture):
    """Verify real local server contracts for condensed batch APIs & 404 removal of degen endpoints."""
    # 1. POST /api/workspace/hydrate
    req_h = urllib.request.Request(
        f"{BASE}/api/workspace/hydrate",
        data=json.dumps({"presetId": "veteran_defi"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req_h, timeout=15) as r:
        assert r.status == 200
        hydrate_data = json.loads(r.read().decode())
    assert "scan" in hydrate_data and "plan" in hydrate_data, hydrate_data.keys()
    assert isinstance(hydrate_data.get("timingMs"), dict) and "total" in hydrate_data["timingMs"], hydrate_data.get("timingMs")
    scan_symbols = [str(a.get("symbol", "")).upper() for a in hydrate_data["scan"].get("assets", [])]
    assert "DEGEN" not in scan_symbols, f"Banned DEGEN token found in preset hydrate scan: {scan_symbols}"

    # 2. POST /api/solana/overview
    req_s = urllib.request.Request(
        f"{BASE}/api/solana/overview",
        data=json.dumps({"address": SOL_PUBKEY, "dustMaxUsd": 50, "dustOutputAsset": "USDC"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req_s, timeout=15) as r:
        assert r.status == 200
        overview_data = json.loads(r.read().decode())
    assert overview_data.get("address") == SOL_PUBKEY, overview_data
    assert isinstance(overview_data.get("durationMs"), (int, float)), overview_data
    assert "balances" in overview_data and isinstance(overview_data.get("yieldStrategies"), list), overview_data
    assert len(overview_data["yieldStrategies"]) >= 3, overview_data["yieldStrategies"]

    # 3. POST /api/tx/prepare-batch
    sample_assets = [a for a in veteran_fixture.get("assets", []) if a.get("selectedByDefault")][:2]
    req_b = urllib.request.Request(
        f"{BASE}/api/tx/prepare-batch",
        data=json.dumps({
            "assets": sample_assets,
            "userAddress": VITALIK,
            "solanaDestination": SOL_PUBKEY,
            "outputAsset": "USDC",
            "bridgePreference": "auto",
            "includePreflight": False,
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req_b, timeout=20) as r:
        assert r.status == 200
        batch_data = json.loads(r.read().decode())
    assert batch_data.get("count") == len(sample_assets), batch_data
    assert batch_data.get("totalProtocolFeeUsd") == 0, batch_data
    assert isinstance(batch_data.get("items"), list) and len(batch_data["items"]) == len(sample_assets), batch_data
    assert batch_data.get("readyCount", 0) + batch_data.get("failedCount", 0) == batch_data["count"], batch_data

    # 4. Removed gambling/degen endpoints and static assets must return 404
    for removed_path in ["/api/degen/markets", f"/api/degen/positions?owner={SOL_PUBKEY}", "/degen.js", "/degen.css"]:
        try:
            with urllib.request.urlopen(f"{BASE}{removed_path}", timeout=5) as r:
                raise AssertionError(f"Expected 404 for removed path {removed_path}, got HTTP {r.status}")
        except urllib.error.HTTPError as exc:
            assert exc.code == 404, f"Expected 404 for {removed_path}, got HTTP {exc.code}"

    return {
        "ok": True,
        "workspaceHydrateTimingMs": hydrate_data["timingMs"],
        "solanaOverviewStrategies": len(overview_data["yieldStrategies"]),
        "prepareBatchCount": batch_data["count"],
        "prepareBatchFeeZero": batch_data["totalProtocolFeeUsd"] == 0,
        "removedDegenEndpointsReturn404": True,
    }


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    srv_log = tempfile.TemporaryFile()
    srv = subprocess.Popen(
        ["node", "dist/src/server/index.js"],
        cwd=repo_root,
        env={
            **os.environ,
            "PORT": str(PORT),
            "TURGALIUM_ROUTER_OPTIMISM": "0x2222222222222222222222222222222222222222",
            "TURGALIUM_FEE_RECIPIENT_EVM": "0x1111111111111111111111111111111111111111",
        },
        stdout=srv_log,
        stderr=subprocess.STDOUT,
    )

    try:
        wait_ready(srv, srv_log)
        veteran_fixture = fetch_veteran_scan()
        results = {
            "condensed_backend_apis": verify_condensed_backend_endpoints(veteran_fixture),
        }

        with sync_playwright() as p:
            launch_args = []
            if sys.platform.startswith("linux"):
                launch_args = [
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--use-gl=angle",
                    "--use-angle=swiftshader",
                    "--enable-unsafe-swiftshader",
                ]
            browser = p.chromium.launch(headless=True, args=launch_args)

            # ------------------------------------------------------------------
            # 1. DESKTOP 1440px: Zero-Default-Dest Guard, 3D rAF Pause,
            #    Multi-Plugin Discovery, Non-EVM Modal Footer, Pre-Sign Proof,
            #    Gasless 1-Sig, EIP-5792, Agents 500 Recovery, All 5 Views
            # ------------------------------------------------------------------
            ctxD = browser.new_context(viewport={"width": 1440, "height": 900})
            pgD = ctxD.new_page()
            errsD = []
            badHttpD = []
            expect_simulated_500 = {"active": False}
            pgD.on("pageerror", lambda e: errsD.append(f"pageerror: {e}"))
            pgD.on(
                "console",
                lambda m: errsD.append(f"console.{m.type}: {m.text}")
                if m.type == "error" and not (expect_simulated_500["active"] and "500 (Internal Server Error)" in m.text)
                else None,
            )
            pgD.on(
                "response",
                lambda r: badHttpD.append(f"{r.status} {r.request.method} {r.url}")
                if r.status >= 400 and "/api/solana/balance" not in r.url and "/revoke" not in r.url
                else None,
            )

            pgD.add_init_script(f"""
              window.__rpcD = [];
              window.__rafCount = 0;
              const origRaf = window.requestAnimationFrame.bind(window);
              window.requestAnimationFrame = (cb) => {{
                window.__rafCount++;
                return origRaf(cb);
              }};
              let statusPoll = 0;
              let chainHex = '0x1';
              const makeEvm = (name) => ({{
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  window.__rpcD.push({{ name, method, params }});
                  if (method === 'eth_requestAccounts') return ['{VITALIK}'];
                  if (method === 'eth_chainId') return chainHex;
                  if (method === 'wallet_switchEthereumChain') {{ chainHex = params[0].chainId; return null; }}
                  if (method === 'wallet_getCapabilities') {{
                    return {{
                      '0x1': {{ atomic: {{ status: 'supported' }} }},
                      '0x2105': {{ atomic: {{ status: 'supported' }}, paymasterService: {{ supported: true }} }},
                      '0xa4b1': {{ atomic: {{ status: 'supported' }} }},
                      '0xa': {{ atomic: {{ status: 'supported' }} }},
                      '0x89': {{ atomic: {{ status: 'supported' }} }},
                      '0xa86a': {{ atomic: {{ status: 'ready' }} }},
                    }};
                  }}
                  if (method === 'wallet_sendCalls') return {{ id: '0xbatch_base_e2e' }};
                  if (method === 'wallet_getCallsStatus') {{
                    statusPoll++;
                    if (statusPoll === 1) return {{ status: 100, receipts: [] }};
                    return {{ status: 200, receipts: [{{ transactionHash: '0x' + 'aa'.repeat(32), status: '0x1' }}] }};
                  }}
                  if (method === 'eth_signTypedData_v4') {{
                    return '0x' + 'cd'.repeat(65);
                  }}
                  return null;
                }}
              }});
              window.addEventListener('eip6963:requestProvider', () => {{
                window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {{
                  detail: {{ info: {{ uuid: 'mm-1', name: 'MetaMask', rdns: 'io.metamask' }}, provider: makeEvm('MetaMask') }}
                }}));
                window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {{
                  detail: {{ info: {{ uuid: 'rabby-1', name: 'Rabby Wallet', rdns: 'io.rabby' }}, provider: makeEvm('Rabby') }}
                }}));
              }});
              window.phantom = {{
                ethereum: makeEvm('PhantomEVM'),
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }},
                  async disconnect() {{}}
                }}
              }};
              window.okxwallet = makeEvm('OKX');
              window.solflare = {{ async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }} }};
              window.keplr = {{
                async enable(chainIds) {{ window.__keplrEnabled = chainIds; return true; }},
                async getKey(chainId) {{
                  const map = {{
                    'cosmoshub-4': 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
                    'osmosis-1': 'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3aq6l09',
                    'noble-1': 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3acu8pe',
                    'celestia': 'celestia1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3y3clr6',
                    'injective-1': 'inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3lj7tt0',
                    'neutron-1': 'neutron1fl48vsnmsdzcv85q5d2q4z5ajdha8yu33yqdrs',
                  }};
                  return {{ bech32Address: map[chainId] || 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh' }};
                }},
              }};
              window.addEventListener('wallet-standard:app-ready', (e) => {{
                e.detail.register({{
                  name: 'Phantom',
                  chains: ['solana:mainnet'],
                  features: {{
                    'standard:connect': {{ async connect() {{ return {{ accounts: [{{ address: '{SOL_PUBKEY}' }}] }}; }} }},
                    'standard:disconnect': {{ async disconnect() {{}} }},
                  }}
                }}, {{
                  name: 'Backpack',
                  chains: ['solana:mainnet'],
                  features: {{ 'standard:connect': {{ async connect() {{ return {{ accounts: [{{ address: '{SOL_PUBKEY}' }}] }}; }} }} }}
                }});
              }});
            """)

            # Deterministic scan + hydrate + proof routes so Desktop E2E never flakes on public RPC latency
            def build_deterministic_scan(body):
                scan_copy = json.loads(json.dumps(veteran_fixture))
                if body.get("address"):
                    scan_copy["walletAddress"] = body["address"]
                else:
                    scan_copy["walletAddress"] = VITALIK
                    scan_copy["walletLabel"] = "vitalik.eth"
                return scan_copy

            def route_scan_deterministic(route):
                body = route.request.post_data_json or {}
                if body.get("family") and body.get("family") != "evm":
                    route.continue_()
                    return
                scan_copy = build_deterministic_scan(body)
                route.fulfill(status=200, content_type="application/json", body=json.dumps(scan_copy))

            route_hydrate_deterministic = make_hydrate_route(build_deterministic_scan)
            route_sol_overview = make_sol_overview_route()

            def route_proof_deterministic(route):
                body = route.request.post_data_json or {}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "proof": {
                            "proofId": "prf_e2e_base",
                            "chain": body.get("chain", "base"),
                            "chainName": "Base",
                            "blockNumber": 62249834,
                            "userAddress": body.get("userAddress", VITALIK),
                            "outputAsset": body.get("outputAsset", "USDC"),
                            "allChecksSafe": True,
                            "hasEnoughNativeGas": True,
                            "nativeBalanceUi": "0.145",
                            "nativeSymbol": "ETH",
                            "nativeBalanceUsd": 420.50,
                            "mintRecipientVerified": True,
                            "guaranteedMinNetUsd": 1412.25,
                            "proofDigestSha256": "0x" + "ab" * 32,
                            "protocolFee": {
                                "feePercent": 7,
                                "estimatedFeeUsd": 106.30,
                                "collectionMethod": "atomic_router_fee",
                            },
                            "checks": [
                                {"assetSymbol": "USDC", "summary": "eth_call balance & route verified", "preflightStatus": "verified"}
                            ],
                        }
                    }),
                )

            def route_sol_balance(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"usdcBalance": 12.5, "solBalance": 0.42, "hasUsdcAta": True}),
                )

            def route_prepare_base_eip5792(route):
                body = route.request.post_data_json or {}
                if body.get("chain") == "base":
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "chain": "base",
                            "chainId": 8453,
                            "chainName": "Base",
                            "calls": [
                                {
                                    "stepId": "protocol_fee_transfer",
                                    "assetId": "base-usdc",
                                    "assetSymbol": "USDC",
                                    "action": "BRIDGE_DIRECT_USDC",
                                    "provider": "relay",
                                    "label": "Protocol fee (7%)",
                                    "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                                    "data": "0xa9059cbb" + "0" * 128,
                                    "value": "0x0",
                                },
                                {
                                    "stepId": "bridge",
                                    "assetId": "base-usdc",
                                    "assetSymbol": "USDC",
                                    "action": "BRIDGE_DIRECT_USDC",
                                    "provider": "relay",
                                    "label": "Bridge USDC -> Solana",
                                    "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                                    "data": "0x12345678",
                                    "value": "0x0",
                                },
                            ],
                            "bridgeTrackers": [{
                                "assetId": "base-usdc",
                                "assetSymbol": "USDC",
                                "provider": "relay",
                                "requestId": "req_base_e2e",
                                "estimatedOutput": "804.45 USDC",
                                "estimatedSeconds": 4,
                                "requiresSolanaClaim": False,
                            }],
                            "skippedAssets": [],
                            "savings": {"popupsSaved": 1},
                        }),
                    )
                    return
                route.continue_()

            pgD.route("**/api/workspace/hydrate", route_hydrate_deterministic)
            pgD.route("**/api/scan", route_scan_deterministic)
            pgD.route("**/api/tx/simulate-proof", route_proof_deterministic)
            pgD.route("**/api/solana/overview", route_sol_overview)
            pgD.route("**/api/solana/balance*", route_sol_balance)
            pgD.route("**/api/tx/prepare-chain-batch", route_prepare_base_eip5792)

            pgD.goto(BASE, wait_until="networkidle")
            pgD.wait_for_timeout(450)
            assert_zero_gambling_in_dom(pgD, "desktop_website_1440")

            # 1A. Verify default Solana destination is EMPTY (C-2)
            boot_dest = pgD.evaluate("""() => ({
              inputVal: document.getElementById('solanaDestInput')?.value ?? null,
              summary: document.getElementById('destAddrSummary')?.textContent?.trim() ?? '',
            })""")
            assert boot_dest["inputVal"] == "", f"Expected empty default #solanaDestInput, got {boot_dest}"
            assert "Connect Solana or enter destination" in boot_dest["summary"], boot_dest

            # 1B. Verify Coinbase Smart Wallet SDK + WalletConnect SDK + HEAD / COOP + WebGL canvas
            sdk_gfx = pgD.evaluate("""async () => {
              const headRes = await fetch('/', { method: 'HEAD' });
              const mod = await import('/vendor/wallet-sdks.js');
              const sdk = mod.createCoinbaseWalletSDK({ appName: 'Turgalium', appChainIds: [1, 8453] });
              const prov = sdk.getProvider();
              const canvas = document.getElementById('turgaliumHeroCanvas');
              return {
                headStatus: headRes.status,
                coop: headRes.headers.get('cross-origin-opener-policy'),
                coinbaseReady: typeof prov?.request === 'function',
                wcReady: typeof mod.EthereumProvider?.init === 'function',
                canvasW: canvas?.width || 0,
                canvasH: canvas?.height || 0,
              };
            }""")
            assert sdk_gfx["headStatus"] == 200, sdk_gfx
            assert sdk_gfx["coop"] == "same-origin-allow-popups", sdk_gfx
            assert sdk_gfx["coinbaseReady"] and sdk_gfx["wcReady"], sdk_gfx
            assert sdk_gfx["canvasW"] > 200 and sdk_gfx["canvasH"] > 200, sdk_gfx

            overflowD = {"website": pgD.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")}
            maybe_shot(pgD, "goal_desktop_website_1440.png", full_page=True)

            # 1C. Open Wallet Modal -> verify plugins + no inline onerror + WalletConnect inline form
            pgD.click("#heroConnectBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            evmWallets = pgD.locator(".wallet-option-name").all_inner_texts()
            assert "MetaMask" in evmWallets and "Rabby Wallet" in evmWallets, evmWallets
            assert "Coinbase Smart Wallet" in evmWallets and "WalletConnect (Mobile QR)" in evmWallets, evmWallets
            inline_onerror_cnt = pgD.locator("#walletModalBackdrop [onerror]").count()
            assert inline_onerror_cnt == 0, f"Found {inline_onerror_cnt} inline onerror attributes!"
            pgD.wait_for_timeout(150)
            brokenWalletImgs = pgD.evaluate("""() => {
              const imgs = Array.from(document.querySelectorAll('#walletModalBackdrop img, .hero-stage-bar img'));
              return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
            }""")
            assert not brokenWalletImgs, f"Broken brand logo images: {brokenWalletImgs}"

            pgD.click("[data-pick-wc='true']")
            pgD.wait_for_selector("#modalWcProjectForm", timeout=3000)
            pgD.click("[data-pick-wc='true']")

            # Connect ONLY EVM (Rabby) first — NO Solana destination yet!
            pgD.click("[data-pick-evm='rabby-1']")
            pgD.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#connectEvmBtn')?.textContent?.includes('Rabby')", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=15000)

            # 1D. Verify turgalium-3d.js pauses rAF completely while #siteShell is hidden!
            pgD.wait_for_timeout(120)
            raf_before = pgD.evaluate("() => window.__rafCount")
            pgD.wait_for_timeout(320)
            raf_after = pgD.evaluate("() => window.__rafCount")
            scene_running = pgD.evaluate("() => Boolean(window.__turgaliumHeroScene?.isRunning?.())")
            assert raf_after == raf_before and not scene_running, f"3D rAF leaked while hidden: {raf_before}->{raf_after}, running={scene_running}"

            # 1D-bis. Verify Lite mode default hides EIP / routing / fee / program details,
            # and switching to Pro mode reveals & persists them
            lite_check = pgD.evaluate("""() => {
              const isVis = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const st = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return st.display !== 'none' && r.width > 0 && r.height > 0;
              };
              const cardText = document.querySelector('.sweep-summary-card')?.innerText || '';
              const appText = document.getElementById('appShell')?.innerText || '';
              const ctaRect = document.getElementById('runLiveQueueBtn')?.getBoundingClientRect();
              const bodyBg = getComputedStyle(document.body).backgroundColor;
              const ctaBg = getComputedStyle(document.getElementById('runLiveQueueBtn')).backgroundColor;
              const brandLogos = Array.from(document.querySelectorAll('.brand-logo-img')).map(i => i.getAttribute('src') || '');
              return {
                mode: document.documentElement.dataset.uiMode,
                liteCostVisible: isVis('#summaryLiteCostText'),
                bridgeRouteVisible: isVis('#bridgePrefSelect'),
                feeDrawerBtnVisible: isVis('#toggleFeeDrawerBtn'),
                modeSwitchVisible: isVis('.mode-switch-bar'),
                verifyProofVisible: isVis('#verifyProofBtn'),
                chainQueueVisible: isVis('#chainQueueList'),
                agentsTabVisible: isVis(".app-tab[data-view='agents']"),
                contractTabVisible: isVis(".app-tab[data-view='contract']"),
                unifyBtnVisible: isVis('#toggleUnifyBarBtn'),
                defiTechVisible: isVis('.defi-tech-details'),
                hasEipInLiteCard: /EIP-5792|Permit2|7702|Bridge Route|Protocol Fee/i.test(cardText),
                overflowLite: document.documentElement.scrollWidth - window.innerWidth,
                bodyBg,
                ctaBg,
                ctaTopLite: ctaRect ? Math.round(ctaRect.top) : 99999,
                hasRawEmoji: /[⚡🔄🛡️⏳⊘⚠✕✓◉○]/.test(appText),
                brandLogos,
              };
            }""")
            assert lite_check["mode"] == "lite", lite_check
            assert lite_check["liteCostVisible"], lite_check
            assert not any([
                lite_check["bridgeRouteVisible"],
                lite_check["feeDrawerBtnVisible"],
                lite_check["modeSwitchVisible"],
                lite_check["verifyProofVisible"],
                lite_check["chainQueueVisible"],
                lite_check["agentsTabVisible"],
                lite_check["contractTabVisible"],
                lite_check["unifyBtnVisible"],
                lite_check["defiTechVisible"],
            ]), f"Pro-only controls leaked in Lite mode: {lite_check}"
            assert not lite_check["hasEipInLiteCard"], f"Technical EIP/route copy leaked in Lite card: {lite_check}"
            assert lite_check["overflowLite"] <= 0, lite_check
            assert lite_check["bodyBg"] == "rgb(252, 252, 252)", f"Expected Turgalium daylight porcelain #FCFCFC body bg, got {lite_check['bodyBg']}"
            assert lite_check["ctaBg"] == "rgb(10, 10, 10)", f"Expected Turgalium stark black #0A0A0A CTA bg, got {lite_check['ctaBg']}"
            assert lite_check["ctaTopLite"] <= 760, f"Desktop Lite CTA pushed below fold: y={lite_check['ctaTopLite']}"
            assert not lite_check["hasRawEmoji"], f"Raw emoji or Unicode status symbol found in Lite UI!"
            assert len(lite_check["brandLogos"]) == 2 and all("/logos/turgalium.svg" in s for s in lite_check["brandLogos"]), lite_check
            maybe_shot(pgD, "goal_desktop_lite_1440.png", full_page=True)

            # Switch to Pro mode and verify all Pro controls + EIP / program data appear + CTA stays above fold
            pgD.click(".ui-mode-btn[data-ui-mode='pro']")
            pgD.wait_for_function("() => document.documentElement.dataset.uiMode === 'pro'", timeout=5000)
            pro_check = pgD.evaluate("""() => {
              const isVis = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const st = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return st.display !== 'none' && r.width > 0 && r.height > 0;
              };
              const ctaRect = document.getElementById('runLiveQueueBtn')?.getBoundingClientRect();
              const appText = document.getElementById('appShell')?.innerText || '';
              return {
                mode: document.documentElement.dataset.uiMode,
                stored: localStorage.getItem('turgalium_ui_mode'),
                liteCostVisible: isVis('#summaryLiteCostText'),
                bridgeRouteVisible: isVis('#bridgePrefSelect'),
                feeDrawerBtnVisible: isVis('#toggleFeeDrawerBtn'),
                modeSwitchVisible: isVis('.mode-switch-bar'),
                verifyProofVisible: isVis('#verifyProofBtn'),
                chainQueueVisible: isVis('#chainQueueList'),
                agentsTabVisible: isVis(".app-tab[data-view='agents']"),
                contractTabVisible: isVis(".app-tab[data-view='contract']"),
                ctaTopPro: ctaRect ? Math.round(ctaRect.top) : 99999,
                hasRawEmojiPro: /[⚡🔄🛡️⏳⊘⚠✕✓◉○]/.test(appText),
              };
            }""")
            assert pro_check["mode"] == "pro" and pro_check["stored"] == "pro", pro_check
            assert not pro_check["liteCostVisible"], pro_check
            assert all([
                pro_check["bridgeRouteVisible"],
                pro_check["feeDrawerBtnVisible"],
                pro_check["modeSwitchVisible"],
                pro_check["verifyProofVisible"],
                pro_check["chainQueueVisible"],
                pro_check["agentsTabVisible"],
                pro_check["contractTabVisible"],
            ]), f"Pro controls missing in Pro mode: {pro_check}"
            assert pro_check["ctaTopPro"] <= 760, f"Desktop Pro CTA pushed below fold: y={pro_check['ctaTopPro']}"
            assert not pro_check["hasRawEmojiPro"], f"Raw emoji or Unicode status symbol found in Pro UI!"
            maybe_shot(pgD, "goal_desktop_pro_1440.png", full_page=True)

            # 1E. Zero-Default-Dest Guard Backtest: sweep, per-chain batch, DeFi extract, and mandate MUST be hard-blocked!
            jobs_posted = {"n": 0}
            mandates_posted = {"n": 0}

            def count_jobs(route):
                if route.request.method == "POST":
                    jobs_posted["n"] += 1
                route.continue_()

            def count_mandates(route):
                if route.request.method == "POST":
                    mandates_posted["n"] += 1
                route.continue_()

            pgD.route("**/api/jobs", count_jobs)
            pgD.route("**/api/agents/mandates", count_mandates)

            pgD.click("#runLiveQueueBtn")
            pgD.wait_for_timeout(180)
            pgD.click("[data-exec-chain-batch='base']")
            pgD.wait_for_timeout(180)
            pgD.click("#extractAllDefiBtn")
            pgD.wait_for_timeout(180)
            assert jobs_posted["n"] == 0, f"Expected 0 /api/jobs when Solana dest empty, got {jobs_posted['n']}"
            assert pgD.locator("#destEditWrap:not(.hidden)").count() == 1, "Expected #destEditWrap to open when blocked"

            # Typing manual address WITHOUT checking confirmation checkbox must STILL block!
            pgD.fill("#solanaDestInput", SOL_PUBKEY_ALT)
            pgD.locator("#solanaDestInput").dispatch_event("input")
            pgD.wait_for_selector("#manualDestConfirmWrap:not(.hidden)")
            pgD.click("#runLiveQueueBtn")
            pgD.wait_for_timeout(180)
            assert jobs_posted["n"] == 0, "Expected manual unconfirmed Solana address to stay blocked!"

            # Mandate creation must ALSO be blocked when unconfirmed!
            pgD.click(".app-tab[data-view='agents']")
            pgD.wait_for_timeout(150)
            pgD.click("#createMandateForm button[type='submit']")
            pgD.wait_for_timeout(180)
            assert mandates_posted["n"] == 0, "Expected mandate creation to be blocked without confirmed Solana destination!"
            pgD.click(".app-tab[data-view='scanner']")

            # Clear manual input, connect Phantom Solana, then disconnect Solana and assert input & summary clear!
            pgD.click("#connectSolBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            solWallets = pgD.locator(".wallet-option-name").all_inner_texts()
            assert "Phantom" in solWallets and "Backpack" in solWallets and "Solflare" in solWallets, solWallets
            pgD.click("[data-pick-sol='std:phantom']")
            pgD.wait_for_selector("#walletModalBackdrop", state="hidden")
            pgD.wait_for_function(f"() => document.getElementById('solanaDestInput')?.value === '{SOL_PUBKEY}'")

            # Disconnect Solana -> must clear #solanaDestInput and reset #destAddrSummary
            pgD.click("#connectSolBtn")
            pgD.wait_for_selector("#walletModalDisconnectBtn")
            pgD.click("#walletModalDisconnectBtn")
            pgD.wait_for_timeout(150)
            after_disc = pgD.evaluate("""() => ({
              val: document.getElementById('solanaDestInput')?.value ?? null,
              summary: document.getElementById('destAddrSummary')?.textContent?.trim() ?? '',
            })""")
            assert after_disc["val"] == "", f"Disconnect did not clear #solanaDestInput: {after_disc}"
            assert "Connect Solana or enter destination" in after_disc["summary"], after_disc

            # Re-connect Phantom Solana for the live batch & proof tests
            pgD.click("[data-pick-sol='std:phantom']")
            pgD.wait_for_selector("#walletModalBackdrop", state="hidden")
            pgD.wait_for_function("() => document.querySelector('#connectSolBtn')?.textContent?.includes('Phantom')", timeout=10000)

            pgD.unroute("**/api/jobs", count_jobs)
            pgD.unroute("**/api/agents/mandates", count_mandates)

            # 1F. Verify all 7 ecosystem pills & Non-EVM Cosmos modal footer copy (M-7)
            famPills = pgD.locator("#familyBar .family-pill").count()
            assert famPills == 7, f"Expected 7 ecosystem family pills, got {famPills}"
            pgD.click("#familyBar [data-family='cosmos']")
            pgD.wait_for_function("() => (document.querySelector('#connectEvmBtn')?.innerText || '').includes('Cosmos')", timeout=10000)
            pgD.click("#connectEvmBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            cosmosFooter = pgD.locator("#walletModalFoot").inner_text()
            assert "EIP-6963" not in cosmosFooter and "EIP-5792" not in cosmosFooter, f"Non-EVM footer leaked EVM copy: {cosmosFooter}"
            assert "Keplr" in cosmosFooter, cosmosFooter
            pgD.click("[data-pick-family-wallet='keplr']")
            pgD.wait_for_selector("#walletModalBackdrop", state="hidden", timeout=10000)
            pgD.wait_for_function("() => (document.querySelector('#connectEvmBtn')?.innerText || '').includes('Keplr')", timeout=10000)

            # Switch back to EVM
            pgD.click("#familyBar [data-family='evm']")
            pgD.wait_for_function("() => document.querySelector('#connectEvmBtn')?.textContent?.includes('Rabby')", timeout=10000)
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=10000)

            # 1G. Pre-Sign Proof + Gasless 1-Sig + EIP-5792 with atomicRequired: true
            pgD.click("#verifyProofBtn")
            pgD.wait_for_selector("#preSignProofCard:not(.hidden)", timeout=10000)
            proofText = pgD.locator("#preSignProofCard").inner_text()
            assert "Matched bit-for-bit" in proofText, proofText

            pgD.click(".mode-opt[data-exec-mode='gasless']")
            relayer_submitted = {"done": False}

            def route_relayer_submit_mock(route):
                relayer_submitted["done"] = True
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "accepted": True,
                        "signatureValid": True,
                        "broadcasted": False,
                        "mode": "intent_verified_awaiting_deployment",
                        "settlementStatus": "intent_verified_awaiting_deployment",
                        "nextStep": "Gasless intent verified in E2E mock (real ecrecover verified in unit suite).",
                    }),
                )

            pgD.route("**/api/relayer/submit", route_relayer_submit_mock)
            pgD.click("[data-exec-chain-batch='optimism']")
            pgD.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=10000)
            pgD.wait_for_function("() => (window.__rpcD || []).some(r => r.method === 'eth_signTypedData_v4')", timeout=10000)
            pgD.wait_for_function(
                "() => (document.getElementById('agentLegsFeed')?.innerText || '').includes('Gasless intent verified in E2E mock')",
                timeout=10000,
            )
            assert relayer_submitted["done"], "Expected mocked POST /api/relayer/submit to complete before unrouting"
            pgD.unroute("**/api/relayer/submit", route_relayer_submit_mock)

            pgD.click(".mode-opt[data-exec-mode='direct']")
            pgD.click("[data-exec-chain-batch='base']")
            pgD.wait_for_function(
                "() => (window.__rpcD || []).some(r => r.method === 'wallet_sendCalls')",
                timeout=15000,
            )
            rpcD = pgD.evaluate("() => window.__rpcD")
            sendCallsD = [c for c in rpcD if c["method"] == "wallet_sendCalls"]
            assert len(sendCallsD) == 1, f"Expected 1 wallet_sendCalls, got {len(sendCallsD)}"
            assert sendCallsD[0]["params"][0]["chainId"] == "0x2105"
            assert sendCallsD[0]["params"][0]["atomicRequired"] is True, f"Expected atomicRequired=True for fee-bundled batch: {sendCallsD[0]}"

            # 1H. Check all 5 views (Sweep, Activity, AI, Agents, Contracts) + Agents Mandate CRUD + HTTP 500 revoke handling (0 uncaught pageerror!)
            for view in ["scanner", "activity", "ai", "agents", "contract"]:
                pgD.click(f".app-tab[data-view='{view}']")
                pgD.wait_for_timeout(200)
                overflowD[view] = pgD.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert_zero_gambling_in_dom(pgD, f"desktop_1440_{view}")
                if view == "ai":
                    pgD.wait_for_selector("#view-ai.active", timeout=5000)
                elif view == "agents":
                    pgD.wait_for_function("() => (document.querySelector('#claudeMcpConfigHost')?.innerText || '').includes('turgalium')", timeout=5000)
                    # Queue a real permission request via POST /api/agents/approvals (replaces removed demo button)
                    queued_ok = pgD.evaluate("""async () => {
                      const dest = document.getElementById('solanaDestInput')?.value?.trim();
                      const res = await fetch('/api/agents/approvals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Turgalium-Requested-With': 'turgalium-ui' },
                        body: JSON.stringify({
                          client: 'claude_mcp',
                          actionType: 'dust_convert',
                          summary: 'E2E Dust Rescue Proposal',
                          sourceWallets: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
                          chains: ['base', 'optimism'],
                          solanaDestination: dest,
                          grossUsd: 120,
                          estimatedNetUsdc: 112,
                        }),
                      });
                      return res.ok;
                    }""")
                    assert queued_ok, "Failed to queue real agent approval via POST /api/agents/approvals"
                    pgD.click(".app-tab[data-view='scanner']")
                    pgD.click(".app-tab[data-view='agents']")
                    pgD.wait_for_function("() => (document.querySelector('#agentApprovalsHost')?.innerText || '').includes('Approve Permission')", timeout=5000)
                    pgD.click("[data-decision='approve']")
                    pgD.wait_for_function("() => (document.querySelector('#agentApprovalsHost')?.innerText || '').includes('approved')", timeout=5000)
                    # Create mandate now that Solana is connected, then simulate HTTP 500 on revoke -> 0 uncaught pageerrors!
                    pgD.click("#createMandateForm button[type='submit']")
                    pgD.wait_for_selector("[data-revoke-mandate]", timeout=5000)
                    expect_simulated_500["active"] = True
                    pgD.route("**/api/agents/mandates/*/revoke", lambda r: r.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Simulated 500"})))
                    pgD.click("[data-revoke-mandate]")
                    pgD.wait_for_function("() => (document.getElementById('toastRegion')?.innerText || '').includes('Simulated 500')", timeout=5000)
                    pgD.unroute("**/api/agents/mandates/*/revoke")
                    expect_simulated_500["active"] = False
                elif view == "contract":
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract TurgaliumRouter')", timeout=5000)

            # Switching back to Lite from Contracts view must gracefully return to Sweep view
            pgD.click(".ui-mode-btn[data-ui-mode='lite']")
            pgD.wait_for_function("() => document.documentElement.dataset.uiMode === 'lite' && document.getElementById('view-scanner')?.classList.contains('active')", timeout=5000)

            assert all(v <= 0 for v in overflowD.values()), f"Desktop overflow: {overflowD}"
            assert not errsD, f"Desktop errors: {errsD} | badHttpD={badHttpD}"
            assert not badHttpD, f"Desktop bad HTTP: {badHttpD}"
            results["desktop_1440"] = {
                "ok": True,
                "liteAndProVerified": True,
                "turgaliumDaylightVerified": True,
                "zeroRawEmojis": True,
                "ctaTopLitePx": lite_check["ctaTopLite"],
                "ctaTopProPx": pro_check["ctaTopPro"],
                "zeroDefaultDestVerified": True,
                "rafPausedWhenHidden": True,
                "atomicRequiredForFeeBatch": True,
                "cosmosModalFooterFixed": True,
                "zeroGamblingUiVerified": True,
                "aiTabVerified": True,
                "overflowPx": overflowD,
            }
            ctxD.close()

            # ------------------------------------------------------------------
            # 2. SAFETY BACKTEST: Stored XSS (leg.assetCount + symbols),
            #    Sequential Receipt Failure Abort, Pre-Sign Assertions,
            #    ton_rawSign Removal, #selectProfitableBtn Null Guard & Dust Sync
            # ------------------------------------------------------------------
            ctxS = browser.new_context(viewport={"width": 1440, "height": 900})
            pgS = ctxS.new_page()
            errsS = []
            pgS.on("pageerror", lambda e: errsS.append(f"pageerror: {e}"))
            pgS.on("console", lambda m: errsS.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

            pgS.add_init_script(f"""
              window.__xssFired = false;
              window.__seqTxCalls = [];
              let chainHex = '0x2105';
              let txN = 0;
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  if (method === 'eth_requestAccounts') return ['{VET_ADDR}'];
                  if (method === 'eth_chainId') return chainHex;
                  if (method === 'wallet_switchEthereumChain') {{ chainHex = params[0].chainId; return null; }}
                  if (method === 'wallet_getCapabilities' || method === 'wallet_sendCalls') {{
                    const err = new Error('Method not found');
                    err.code = -32601;
                    throw err;
                  }}
                  if (method === 'eth_sendTransaction') {{
                    txN++;
                    window.__seqTxCalls.push(params[0]);
                    return '0x' + String(txN).padStart(64, 'a');
                  }}
                  return null;
                }}
              }};
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }}
                }}
              }};
            """)

            # Hold /api/scan briefly to test #selectProfitableBtn null guard before scan resolves!
            scan_gate = {"release": False}

            def build_safety_scan(body=None):
                # Build deterministic dust-rescuable scan + XSS payloads in symbol/name/protocol
                dust_scan = json.loads(json.dumps(veteran_fixture))
                dust_scan["walletAddress"] = VET_ADDR
                dust_scan["assets"] = [
                    {
                        "id": "base-dust-1",
                        "chain": "base",
                        "chainId": 8453,
                        "chainName": "Base",
                        "address": "0x1111111111111111111111111111111111111111",
                        "symbol": "DUST1<img src=x onerror=\"window.__xssFired=true\">",
                        "name": "Dust One <script>window.__xssFired=true</script>",
                        "decimals": 18,
                        "rawBalance": "4500000000000000000",
                        "uiBalance": 4.5,
                        "priceUsd": 1.0,
                        "grossUsd": 4.5,
                        "kind": "erc20",
                        "action": "SKIP_GAS_NEGATIVE",
                        "actionReason": "Solo gas negative, rescued in batch",
                        "selectedByDefault": False,
                        "estimatedGasUsd": 0.08,
                        "batchedGasUsd": 0.02,
                        "estimatedSlippageUsd": 0.04,
                        "roiVerdict": "negative_roi",
                        "netRoiUsd": -0.25,
                    },
                    {
                        "id": "base-dust-2",
                        "chain": "base",
                        "chainId": 8453,
                        "chainName": "Base",
                        "address": "0x2222222222222222222222222222222222222222",
                        "symbol": "DUST2",
                        "name": "Dust Two",
                        "decimals": 18,
                        "rawBalance": "5200000000000000000",
                        "uiBalance": 5.2,
                        "priceUsd": 1.0,
                        "grossUsd": 5.2,
                        "kind": "erc20",
                        "action": "SKIP_GAS_NEGATIVE",
                        "actionReason": "Solo gas negative, rescued in batch",
                        "selectedByDefault": False,
                        "estimatedGasUsd": 0.08,
                        "batchedGasUsd": 0.02,
                        "estimatedSlippageUsd": 0.05,
                        "roiVerdict": "negative_roi",
                        "netRoiUsd": -0.18,
                    },
                ]
                return dust_scan

            def route_safety_scan(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(build_safety_scan()))

            route_safety_hydrate = make_hydrate_route(build_safety_scan)

            def route_xss_jobs(route):
                if route.request.method == "GET":
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "jobs": [{
                                "jobId": "job_xss_test",
                                "status": "completed",
                                "sourceWallet": VET_ADDR,
                                "solanaDestination": SOL_PUBKEY,
                                "outputAsset": "USDC",
                                "bridgePreference": "auto",
                                "legs": [{
                                    "chain": "base",
                                    "chainName": "Base<img src=x onerror=\"window.__xssFired=true\">",
                                    "assetCount": "<img src=x onerror=\"window.__xssFired=true\">",
                                    "estimatedNetUsd": 100.0,
                                    "status": "landed",
                                    "statusText": "Settled <script>window.__xssFired=true</script>",
                                    "provider": "relay",
                                    "explorerUrl": "https://basescan.org",
                                    "evmTxHash": "0x" + "11" * 32,
                                }],
                            }]
                        }),
                    )
                    return
                route.continue_()

            def route_dust_plan_mock(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "totalDustAssetsFound": 2,
                        "convertibleCount": 2,
                        "rescuedByBatchCount": 2,
                        "estimatedNetSolanaUsdc": 8.75,
                        "totalBatchRescueGainUsd": 4.20,
                        "convertibleAssetIds": ["base-dust-1", "base-dust-2"],
                        "chains": [],
                    }),
                )

            def route_prepare_3step_seq(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "chain": "base",
                        "chainId": 8453,
                        "chainName": "Base",
                        "calls": [
                            {"stepId": "approve", "label": "Approve DUST1", "to": "0x1111111111111111111111111111111111111111", "data": "0x095ea7b3", "value": "0x0"},
                            {"stepId": "bridge", "label": "Bridge DUST1", "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "data": "0x12345678", "value": "0x0"},
                            {"stepId": "bridge_2", "label": "Bridge DUST2", "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "data": "0x87654321", "value": "0x0"},
                        ],
                        "bridgeTrackers": [],
                        "skippedAssets": [],
                        "savings": {"popupsSaved": 0},
                    }),
                )

            def route_status_reverted(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"evmConfirmed": True, "evmFailed": True, "bridgeStatus": "failed"}),
                )

            # Verify #selectProfitableBtn before initial scan resolves throws ZERO pageerrors (H-10)
            pgS_null = ctxS.new_page()
            errsS_null = []
            pgS_null.on("pageerror", lambda e: errsS_null.append(f"pageerror: {e}"))
            pgS_null.route("**/api/workspace/hydrate", lambda r: r.abort())  # keep currentScan null
            pgS_null.route("**/api/scan", lambda r: r.abort())  # keep currentScan null
            pgS_null.goto(BASE, wait_until="domcontentloaded")
            pgS_null.wait_for_selector("#navLaunchBtn", timeout=5000)
            pgS_null.click("#navLaunchBtn")
            pgS_null.click("#selectProfitableBtn")
            pgS_null.wait_for_timeout(150)
            assert not errsS_null, f"#selectProfitableBtn before scan threw: {errsS_null}"
            pgS_null.close()

            pgS.route("**/api/workspace/hydrate", route_safety_hydrate)
            pgS.route("**/api/scan", route_safety_scan)
            pgS.route("**/api/jobs", route_xss_jobs)
            pgS.route("**/api/dust/plan", route_dust_plan_mock)
            pgS.route("**/api/tx/prepare-chain-batch", route_prepare_3step_seq)
            pgS.route("**/api/tx/status", route_status_reverted)
            pgS.route("**/api/solana/overview", route_sol_overview)
            pgS.route("**/api/solana/balance*", route_sol_balance)

            pgS.goto(BASE, wait_until="networkidle")
            pgS.wait_for_function(
                "() => (document.getElementById('liveExecLogBody')?.textContent || '').includes('(0 assets)')",
                timeout=8000,
            )

            # 2A. Stored XSS Backtest: leg.assetCount coerced to 0 assets & 0 script execution!
            xss_check = pgS.evaluate("""() => ({
              xssFired: Boolean(window.__xssFired),
              tableText: document.getElementById('liveExecLogBody')?.textContent || '',
              injectedImgs: document.querySelectorAll('#liveExecLogBody img[src="x"]').length,
            })""")
            assert not xss_check["xssFired"], f"Stored XSS executed! {xss_check}"
            assert xss_check["injectedImgs"] == 0, f"Injected <img> found in job table! {xss_check}"
            assert "(0 assets)" in xss_check["tableText"], f"Expected coerced '(0 assets)', got: {xss_check['tableText']}"

            # 2B. Dust Converter (#selectDustBtn) <-> Planner <-> #runLiveQueueBtn Sync Backtest!
            pgS.click("#navLaunchBtn")
            pgS.wait_for_selector("#appShell:not(.hidden)")
            pgS.click(".ui-mode-btn[data-ui-mode='pro']")
            pgS.fill("#appEvmInput", VET_ADDR)
            pgS.click("#appScanBtn")
            pgS.wait_for_selector("#assetListBody .asset-row", timeout=8000)
            pgS.click("#selectDustBtn")
            pgS.wait_for_function("() => document.getElementById('tabLegCount')?.textContent === '1'", timeout=8000)
            dust_sync = pgS.evaluate("""() => ({
              tabLegs: document.getElementById('tabLegCount')?.textContent,
              ctaText: document.getElementById('runLiveQueueBtn')?.textContent,
              ctaDisabled: document.getElementById('runLiveQueueBtn')?.disabled,
            })""")
            assert dust_sync["tabLegs"] == "1", dust_sync
            assert not dust_sync["ctaDisabled"] and "1 Chain" in (dust_sync["ctaText"] or ""), dust_sync

            # 2C. Sequential Fallback Receipt Failure Abort Backtest!
            # Connect EVM + Solana, then run Base 3-step batch where step 1 receipt returns evmFailed: true.
            # Step 2 and Step 3 MUST NOT be prompted!
            pgS.unroute("**/api/jobs", route_xss_jobs)
            pgS.click("#connectSolBtn")
            pgS.wait_for_selector("[data-pick-sol]")
            pgS.click("[data-pick-sol]")
            pgS.wait_for_selector("#walletModalBackdrop", state="hidden")

            pgS.click("#connectEvmBtn")
            pgS.wait_for_selector("[data-pick-evm]")
            pgS.click("[data-pick-evm]")
            pgS.wait_for_selector("#walletModalBackdrop", state="hidden")
            pgS.wait_for_timeout(300)

            # Re-select dust after connect scan
            pgS.click("#selectDustBtn")
            pgS.wait_for_function("() => document.getElementById('tabLegCount')?.textContent === '1'", timeout=8000)

            pgS.click("[data-exec-chain-batch='base']")
            pgS.wait_for_function(
                "() => (document.getElementById('agentLegsFeed')?.innerText || '').includes('reverted onchain')",
                timeout=15000,
            )
            seq_tx_count = pgS.evaluate("() => (window.__seqTxCalls || []).length")
            assert seq_tx_count == 1, f"Expected sequential fallback to abort after step 1 failure (1 tx), got {seq_tx_count}!"

            # 2D. Direct Client-Side Pre-Sign Assertions + ton_rawSign Removal + ensureEvmChain Switch Check
            wallet_safety = pgS.evaluate(f"""async () => {{
              const w = await import('/wallets.js?v=12');
              const checks = {{}};

              // 1. Blind ton_rawSign must be removed and throw structured TonConnect guidance
              window.ton = {{
                async send(m) {{
                  if (m === 'ton_requestAccounts') return ['EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'];
                  if (m === 'ton_rawSign') throw new Error('BLIND_RAW_SIGN_CALLED');
                  return null;
                }}
              }};
              await w.connectFamilyWallet('ton');
              try {{
                await w.signFamilyGaslessIntent('ton', {{ intentDigestSha256: '0x' + 'aa'.repeat(32) }});
                checks.tonBlocked = false;
              }} catch (e) {{
                checks.tonBlocked = !String(e.message).includes('BLIND_RAW_SIGN_CALLED') && String(e.message).toLowerCase().includes('tonconnect');
              }}

              // 2. Pre-sign from mismatch must throw
              try {{
                await w.sendRealEvmTransaction(
                  {{ chainId: 8453, to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x1234', from: '0x0000000000000000000000000000000000000009' }}
                );
                checks.fromMismatchBlocked = false;
              }} catch (e) {{
                checks.fromMismatchBlocked = String(e.message).includes('signer mismatch');
              }}

              // 3. Pre-sign domain.chainId mismatch must throw
              try {{
                await w.signGaslessTypedData(
                  {{ domain: {{ chainId: 1 }}, message: {{ solanaRecipient: '{SOL_PUBKEY}' }} }},
                  8453,
                  {{ expectedFrom: '{VET_ADDR}', expectedSolanaDestination: '{SOL_PUBKEY}' }}
                );
                checks.chainIdMismatchBlocked = false;
              }} catch (e) {{
                checks.chainIdMismatchBlocked = String(e.message).includes('domain.chainId');
              }}

              // 4. Pre-sign solanaRecipient mismatch must throw
              try {{
                await w.signGaslessTypedData(
                  {{ domain: {{ chainId: 8453 }}, message: {{ witness: {{ solanaRecipient: '0x' + 'ff'.repeat(32) }} }} }},
                  8453,
                  {{ expectedFrom: '{VET_ADDR}', expectedSolanaDestination: '{SOL_PUBKEY}' }}
                );
                checks.solRecipientMismatchBlocked = false;
              }} catch (e) {{
                checks.solRecipientMismatchBlocked = String(e.message).includes('solanaRecipient');
              }}

              // 5. ensureEvmChain must re-verify eth_chainId and throw if wallet silently stayed on old chain
              const origReq = window.ethereum.request;
              window.ethereum.request = async ({{ method }}) => {{
                if (method === 'eth_chainId') return '0x1';
                if (method === 'wallet_switchEthereumChain') return null; // silent no-op!
                return null;
              }};
              try {{
                await w.ensureEvmChain(8453);
                checks.chainVerifyEnforced = false;
              }} catch (e) {{
                checks.chainVerifyEnforced = String(e.message).includes('failed to switch');
              }} finally {{
                window.ethereum.request = origReq;
              }}

              return checks;
            }}""")
            assert all(wallet_safety.values()), f"Wallet pre-sign safety check failed: {wallet_safety}"
            assert not errsS, f"Safety backtest errors: {errsS}"
            results["safety_backtest"] = {
                "ok": True,
                "xssBlocked": True,
                "dustConverterSynced": True,
                "sequentialAbortAfterStep1Fail": True,
                "walletPreSignChecks": wallet_safety,
            }
            ctxS.close()

            # ------------------------------------------------------------------
            # 3. LEGACY EOA + DEFI QUICK-UNWIND PANEL + 2-STAGE AUTO-BRIDGE
            # ------------------------------------------------------------------
            ctxL = browser.new_context(viewport={"width": 1440, "height": 900})
            pgL = ctxL.new_page()
            errsL = []
            pgL.on("pageerror", lambda e: errsL.append(str(e)))
            pgL.on("console", lambda m: errsL.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgL.add_init_script(f"""
              window.__legacyMethods = [];
              let chainHex = '0x89';
              let n = 0;
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  window.__legacyMethods.push(method);
                  if (method === 'eth_requestAccounts') return ['{VET_ADDR}'];
                  if (method === 'eth_chainId') return chainHex;
                  if (method === 'wallet_switchEthereumChain') {{ chainHex = params[0].chainId; return null; }}
                  if (method === 'wallet_getCapabilities' || method === 'wallet_sendCalls') {{
                    const err = new Error('Method not found');
                    err.code = -32601;
                    throw err;
                  }}
                  if (method === 'eth_sendTransaction') {{
                    n++;
                    return '0x' + String(n).padStart(64, 'b');
                  }}
                  return null;
                }}
              }};
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }}
                }}
              }};
            """)

            def build_vet_scan(body=None):
                scan_copy = json.loads(json.dumps(veteran_fixture))
                scan_copy["walletAddress"] = VET_ADDR
                return scan_copy

            def route_vet(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(build_vet_scan()))

            route_vet_hydrate = make_hydrate_route(build_vet_scan)

            def route_tx_status_ok(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"evmConfirmed": True, "evmFailed": False, "bridgeStatus": "confirmed"}),
                )

            pgL.route("**/api/workspace/hydrate", route_vet_hydrate)
            pgL.route("**/api/scan", route_vet)
            pgL.route("**/api/tx/status", route_tx_status_ok)
            pgL.route("**/api/solana/overview", route_sol_overview)
            pgL.route("**/api/solana/balance*", route_sol_balance)
            pgL.goto(BASE, wait_until="networkidle")
            pgL.click("#siteConnectBtn")
            pgL.wait_for_selector("[data-pick-evm]")
            pgL.click("[data-pick-evm]")
            pgL.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgL.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent === '6'", timeout=15000)
            pgL.click(".ui-mode-btn[data-ui-mode='pro']")

            # Connect Solana before sweeping
            pgL.click("#connectSolBtn")
            pgL.wait_for_selector("[data-pick-sol]")
            pgL.click("[data-pick-sol]")
            pgL.wait_for_selector("#walletModalBackdrop", state="hidden")

            pgL.wait_for_selector("#defiUnwindPanel:not(.hidden)", timeout=10000)
            defi_check = pgL.evaluate("""() => {
              const panel = document.getElementById('defiUnwindPanel');
              const groups = Array.from(panel.querySelectorAll('[data-protocol-group]')).map(el => el.dataset.protocolGroup);
              const imgs = Array.from(panel.querySelectorAll('img'));
              const brokenImgs = imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
              const badges = Array.from(panel.querySelectorAll('.defi-exit-badge')).map(el => el.innerText.trim());
              const statuses = Array.from(panel.querySelectorAll('.defi-status-pill')).map(el => el.innerText.trim());
              const routes = Array.from(panel.querySelectorAll('.defi-route-text')).map(el => el.innerText.trim());
              const details = Array.from(panel.querySelectorAll('.defi-tech-details'));
              const allCollapsed = details.length > 0 && details.every(d => !d.open);
              const visibleText = panel.innerText;
              const overflow = document.documentElement.scrollWidth - window.innerWidth;
              return { groups, brokenImgs, badges, statuses, routes, allCollapsed, visibleText, overflow };
            }""")
            assert "Aave v3" in defi_check["groups"] and "Compound v3" in defi_check["groups"] and "Lido" in defi_check["groups"], defi_check
            assert not defi_check["brokenImgs"], defi_check
            assert any("1-Click Extract → Solana" in b for b in defi_check["badges"]), defi_check
            assert any("Instant Swap (Skips Cooldown)" in b for b in defi_check["badges"]), defi_check
            assert any("Verified withdrawable" in s for s in defi_check["statuses"]), defi_check
            assert defi_check["allCollapsed"], defi_check
            assert "WITHDRAW_AND_BRIDGE" not in defi_check["visibleText"], defi_check
            assert defi_check["overflow"] <= 0, defi_check

            pgL.locator(".defi-tech-details > summary").first.click()
            assert pgL.evaluate("() => document.querySelector('.defi-tech-details')?.open === true")

            pgL.select_option("#bridgePrefSelect", "cctp")
            pgL.click("[data-exec-chain-batch='polygon']")
            pgL.wait_for_function(
                "() => (window.__legacyMethods || []).filter(m => m === 'eth_sendTransaction').length === 3",
                timeout=20000,
            )
            pgL.wait_for_selector("#defiGuidedStepper:not(.hidden)", timeout=10000)
            assert not errsL, f"Legacy fallback errors: {errsL}"
            results["legacy_and_defi_ux"] = {
                "ok": True,
                "ethSendTransactionCount": 3,
                "defiProtocolGroups": defi_check["groups"],
            }
            ctxL.close()

            # ------------------------------------------------------------------
            # 3B. DEFI 2-STAGE AUTO-BRIDGE + PROTOCOL XSS ESCAPING
            # ------------------------------------------------------------------
            ctxX = browser.new_context(viewport={"width": 1440, "height": 900})
            pgX = ctxX.new_page()
            errsX = []
            pgX.on("pageerror", lambda e: errsX.append(str(e)))
            pgX.add_init_script(f"""
              window.__xssFired = false;
              window.__stage2BatchCalls = [];
              let txCount = 0;
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  if (method === 'eth_requestAccounts') return ['{VET_ADDR}'];
                  if (method === 'eth_chainId') return '0x2105';
                  if (method === 'wallet_switchEthereumChain') return null;
                  if (method === 'wallet_getCapabilities' || method === 'wallet_sendCalls') {{
                    const err = new Error('Method not found');
                    err.code = -32601;
                    throw err;
                  }}
                  if (method === 'eth_sendTransaction') {{
                    txCount++;
                    window.__stage2BatchCalls.push(params[0]);
                    return '0x' + String(txCount).padStart(64, 'e');
                  }}
                  return null;
                }}
              }};
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }}
                }}
              }};
            """)

            def build_defi_plan_scan(body=None):
                payload = json.loads(json.dumps(veteran_fixture))
                payload["walletAddress"] = VET_ADDR
                for a in payload["assets"]:
                    if a["symbol"] == "aEthUSDC":
                        a["defiExitPlan"] = {
                            "mode": "safe_partial",
                            "safePartialSupported": True,
                            "maxSafeWithdrawUi": 900,
                            "preflightStatus": "warning",
                            "preflightMessage": "Debt guard: <img src=x onerror=\"window.__xssFired=true\"> safe excess only",
                            "underlyingSymbol": "USDC",
                            "signaturesRequired": 1,
                        }
                        a["aaveDebtUsd"] = 320.5
                        a["aaveHealthFactor"] = 1.92
                    elif a["symbol"] == "cUSDCv3":
                        a["defiExitPlan"] = {
                            "mode": "one_click",
                            "protocolName": "Morpho / Vaults <script>window.__xssFired=true</script>",
                            "preflightStatus": "verified",
                            "underlyingSymbol": "USDC",
                            "signaturesRequired": 2,
                            "requiresSecondStep": True,
                            "calldataPreview": "0x69328dec000000000000000000000000deadbeef",
                        }
                    elif a["symbol"] == "aArbUSDCn":
                        a["defiExitPlan"] = {
                            "mode": "cooldown",
                            "preflightStatus": "cooldown",
                            "cooldownLabel": "7-day unbonding queue",
                            "underlyingSymbol": "USDC",
                        }
                return payload

            def route_defi_plan_scan(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(build_defi_plan_scan()))

            route_defi_plan_hydrate = make_hydrate_route(build_defi_plan_scan)

            prepare_call_count = {"n": 0}

            def route_prepare_two_stage(route):
                prepare_call_count["n"] += 1
                if prepare_call_count["n"] == 1:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "chain": "base",
                            "chainId": 8453,
                            "chainName": "Base",
                            "calls": [{
                                "stepId": "erc4626_redeem",
                                "assetId": "base-vault",
                                "assetSymbol": "cUSDCv3",
                                "action": "WITHDRAW_AND_BRIDGE",
                                "provider": "erc4626",
                                "label": "Withdraw from Vault",
                                "to": "0xb125E6687d4313864e53df431d5425969c15Eb2F",
                                "data": "0x12345678",
                                "value": "0x0",
                            }],
                            "bridgeTrackers": [],
                            "skippedAssets": [],
                            "savings": {"popupsSaved": 0},
                        }),
                    )
                else:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "chain": "base",
                            "chainId": 8453,
                            "chainName": "Base",
                            "calls": [{
                                "stepId": "relay_bridge_unlocked",
                                "assetId": "base-vault:unlocked",
                                "assetSymbol": "USDC",
                                "action": "BRIDGE_DIRECT_USDC",
                                "provider": "relay",
                                "label": "Bridge unlocked USDC → Solana",
                                "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                                "data": "0xabcdef01",
                                "value": "0x0",
                            }],
                            "bridgeTrackers": [{
                                "assetId": "base-vault:unlocked",
                                "assetSymbol": "USDC",
                                "provider": "relay",
                                "requestId": "req_auto_stage2",
                                "estimatedOutput": "804.45 USDC",
                                "estimatedSeconds": 4,
                                "requiresSolanaClaim": False,
                            }],
                            "skippedAssets": [],
                            "savings": {"popupsSaved": 0},
                        }),
                    )

            pgX.route("**/api/workspace/hydrate", route_defi_plan_hydrate)
            pgX.route("**/api/scan", route_defi_plan_scan)
            pgX.route("**/api/tx/prepare-chain-batch", route_prepare_two_stage)
            pgX.route("**/api/tx/status", route_tx_status_ok)
            pgX.route("**/api/solana/overview", route_sol_overview)
            pgX.route("**/api/solana/balance*", route_sol_balance)
            pgX.goto(BASE, wait_until="networkidle")
            pgX.click("#siteConnectBtn")
            pgX.wait_for_selector("[data-pick-evm]")
            pgX.click("[data-pick-evm]")
            pgX.wait_for_selector("#defiUnwindPanel:not(.hidden)", timeout=15000)

            pgX.click("#connectSolBtn")
            pgX.wait_for_selector("[data-pick-sol]")
            pgX.click("[data-pick-sol]")
            pgX.wait_for_selector("#walletModalBackdrop", state="hidden")

            xss_and_badges = pgX.evaluate("""() => {
              const panel = document.getElementById('defiUnwindPanel');
              const badges = Array.from(panel.querySelectorAll('.defi-exit-badge')).map(el => el.innerText.trim());
              return {
                xssFired: Boolean(window.__xssFired),
                badges,
                hasScriptTag: panel.querySelectorAll('script').length,
                hasRawCalldataVisible: panel.innerText.includes('0x69328dec'),
              };
            }""")
            assert not xss_and_badges["xssFired"] and xss_and_badges["hasScriptTag"] == 0, xss_and_badges
            assert not xss_and_badges["hasRawCalldataVisible"], xss_and_badges

            pgX.locator("[data-extract-protocol='Morpho / Vaults']").click()
            pgX.wait_for_function("() => (window.__stage2BatchCalls || []).length === 2", timeout=15000)
            pgX.locator("[data-stepper-step='withdraw'].is-done").wait_for(state="visible", timeout=15000)
            assert pgX.locator("[data-stepper-step='withdraw'].is-done").count() == 1
            pgX.locator("[data-stepper-step='bridge'].is-done").wait_for(state="visible", timeout=15000)
            assert pgX.locator("[data-stepper-step='bridge'].is-done").count() == 1
            assert not errsX, f"DeFi 2-stage errors: {errsX}"
            results["defi_two_stage_auto_bridge"] = {"ok": True, "autoStage2TxCount": 2}
            ctxX.close()

            # ------------------------------------------------------------------
            # 4. TABLET 900x800: Connected EVM + Solana 0px Overflow Across All 5 Views
            # ------------------------------------------------------------------
            ctxT = browser.new_context(viewport={"width": 900, "height": 800})
            pgT = ctxT.new_page()
            errsT = []
            pgT.on("pageerror", lambda e: errsT.append(f"pageerror: {e}"))
            pgT.on("console", lambda m: errsT.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgT.add_init_script(f"""
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method }}) {{
                  if (method === 'eth_requestAccounts') return ['{VITALIK}'];
                  if (method === 'eth_chainId') return '0x1';
                  return null;
                }}
              }};
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }}
                }}
              }};
            """)
            pgT.route("**/api/workspace/hydrate", route_hydrate_deterministic)
            pgT.route("**/api/scan", route_scan_deterministic)
            pgT.route("**/api/solana/overview", route_sol_overview)
            pgT.route("**/api/solana/balance*", route_sol_balance)
            pgT.goto(BASE, wait_until="networkidle")
            pgT.wait_for_timeout(300)

            pgT.click("#siteConnectBtn")
            pgT.wait_for_selector("[data-pick-evm]")
            pgT.click("[data-pick-evm]")
            pgT.wait_for_selector("#appShell:not(.hidden)", timeout=15000)

            pgT.click("#connectSolBtn")
            pgT.wait_for_selector("[data-pick-sol]")
            pgT.click("[data-pick-sol]")
            pgT.wait_for_selector("#walletModalBackdrop", state="hidden")
            pgT.wait_for_timeout(200)

            overflowT = {
                "scanner_lite": pgT.evaluate("() => document.documentElement.scrollWidth - window.innerWidth"),
            }
            assert_zero_gambling_in_dom(pgT, "tablet_900_lite")
            pgT.click(".ui-mode-btn[data-ui-mode='pro']")
            pgT.wait_for_timeout(120)
            for view in ["scanner", "activity", "ai", "agents", "contract"]:
                pgT.click(f".app-tab[data-view='{view}']")
                pgT.wait_for_timeout(150)
                overflowT[view] = pgT.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert_zero_gambling_in_dom(pgT, f"tablet_900_{view}")
            pgT.click("#backToSiteBtn")
            pgT.wait_for_selector("#siteShell:not(.hidden)")
            pgT.wait_for_timeout(150)
            overflowT["website_connected"] = pgT.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")

            assert all(v <= 0 for v in overflowT.values()), f"Tablet 900px overflow: {overflowT}"
            assert not errsT, f"Tablet 900px errors: {errsT}"
            results["tablet_900"] = {"ok": True, "overflowPx": overflowT}
            ctxT.close()

            # ------------------------------------------------------------------
            # 5. MOBILE 390x844: Connected Nav 0px Overflow, Visible Safety Badges,
            #    Constrained Toast Rect, Scrollable SVG & All 5 Views
            # ------------------------------------------------------------------
            ctxM = browser.new_context(viewport={"width": 390, "height": 844})
            pgM = ctxM.new_page()
            errsM = []
            pgM.on("pageerror", lambda e: errsM.append(f"pageerror: {e}"))
            pgM.on("console", lambda m: errsM.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgM.add_init_script(f"""
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method }}) {{
                  if (method === 'eth_requestAccounts') return ['{VITALIK}'];
                  if (method === 'eth_chainId') return '0x1';
                  return null;
                }}
              }};
            """)
            pgM.route("**/api/workspace/hydrate", route_hydrate_deterministic)
            pgM.route("**/api/scan", route_scan_deterministic)
            pgM.route("**/api/solana/overview", route_sol_overview)
            pgM.route("**/api/solana/balance*", route_sol_balance)
            pgM.goto(BASE, wait_until="networkidle")
            pgM.wait_for_timeout(350)
            assert_zero_gambling_in_dom(pgM, "mobile_390_website")

            overflowM = {"website": pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")}
            maybe_shot(pgM, "goal_mobile_website_390.png", full_page=True)

            # Connect MetaMask on Mobile -> go back to Website -> verify connected .site-nav-inner has 0px overflow!
            pgM.click("#heroConnectBtn")
            pgM.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            pgM.click("[data-pick-evm]")
            pgM.wait_for_selector("#appShell:not(.hidden)", timeout=15000)

            pgM.click("#backToSiteBtn")
            pgM.wait_for_selector("#siteShell:not(.hidden)")
            pgM.wait_for_timeout(200)
            connected_nav_m = pgM.evaluate("""() => {
              const nav = document.querySelector('.site-nav-inner');
              const launch = document.getElementById('navLaunchBtn');
              const r = launch?.getBoundingClientRect();
              return {
                docOverflow: document.documentElement.scrollWidth - window.innerWidth,
                navOverflow: (nav?.scrollWidth || 0) - (nav?.clientWidth || 0),
                launchRight: r ? Math.round(r.right) : 0,
              };
            }""")
            assert connected_nav_m["docOverflow"] <= 0 and connected_nav_m["navOverflow"] <= 0, f"Mobile connected nav overflow: {connected_nav_m}"
            overflowM["website_connected"] = connected_nav_m["docOverflow"]

            # Return to Console & trigger a long validation toast (by clicking Sweep with empty Solana dest)
            pgM.click("#navLaunchBtn")
            pgM.wait_for_selector("#appShell:not(.hidden)")
            pgM.wait_for_selector("#defiUnwindPanel:not(.hidden)", timeout=10000)

            pgM.click("#runLiveQueueBtn")
            pgM.wait_for_selector(".toast-msg", timeout=3000)
            toast_rect = pgM.evaluate("""() => {
              const r = document.querySelector('.toast-msg')?.getBoundingClientRect();
              return r ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) } : null;
            }""")
            assert toast_rect and toast_rect["left"] >= 0 and toast_rect["right"] <= 390, f"Mobile toast clipped: {toast_rect}"

            # Verify Honeypot / ROI safety badges (.asset-row-tag) are VISIBLE at 390px!
            badge_vis = pgM.evaluate("""() => {
              const tags = Array.from(document.querySelectorAll('.asset-row-tag'));
              const visible = tags.filter(el => {
                const st = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return st.display !== 'none' && r.width > 0 && r.height > 0;
              });
              return { total: tags.length, visible: visible.length };
            }""")
            assert badge_vis["total"] > 0 and badge_vis["visible"] == badge_vis["total"], f"Mobile safety badges hidden: {badge_vis}"

            # Verify Lite mode 0px overflow + Mobile Sweep CTA near top (y < 600px, NOT 40,664px down!)
            pgM.evaluate("() => window.scrollTo(0, 0)")
            pgM.wait_for_timeout(120)
            mobile_cta_top = pgM.evaluate("""() => {
              const r = document.getElementById('runLiveQueueBtn')?.getBoundingClientRect();
              return r ? Math.round(r.top) : 99999;
            }""")
            assert mobile_cta_top < 600, f"Mobile 390px Sweep CTA buried too low: y={mobile_cta_top}px"
            overflowM["scanner_lite"] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            maybe_shot(pgM, "goal_mobile_lite_390.png", full_page=True)

            pgM.click(".ui-mode-btn[data-ui-mode='pro']")
            pgM.wait_for_timeout(150)
            pgM.locator(".defi-tech-details > summary").first.click()
            pgM.wait_for_timeout(150)
            overflowM["scanner_defi"] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")

            for view in ["scanner", "activity", "ai", "agents", "contract"]:
                pgM.click(f".app-tab[data-view='{view}']")
                pgM.wait_for_timeout(200)
                overflowM[view] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert_zero_gambling_in_dom(pgM, f"mobile_390_{view}")
                if view == "activity":
                    svg_w = pgM.evaluate("() => document.getElementById('turgaliumFlowSvg')?.getBoundingClientRect()?.width || 0")
                    assert svg_w >= 700, f"Expected horizontally scrollable readable SVG (>=700px) on mobile, got {svg_w}px"
                elif view == "ai":
                    pgM.wait_for_selector("#view-ai.active", timeout=5000)
                shot_name = "burns" if view == "activity" else view
                maybe_shot(pgM, f"goal_mobile_{shot_name}_390.png", full_page=True)

            broken_imgs_m = pgM.evaluate("""() => {
              return Array.from(document.querySelectorAll('img')).filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
            }""")
            assert not broken_imgs_m, f"Broken mobile images: {broken_imgs_m}"
            assert all(v <= 0 for v in overflowM.values()), f"Mobile overflow: {overflowM}"
            assert not errsM, f"Mobile errors: {errsM}"
            results["mobile_390"] = {
                "ok": True,
                "mobileCtaTopPx": mobile_cta_top,
                "connectedNav": connected_nav_m,
                "toastRect": toast_rect,
                "visibleSafetyBadges": badge_vis,
                "overflowPx": overflowM,
            }
            ctxM.close()

            # ------------------------------------------------------------------
            # 6. BURN CSV FORMULA-INJECTION EXPORT & JSON COPY, PLUGIN TOKENS
            #    ISSUE/REVOKE, SOL OUTPUT TOGGLE, AND EVM 4001 REJECTION RECOVERY
            # ------------------------------------------------------------------
            ctxE = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
            pgE = ctxE.new_page()
            errsE = []
            badHttpE = []
            pgE.on("pageerror", lambda e: errsE.append(f"pageerror: {e}"))
            pgE.on("console", lambda m: errsE.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgE.on(
                "response",
                lambda r: badHttpE.append(f"{r.status} {r.request.method} {r.url}")
                if r.status >= 400 and "/api/solana/balance" not in r.url
                else None,
            )

            pgE.add_init_script(f"""
              window.__copiedTexts = [];
              try {{
                Object.defineProperty(navigator, 'clipboard', {{
                  configurable: true,
                  value: {{
                    async writeText(text) {{
                      window.__copiedTexts.push(String(text));
                    }},
                  }},
                }});
              }} catch {{}}

              window.__rejectNextConnect = true;
              window.__rejectNextSendCalls = true;
              window.__evm4001Rpc = [];
              let chainHex = '0x2105';
              const evmProvider = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  window.__evm4001Rpc.push({{ method, params }});
                  if (method === 'eth_requestAccounts') {{
                    if (window.__rejectNextConnect) {{
                      window.__rejectNextConnect = false;
                      const err = new Error('User rejected the request.');
                      err.code = 4001;
                      throw err;
                    }}
                    return ['{VITALIK}'];
                  }}
                  if (method === 'eth_chainId') return chainHex;
                  if (method === 'wallet_switchEthereumChain') {{
                    chainHex = params[0].chainId;
                    return null;
                  }}
                  if (method === 'wallet_getCapabilities') {{
                    return {{
                      '0x2105': {{ atomic: {{ status: 'supported' }} }},
                    }};
                  }}
                  if (method === 'wallet_sendCalls') {{
                    if (window.__rejectNextSendCalls) {{
                      window.__rejectNextSendCalls = false;
                      const err = new Error('User rejected the request.');
                      err.code = 4001;
                      throw err;
                    }}
                    return {{ id: '0xbatch_after_4001' }};
                  }}
                  if (method === 'wallet_getCallsStatus') {{
                    return {{ status: 200, receipts: [{{ transactionHash: '0x' + 'dd'.repeat(32), status: '0x1' }}] }};
                  }}
                  if (method === 'eth_sendTransaction') {{
                    return '0x' + 'ee'.repeat(32);
                  }}
                  return null;
                }},
              }};
              window.ethereum = evmProvider;
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }},
                  async disconnect() {{}},
                }},
              }};
            """)

            def build_export_scan(body=None):
                scan_copy = json.loads(json.dumps(veteran_fixture))
                scan_copy["walletAddress"] = VITALIK
                scan_copy["assets"].extend([
                    {
                        "id": "polygon-csv-honeypot",
                        "chain": "polygon",
                        "chainId": 137,
                        "chainName": "Polygon",
                        "address": "0x3333333333333333333333333333333333333333",
                        "symbol": "=CMD|' /C calc'!A0",
                        "name": "Formula Honeypot",
                        "decimals": 18,
                        "rawBalance": "1000000000000000000000",
                        "uiBalance": 1000,
                        "priceUsd": 0,
                        "grossUsd": 0,
                        "liquidityUsd": 0,
                        "estimatedGasUsd": 0.01,
                        "batchedGasUsd": 0.01,
                        "estimatedSlippageUsd": 0,
                        "netUsdcSingle": 0,
                        "netUsdcBatched": 0,
                        "kind": "dead_token",
                        "action": "SKIP_HONEYPOT",
                        "actionReason": "+SUM(A1:A2)\r\n=EVIL",
                        "selectedByDefault": False,
                        "honeypotSafe": False,
                    },
                    {
                        "id": "base-csv-burn",
                        "chain": "base",
                        "chainId": 8453,
                        "chainName": "Base",
                        "address": "0x4444444444444444444444444444444444444444",
                        "symbol": '@HYPERLINK("http://evil.example","x")',
                        "name": "Formula Dead Token",
                        "decimals": 18,
                        "rawBalance": "50000000000000000000",
                        "uiBalance": 50,
                        "priceUsd": 0,
                        "grossUsd": 0,
                        "liquidityUsd": 0,
                        "estimatedGasUsd": 0.01,
                        "batchedGasUsd": 0.01,
                        "estimatedSlippageUsd": 0,
                        "netUsdcSingle": 0,
                        "netUsdcBatched": 0,
                        "kind": "dead_token",
                        "action": "SKIP_HONEYPOT",
                        "actionReason": "-1+1",
                        "selectedByDefault": False,
                        "honeypotSafe": False,
                    },
                ])
                return scan_copy

            def route_export_scan(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(build_export_scan()))

            route_export_hydrate = make_hydrate_route(build_export_scan)

            pgE.route("**/api/workspace/hydrate", route_export_hydrate)
            pgE.route("**/api/scan", route_export_scan)
            pgE.route("**/api/solana/overview", route_sol_overview)
            pgE.route("**/api/solana/balance*", route_sol_balance)
            pgE.route("**/api/tx/prepare-chain-batch", route_prepare_base_eip5792)

            pgE.goto(BASE, wait_until="networkidle")
            pgE.wait_for_timeout(300)

            # 6A. EVM Wallet 4001 User-Rejection on Connect -> Graceful Recovery on Retry
            pgE.click("#heroConnectBtn")
            pgE.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            pgE.click("[data-pick-evm]")
            pgE.wait_for_function(
                "() => (document.getElementById('walletModalBackdrop')?.innerText || '').toLowerCase().includes('rejected') || (document.getElementById('toastRegion')?.innerText || '').toLowerCase().includes('rejected')",
                timeout=5000,
            )
            assert pgE.locator("#walletModalBackdrop:not(.hidden)").count() == 1, "Modal should stay open after 4001 connect rejection"

            # Retry EVM connect -> succeeds cleanly
            pgE.click("[data-pick-evm]")
            pgE.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgE.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=15000)

            # Switch to Pro mode & connect Solana
            pgE.click(".ui-mode-btn[data-ui-mode='pro']")
            pgE.wait_for_function("() => document.documentElement.dataset.uiMode === 'pro'", timeout=5000)
            pgE.click("#connectSolBtn")
            pgE.wait_for_selector("[data-pick-sol]")
            pgE.click("[data-pick-sol]")
            pgE.wait_for_selector("#walletModalBackdrop", state="hidden")

            # 6B. SOL Output Toggle (switches summary & payout logo to SOL, disables CCTP option, restores on USDC)
            pgE.click(".seg-opt[data-out-asset='SOL']")
            pgE.wait_for_function(
                "() => document.querySelector('.seg-opt[data-out-asset=\"SOL\"]')?.classList.contains('active') && (document.getElementById('kpiNetUsdc')?.textContent || '').includes('SOL')",
                timeout=8000,
            )
            sol_toggle = pgE.evaluate("""() => ({
              netText: document.getElementById('kpiNetUsdc')?.textContent?.trim() || '',
              logoSrc: document.getElementById('payoutAssetLogo')?.getAttribute('src') || '',
              cctpDisabled: Boolean(document.querySelector("#bridgePrefSelect option[value='cctp']")?.disabled),
              cctpLabel: document.querySelector("#bridgePrefSelect option[value='cctp']")?.textContent?.trim() || '',
            })""")
            assert "SOL" in sol_toggle["netText"], sol_toggle
            assert "solana.svg" in sol_toggle["logoSrc"], sol_toggle
            assert sol_toggle["cctpDisabled"] and "USDC only" in sol_toggle["cctpLabel"], sol_toggle

            pgE.click(".seg-opt[data-out-asset='USDC']")
            pgE.wait_for_function(
                "() => document.querySelector('.seg-opt[data-out-asset=\"USDC\"]')?.classList.contains('active') && !(document.querySelector('#bridgePrefSelect option[value=\"cctp\"]')?.disabled)",
                timeout=8000,
            )

            # 6C. EVM Wallet 4001 User-Rejection on Batch Execution -> No Sequential Fallback & Clean Retry Recovery
            pgE.click("[data-exec-chain-batch='base']")
            pgE.wait_for_function(
                """() => (window.__evm4001Rpc || []).some(r => r.method === 'wallet_sendCalls')
                  && !document.querySelector("[data-exec-chain-batch='base']")?.disabled
                  && (document.getElementById('agentLegsFeed')?.innerText || '').toLowerCase().includes('rejected')""",
                timeout=10000,
            )
            # Must NOT fall back to eth_sendTransaction after 4001 user rejection, and button must unlock for retry
            after_4001_exec = pgE.evaluate("""() => ({
              rpcMethods: (window.__evm4001Rpc || []).map(r => r.method),
              baseBtnDisabled: Boolean(document.querySelector("[data-exec-chain-batch='base']")?.disabled),
            })""")
            assert "wallet_sendCalls" in after_4001_exec["rpcMethods"], after_4001_exec
            assert "eth_sendTransaction" not in after_4001_exec["rpcMethods"], f"4001 rejection wrongly fell back to eth_sendTransaction: {after_4001_exec}"
            assert not after_4001_exec["baseBtnDisabled"], f"Base batch button stuck disabled after 4001 rejection: {after_4001_exec}"

            # Retry Base batch -> succeeds cleanly on second attempt
            pgE.click("[data-exec-chain-batch='base']")
            pgE.wait_for_function(
                "() => (window.__evm4001Rpc || []).filter(r => r.method === 'wallet_sendCalls').length === 2",
                timeout=10000,
            )

            # 6D. Burn Receipt CSV Formula-Injection Export (#downloadBurnCsvBtn) & JSON Copy (#copyBurnJsonBtn)
            pgE.click(".app-tab[data-view='activity']")
            pgE.wait_for_selector("#downloadBurnCsvBtn", timeout=5000)
            pgE.wait_for_selector("#copyBurnJsonBtn", timeout=5000)

            with pgE.expect_download(timeout=10000) as dl_info:
                pgE.click("#downloadBurnCsvBtn")
            download = dl_info.value
            assert download.suggested_filename.startswith("turgalium-burn-receipt-") and download.suggested_filename.endswith(".csv"), download.suggested_filename
            csv_path = download.path()
            with open(csv_path, "r", encoding="utf-8") as fh:
                csv_text = fh.read()
            assert "\r" not in csv_text, f"Raw CR leaked into CSV export: {csv_text!r}"
            csv_lines = csv_text.split("\n")
            assert csv_lines[0] == "chain,symbol,token_address,amount,status,burn_sink,reason", csv_lines[0]
            assert len(csv_lines) >= 3, f"Expected header + >=2 burn rows, got {len(csv_lines)}: {csv_lines}"
            assert "\"'=CMD|' /C calc'!A0\"" in csv_text, f"Missing neutralized =CMD payload in CSV: {csv_text}"
            assert "\"'+SUM(A1:A2) =EVIL\"" in csv_text, f"Missing neutralized +SUM/CRLF payload in CSV: {csv_text}"
            assert "\"'@HYPERLINK(\"\"http://evil.example\"\",\"\"x\"\")\"" in csv_text, f"Missing neutralized @HYPERLINK payload in CSV: {csv_text}"
            assert "\"'-1+1\"" in csv_text, f"Missing neutralized -1+1 payload in CSV: {csv_text}"

            pgE.click("#copyBurnJsonBtn")
            pgE.wait_for_function("() => (window.__copiedTexts || []).length >= 1", timeout=5000)
            copied_json_raw = pgE.evaluate("() => window.__copiedTexts[window.__copiedTexts.length - 1]")
            copied_manifest = json.loads(copied_json_raw)
            assert isinstance(copied_manifest, list) and len(copied_manifest) >= 2, copied_manifest
            assert any(item.get("symbol") == "=CMD|' /C calc'!A0" for item in copied_manifest), copied_manifest

            # 6E. Plugin Tokens Issue (#issueMcpTokenBtn & #issueGptTokenBtn) + Revoke ([data-revoke-token])
            pgE.click(".app-tab[data-view='agents']")
            pgE.wait_for_selector("#issueMcpTokenBtn", timeout=5000)
            pgE.wait_for_selector("#issueGptTokenBtn", timeout=5000)

            pgE.click("#issueMcpTokenBtn")
            pgE.wait_for_selector("[data-revoke-token][data-token-client='claude_mcp']", timeout=8000)
            pgE.wait_for_function(
                "() => !(document.getElementById('claudeMcpConfigHost')?.innerText || '').includes('<generate Claude token above>')",
                timeout=5000,
            )

            pgE.click("#issueGptTokenBtn")
            pgE.wait_for_selector("[data-revoke-token][data-token-client='chatgpt_action']", timeout=8000)
            pgE.wait_for_function(
                "() => !(document.getElementById('chatgptPluginHost')?.innerText || '').includes('<generate ChatGPT token above>')",
                timeout=5000,
            )

            # Revoke both tokens via [data-revoke-token]
            pgE.locator("[data-revoke-token][data-token-client='claude_mcp']").first.click()
            pgE.wait_for_function(
                "() => (document.getElementById('pluginTokensHost')?.innerText || '').includes('Revoked')",
                timeout=8000,
            )
            pgE.locator("[data-revoke-token][data-token-client='chatgpt_action']").first.click()
            pgE.wait_for_function(
                "() => document.querySelectorAll('#pluginTokensHost [data-revoke-token]').length === 0",
                timeout=8000,
            )

            overflowE = pgE.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            assert overflowE <= 0, f"Export/Tokens/4001 view overflow: {overflowE}"
            assert not errsE, f"Export/Tokens/4001 errors: {errsE}"
            assert not badHttpE, f"Export/Tokens/4001 bad HTTP: {badHttpE}"
            results["export_tokens_sol_4001"] = {
                "ok": True,
                "evm4001ConnectAndExecRecovered": True,
                "solToggleVerified": True,
                "burnCsvSanitizedRows": len(csv_lines) - 1,
                "burnJsonCopiedCount": len(copied_manifest),
                "pluginTokensIssuedAndRevoked": 2,
                "overflowPx": overflowE,
            }
            ctxE.close()

            # ------------------------------------------------------------------
            # 7. PRESERVATION TOOLS (RENT VACUUM, 100% PRINCIPAL-SAFE YIELD PARK,
            #    APPROVAL REVOKER), CONDENSED BATCH APIs, 1-CLICK SWEEP UX,
            #    GAS WATCHDOG & ANTI-GAMBLING REGRESSION ACROSS 1440/900/390px
            # ------------------------------------------------------------------
            ctxP = browser.new_context(viewport={"width": 1440, "height": 900})
            pgP = ctxP.new_page()
            errsP = []
            badHttpP = []
            hydrate_hits_p = []
            sol_overview_hits_p = []
            prepare_batch_hits_p = []
            pgP.on("pageerror", lambda e: errsP.append(f"pageerror: {e}"))
            pgP.on("console", lambda m: errsP.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgP.on(
                "response",
                lambda r: badHttpP.append(f"{r.status} {r.request.method} {r.url}")
                if r.status >= 400 and "/api/solana/balance" not in r.url
                else None,
            )

            pgP.add_init_script(f"""
              window.__xssP = false;
              window.__evmRpcP = [];
              window.__solSignCallsP = [];
              let chainHex = '0x1';
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
                removeListener() {{}},
                async request({{ method, params }}) {{
                  window.__evmRpcP.push({{ method, params }});
                  if (method === 'eth_requestAccounts') return ['{VITALIK}'];
                  if (method === 'eth_chainId') return chainHex;
                  if (method === 'wallet_switchEthereumChain') {{ chainHex = params[0].chainId; return null; }}
                  if (method === 'wallet_getCapabilities') {{
                    return {{
                      '0x1': {{ atomic: {{ status: 'supported' }} }},
                      '0x2105': {{ atomic: {{ status: 'supported' }} }},
                    }};
                  }}
                  if (method === 'wallet_sendCalls') return {{ id: '0xrevoke_batch_p' }};
                  if (method === 'wallet_getCallsStatus') {{
                    return {{ status: 200, receipts: [{{ transactionHash: '0x' + 'fa'.repeat(32), status: '0x1' }}] }};
                  }}
                  if (method === 'eth_sendTransaction') {{
                    return '0x' + 'be'.repeat(32);
                  }}
                  return null;
                }},
              }};
              window.phantom = {{
                solana: {{
                  isPhantom: true,
                  isConnected: true,
                  publicKey: {{ toString: () => '{SOL_PUBKEY}' }},
                  on() {{}},
                  removeListener() {{}},
                  async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }},
                  async disconnect() {{}},
                  async signAndSendTransaction(tx) {{
                    window.__solSignCallsP.push({{
                      hasSerialize: typeof tx?.serialize === 'function',
                      b64Len: (tx?.serializedTransactionBase64 || '').length,
                    }});
                    return {{ signature: '5wHu1qwD7q4s8kN2p9mX6vY3zB1cR4tG8jL2nP5qS7uV' }};
                  }},
                }},
              }};
            """)

            pgP.route("**/api/workspace/hydrate", make_hydrate_route(build_deterministic_scan, hits=hydrate_hits_p))
            pgP.route("**/api/scan", route_scan_deterministic)
            pgP.route("**/api/solana/overview", make_sol_overview_route(hits=sol_overview_hits_p))
            pgP.route("**/api/solana/balance*", route_sol_balance)

            # Real valid serialized Solana v0 VersionedTransactions for SOL_PUBKEY (verified client-side pre-sign!)
            valid_rent_tx_b64 = (
                "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAC"
                "BGdSBVwgs+nYdGZW3fc4VVB/h6tth1I+THan+jYJapnrdi21Noh+IPEBWNlBTldZCfDwJVI0HANhIg8iNglqmdADBkZv"
                "5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpAAAAAAAAAAAA"
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgAFAkCcAAADAwEAAAEJAA=="
            )
            valid_yield_tx_b64 = (
                "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAC"
                "A2dSBVwgs+nYdGZW3fc4VVB/h6tth1I+THan+jYJapnrAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAEedVb"
                "8jHAbu50xW7OaBUH/bGy3qP0jlECsc2iVrwTjwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgEABQJADQMA"
                "AgEABAECAwQA"
            )

            def route_rent_scan_mock(route):
                body = route.request.post_data_json or {}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "ownerAddress": body.get("ownerAddress", SOL_PUBKEY),
                        "scannedPrograms": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
                        "totalTokenAccountsScanned": 14,
                        "reclaimableCount": 3,
                        "skippedNonZeroCount": 11,
                        "skippedFrozenCount": 0,
                        "skippedUncloseableCount": 0,
                        "rentPerEmptyAccountSol": 0.00203928,
                        "reclaimableLamports": 6117840,
                        "reclaimableSol": 0.00611784,
                        "solPriceUsd": 150,
                        "solPriceSource": "explicit",
                        "reclaimableUsd": 0.92,
                        "maxAccountsPerTx": 20,
                        "batchesRequired": 1,
                        "reclaimableAccounts": [
                            {
                                "tokenAccount": "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs1",
                                "mint": "EPjFWdd5<img src=x onerror=\"window.__xssP=true\">",
                                "owner": body.get("ownerAddress", SOL_PUBKEY),
                                "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                "programKind": "spl-token",
                                "amount": "0",
                                "uiAmount": 0,
                                "decimals": 6,
                                "state": "initialized",
                                "frozen": False,
                                "closeable": True,
                                "closeAuthority": None,
                                "rentLamports": 2039280,
                                "rentSol": 0.00203928,
                            },
                            {
                                "tokenAccount": "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs2",
                                "mint": "So11111111111111111111111111111111111111112",
                                "owner": body.get("ownerAddress", SOL_PUBKEY),
                                "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                "programKind": "spl-token",
                                "amount": "0",
                                "uiAmount": 0,
                                "decimals": 9,
                                "state": "initialized",
                                "frozen": False,
                                "closeable": True,
                                "closeAuthority": None,
                                "rentLamports": 2039280,
                                "rentSol": 0.00203928,
                            },
                            {
                                "tokenAccount": "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs3",
                                "mint": "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
                                "owner": body.get("ownerAddress", SOL_PUBKEY),
                                "programId": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                                "programKind": "token-2022",
                                "amount": "0",
                                "uiAmount": 0,
                                "decimals": 9,
                                "state": "initialized",
                                "frozen": False,
                                "closeable": True,
                                "closeAuthority": None,
                                "rentLamports": 2039280,
                                "rentSol": 0.00203928,
                            },
                        ],
                        "unsignedCloseTx": {
                            "version": 0,
                            "ownerAddress": body.get("ownerAddress", SOL_PUBKEY),
                            "destination": body.get("ownerAddress", SOL_PUBKEY),
                            "authority": body.get("ownerAddress", SOL_PUBKEY),
                            "recentBlockhash": "11111111111111111111111111111111",
                            "accountCount": 3,
                            "closedAccounts": [
                                "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs1",
                                "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs2",
                                "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs3",
                            ],
                            "reclaimedLamports": 6117840,
                            "reclaimedSol": 0.00611784,
                            "serializedTransactionBase64": valid_rent_tx_b64,
                            "serializedMessageBase64": valid_rent_tx_b64,
                        },
                        "txBuildWarning": None,
                    }),
                )

            def route_yield_park_mock(route):
                body = route.request.post_data_json or {}
                total = float(body.get("totalUsdcAmount", 100))
                pct = float(body.get("preservePct", 100))
                yield_usdc = round(total * pct / 100.0, 2)
                liquid_reserve_usdc = round(total - yield_usdc, 2)
                build_tx = bool(body.get("buildTransaction", False))
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "planVersion": "turgalium-solana-yield-park-v1",
                        "ownerAddress": body.get("ownerAddress", SOL_PUBKEY),
                        "strategy": {
                            "id": "jupsol",
                            "name": "Jupiter Staked SOL (JupSOL)",
                            "protocol": "Jupiter / Sanctum LST",
                            "symbol": "JupSOL",
                            "executionMode": "jupiter_swap_v0",
                            "baselineApyPct": 7.1,
                            "preservesUsdPeg": False,
                            "appUrl": "https://jup.ag/swap/USDC-JupSOL",
                        },
                        "split": {
                            "totalUsdcAmount": total,
                            "totalUsdcRaw": str(int(round(total * 1_000_000))),
                            "preservePct": pct,
                            "liquidReservePct": round(100.0 - pct, 2),
                            "yieldUsdc": yield_usdc,
                            "yieldUsdcRaw": str(int(round(yield_usdc * 1_000_000))),
                            "liquidReserveUsdc": liquid_reserve_usdc,
                            "liquidReserveRaw": str(int(round(liquid_reserve_usdc * 1_000_000))),
                        },
                        "apy": {
                            "estimatedApyPct": 7.45,
                            "source": "live",
                            "apyRangePct": [6.0, 8.2],
                        },
                        "projections": {
                            "projectedAnnualYieldUsd": round(yield_usdc * 0.0745, 2),
                            "projectedMonthlyYieldUsd": round(yield_usdc * 0.0745 / 12.0, 2),
                            "projectedDailyYieldUsd": round(yield_usdc * 0.0745 / 365.0, 4),
                        },
                        "jupiterQuote": {
                            "estimatedOutputUi": round(yield_usdc / 150.0, 6),
                            "minOutputUi": round(yield_usdc / 151.0, 6),
                            "slippageBps": 50,
                            "priceImpactPct": 0.012,
                            "routeLabels": ["Orca Whirlpool", "Sanctum"],
                        },
                        "transaction": (
                            {
                                "version": 0,
                                "feePayer": body.get("ownerAddress", SOL_PUBKEY),
                                "serializedByteLength": 64,
                                "swapTransactionBase64": valid_yield_tx_b64,
                            }
                            if build_tx
                            else None
                        ),
                        "warnings": [],
                    }),
                )

            def route_approvals_scan_mock(route):
                body = route.request.post_data_json or {}
                chain = body.get("chain", "ethereum")
                chain_id = 8453 if chain == "base" else 1
                revoke_data_1 = "0x095ea7b3" + ("0" * 24) + "6b7a87899490ece95443e979ca9485cbe7e71522" + ("0" * 64)
                revoke_data_2 = "0x095ea7b3" + ("0" * 24) + "1111111254eeb25477b68fb85ed929f73a960582" + ("0" * 64)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "chain": chain,
                        "chainName": "Base" if chain == "base" else "Ethereum",
                        "chainId": chain_id,
                        "walletAddress": body.get("walletAddress", VITALIK),
                        "multicall3": "0xcA11bde05977b3631167028862bE2a173976CA11",
                        "tokensScanned": 18,
                        "spendersScanned": 12,
                        "scannedPairs": 216,
                        "failedPairs": 0,
                        "activeApprovalsCount": 2,
                        "unlimitedCount": 2,
                        "highRiskCount": 2,
                        "findings": [
                            {
                                "chain": chain,
                                "chainId": chain_id,
                                "token": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                                "tokenSymbol": "USDC",
                                "tokenDecimals": 6,
                                "spender": "0x6b7a87899490EcE95443e979cA9485CBE7E71522",
                                "spenderLabel": "Multichain v4 (Exploited)<img src=x onerror=\"window.__xssP=true\">",
                                "spenderProtocol": "Multichain",
                                "spenderCategory": "legacy_high_risk",
                                "spenderRiskLevel": "high",
                                "allowanceRaw": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                                "allowanceFormatted": "UNLIMITED",
                                "isUnlimited": True,
                                "isMaxUint256": True,
                                "severity": "critical",
                                "riskReason": "Compromised legacy bridge router — revoke immediately.",
                                "revokeCall": {
                                    "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                                    "data": revoke_data_1,
                                    "value": "0x0",
                                    "chainId": chain_id,
                                    "label": "Revoke USDC approval",
                                },
                            },
                            {
                                "chain": chain,
                                "chainId": chain_id,
                                "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                                "tokenSymbol": "WETH",
                                "tokenDecimals": 18,
                                "spender": "0x1111111254EEB25477B68fb85Ed929f73A960582",
                                "spenderLabel": "1inch Aggregation Router v5 (Legacy)",
                                "spenderProtocol": "1inch",
                                "spenderCategory": "legacy_high_risk",
                                "spenderRiskLevel": "high",
                                "allowanceRaw": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                                "allowanceFormatted": "UNLIMITED",
                                "isUnlimited": True,
                                "isMaxUint256": True,
                                "severity": "critical",
                                "riskReason": "Legacy aggregator router — revoke lingering unlimited allowance.",
                                "revokeCall": {
                                    "to": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                                    "data": revoke_data_2,
                                    "value": "0x0",
                                    "chainId": chain_id,
                                    "label": "Revoke WETH approval",
                                },
                            },
                        ],
                        "revokes": [],
                        "warnings": [],
                        "scannedAt": "2026-11-25T20:00:00.000Z",
                    }),
                )

            def route_prepare_batch_p(route):
                body = route.request.post_data_json or {}
                prepare_batch_hits_p.append(body)
                assets = body.get("assets") or []
                chains_seen = list(dict.fromkeys([a.get("chain") for a in assets if a.get("chain")]))
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "preparedAt": "2026-11-27T12:00:00.000Z",
                        "durationMs": 36,
                        "count": len(assets),
                        "readyCount": len(assets),
                        "failedCount": 0,
                        "totalNetUsd": 1412.25,
                        "totalGasUsd": 0.48,
                        "totalProtocolFeeUsd": 0,
                        "totalSignatures": max(1, len(chains_seen)),
                        "items": [
                            {
                                "assetId": a.get("id", f"asset-{idx}"),
                                "chain": a.get("chain", "base"),
                                "symbol": a.get("symbol", "USDC"),
                                "ok": True,
                            }
                            for idx, a in enumerate(assets)
                        ],
                    }),
                )

            def route_prepare_chain_batch_p(route):
                body = route.request.post_data_json or {}
                chain = body.get("chain", "base")
                chain_id_map = {
                    "ethereum": 1,
                    "base": 8453,
                    "arbitrum": 42161,
                    "optimism": 10,
                    "polygon": 137,
                    "avalanche": 43114,
                }
                cid = chain_id_map.get(chain, 8453)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "chain": chain,
                        "chainId": cid,
                        "chainName": chain.title(),
                        "calls": [{
                            "stepId": "bridge",
                            "assetId": f"{chain}-usdc",
                            "assetSymbol": "USDC",
                            "action": "BRIDGE_DIRECT_USDC",
                            "provider": "relay",
                            "label": f"Bridge {chain} USDC -> Solana",
                            "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                            "data": "0x12345678",
                            "value": "0x0",
                        }],
                        "bridgeTrackers": [{
                            "assetId": f"{chain}-usdc",
                            "assetSymbol": "USDC",
                            "provider": "relay",
                            "requestId": f"req_{chain}_p",
                            "estimatedOutput": "250.00 USDC",
                            "estimatedSeconds": 4,
                            "requiresSolanaClaim": False,
                        }],
                        "skippedAssets": [],
                        "savings": {"popupsSaved": 1},
                    }),
                )

            def route_bridge_status_batch_p(route):
                body = route.request.post_data_json or {}
                bridges = body.get("bridges") or []
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "results": [
                            {"id": b.get("id"), "status": "landed", "bridgeStatus": "confirmed"}
                            for b in bridges
                        ]
                    }),
                )

            pgP.route("**/api/solana/rent-scan", route_rent_scan_mock)
            pgP.route("**/api/solana/yield-park", route_yield_park_mock)
            pgP.route("**/api/approvals/scan", route_approvals_scan_mock)
            pgP.route("**/api/tx/prepare-batch", route_prepare_batch_p)
            pgP.route("**/api/tx/prepare-chain-batch", route_prepare_chain_batch_p)
            pgP.route("**/api/bridge/status-batch", route_bridge_status_batch_p)
            pgP.route("**/api/tx/status", route_tx_status_ok)

            pgP.goto(BASE, wait_until="networkidle")
            pgP.wait_for_timeout(300)

            # Connect EVM wallet to launch Migrator & trigger scan + Preservation Strip
            pgP.click("#heroConnectBtn")
            pgP.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            pgP.click("[data-pick-evm]")
            pgP.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgP.wait_for_selector("#preservationStripCard", timeout=15000)

            # 7A. Verify Preservation Strip surfaces 0% Open-Source Protocol Fee + Route Auction Winner
            strip_info = pgP.evaluate("""() => ({
              feeText: document.getElementById('preservationTieredFeePill')?.textContent?.trim() || '',
              routeText: document.getElementById('preservationRouteWinnerPill')?.textContent?.trim() || '',
              stripText: document.getElementById('preservationStripCard')?.innerText || '',
            })""")
            assert "0% Protocol Fee" in strip_info["feeText"] and "Open Source" in strip_info["feeText"], strip_info
            assert "Route Winner:" in strip_info["routeText"], strip_info

            # Connect Phantom Solana wallet for Rent Reclaim + Yield Park signing
            pgP.click("#connectSolBtn")
            pgP.wait_for_selector("[data-pick-sol]")
            pgP.click("[data-pick-sol]")
            pgP.wait_for_selector("#walletModalBackdrop", state="hidden")
            pgP.wait_for_function(f"() => document.getElementById('solanaDestInput')?.value === '{SOL_PUBKEY}'", timeout=10000)

            # 7B. Empty-ATA Rent Reclaim: scan + verify 0.00611784 SOL + 1-Click Reclaim signing
            pgP.click("#scanSolanaRentBtn")
            pgP.wait_for_selector("#reclaimSolBtn", timeout=8000)
            rent_text = pgP.locator("#rentVacuumCard").inner_text()
            assert "0.00611784 SOL" in rent_text and "$0.92" in rent_text, rent_text
            pgP.click("#reclaimSolBtn")
            pgP.wait_for_function("() => (window.__solSignCallsP || []).length === 1", timeout=8000)
            pgP.wait_for_function(
                "() => (document.getElementById('rentVacuumBody')?.innerText || '').includes('Reclaimed')",
                timeout=8000,
            )

            # 7C. 1-Click Post-Arrival Solana Yield Park: 100% principal-safe, zero gambling toggles, preview + 1-Click Park
            assert len(hydrate_hits_p) >= 1, "Expected POST /api/workspace/hydrate to hydrate wallet on connect!"
            assert len(sol_overview_hits_p) >= 1, "Expected POST /api/solana/overview to hydrate Solana balance/dust/yield on connect!"
            pgP.wait_for_function(
                "() => (document.querySelectorAll('#yieldStrategySelect option').length) >= 3",
                timeout=8000,
            )
            yield_safety_check = pgP.evaluate("""() => ({
              splitButtonsCount: document.querySelectorAll('#yieldParkCard [data-yield-split]').length,
              principalPill: document.querySelector('#yieldParkCard .ptool-principal-pill')?.textContent?.trim() || '',
              cardText: document.getElementById('yieldParkCard')?.innerText || '',
            })""")
            assert yield_safety_check["splitButtonsCount"] == 0, f"Removed yield split buttons still present: {yield_safety_check}"
            assert "100% Principal-Safe" in yield_safety_check["principalPill"], yield_safety_check
            assert_zero_gambling_in_dom(pgP, "preservation_yield_park_card")

            pgP.fill("#yieldAmountInput", "500")
            pgP.locator("#yieldAmountInput").dispatch_event("input")
            pgP.click("#previewYieldBtn")
            pgP.wait_for_function(
                "() => (document.getElementById('yieldParkBody')?.innerText || '').includes('Orca Whirlpool')",
                timeout=8000,
            )
            yield_preview_text = pgP.locator("#yieldParkCard").inner_text()
            assert "7.45%" in yield_preview_text and "$500.00" in yield_preview_text and "Deposited (100%)" in yield_preview_text, yield_preview_text
            pgP.click("#parkYieldBtn")
            pgP.wait_for_function("() => (window.__solSignCallsP || []).length === 2", timeout=8000)
            pgP.wait_for_function(
                "() => (document.getElementById('yieldParkBody')?.innerText || '').includes('Parked')",
                timeout=8000,
            )

            # 7D. 1-Click Stale ERC-20 Approval Revoker: scan + single revoke + batch revoke all
            pgP.click("#scanApprovalsBtn")
            pgP.wait_for_selector("#revokeAllApprovalsBtn", timeout=8000)
            appr_text = pgP.locator("#approvalRevokerCard").inner_text()
            assert "USDC" in appr_text and "UNLIMITED" in appr_text and "Multichain v4" in appr_text, appr_text
            pgP.click("[data-revoke-approval-idx='0']")
            pgP.wait_for_function(
                "() => (window.__evmRpcP || []).some(r => r.method === 'eth_sendTransaction')",
                timeout=8000,
            )
            # Re-scan and trigger 1-Click Revoke All (EIP-5792 batch)
            pgP.click("#scanApprovalsBtn")
            pgP.wait_for_selector("#revokeAllApprovalsBtn", timeout=8000)
            pgP.click("#revokeAllApprovalsBtn")
            pgP.wait_for_function(
                "() => (window.__evmRpcP || []).some(r => r.method === 'wallet_sendCalls')",
                timeout=8000,
            )

            # 7E. Verify Gas-Window Watchdog in Pro -> Agents view
            pgP.click(".ui-mode-btn[data-ui-mode='pro']")
            pgP.click(".app-tab[data-view='agents']")
            pgP.wait_for_selector("#createGasWatchForm", timeout=8000)
            pgP.fill("#gasWatchMaxGweiInput", "12")
            pgP.click("#createGasWatchForm button[type='submit']")
            pgP.wait_for_selector("[data-cancel-gas-watch]", timeout=8000)
            pgP.click("[data-cancel-gas-watch]")
            pgP.wait_for_timeout(200)

            # Return to Sweep for 1-Click Sweep Batch UX + multi-viewport overflow check
            pgP.click(".app-tab[data-view='scanner']")
            pgP.wait_for_timeout(150)

            # 7F. 1-Click Sweep Batch UX: POST /api/tx/prepare-batch -> #oneClickSweepSummaryCard -> Cancel -> Confirm & Sign
            pgP.click("#runLiveQueueBtn")
            pgP.wait_for_selector("#oneClickSweepSummaryCard:not(.hidden)", timeout=10000)
            assert len(prepare_batch_hits_p) == 1, f"Expected 1 POST /api/tx/prepare-batch call, got {len(prepare_batch_hits_p)}"
            summary_text = pgP.locator("#oneClickSweepSummaryCard").inner_text()
            assert (
                "Pre-Sign Sweep Summary" in summary_text
                and "0% ($0.00)" in summary_text
                and ("$1.41k" in summary_text or "$1,412.25" in summary_text)
            ), summary_text
            assert pgP.locator("#confirmOneClickSweepBtn").count() == 1, summary_text

            # Cancel hides summary cleanly
            pgP.click("#cancelOneClickSweepBtn")
            pgP.wait_for_selector("#oneClickSweepSummaryCard", state="hidden", timeout=5000)

            # Re-open 1-Click Sweep summary and confirm execution, waiting for queue completion
            rpc_before_sweep = pgP.evaluate("() => (window.__evmRpcP || []).length")
            pgP.click("#runLiveQueueBtn")
            pgP.wait_for_selector("#confirmOneClickSweepBtn", timeout=10000)
            pgP.click("#confirmOneClickSweepBtn")
            pgP.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=15000)
            pgP.wait_for_function(
                f"() => (window.__evmRpcP || []).length > {rpc_before_sweep} && !document.getElementById('runLiveQueueBtn')?.disabled",
                timeout=20000,
            )

            # 7G. Verify 0px horizontal overflow & zero gambling DOM across Desktop (1440px), Tablet (900px), Mobile (390px)
            # on BOTH Sweep (with Preservation Tools populated) and AI views
            overflowP = {}
            for label, vp in [("1440", {"width": 1440, "height": 900}), ("900", {"width": 900, "height": 800}), ("390", {"width": 390, "height": 844})]:
                pgP.set_viewport_size(vp)
                pgP.click(".app-tab[data-view='scanner']")
                pgP.wait_for_timeout(180)
                overflowP[f"scanner_{label}"] = pgP.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert_zero_gambling_in_dom(pgP, f"preservation_scanner_{label}")
                pgP.click(".app-tab[data-view='ai']")
                pgP.wait_for_timeout(180)
                overflowP[f"ai_{label}"] = pgP.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert_zero_gambling_in_dom(pgP, f"preservation_ai_{label}")

            # 7H. Wave 8C Hardening: verify Lite mode resets burnToggle/executionMode and wallet disconnect isolates state
            pgP.set_viewport_size({"width": 1440, "height": 900})
            pgP.click(".app-tab[data-view='scanner']")
            pgP.wait_for_timeout(120)
            pgP.click(".ui-mode-btn[data-ui-mode='pro']")
            pgP.click(".mode-opt[data-exec-mode='gasless']")
            pgP.evaluate("() => { const b = document.getElementById('burnToggle'); if (b) { b.checked = true; b.dispatchEvent(new Event('change')); } }")
            pgP.click(".ui-mode-btn[data-ui-mode='lite']")
            pgP.wait_for_timeout(150)
            lite_reset = pgP.evaluate("""() => ({
              burnChecked: Boolean(document.getElementById('burnToggle')?.checked),
              directActive: Boolean(document.querySelector('.mode-opt[data-exec-mode="direct"]')?.classList.contains('active')),
            })""")
            assert lite_reset["burnChecked"] is False and lite_reset["directActive"] is True, lite_reset

            # Disconnect EVM wallet -> clears scan, preservation strip, and approval revoker state cleanly
            pgP.click("#connectEvmBtn")
            pgP.wait_for_selector("#walletModalDisconnectBtn", timeout=5000)
            pgP.click("#walletModalDisconnectBtn")
            pgP.click("#walletModalCloseBtn")
            pgP.wait_for_timeout(150)
            post_disconnect = pgP.evaluate("""() => ({
              stripHidden: Boolean(document.getElementById('preservationStripHost')?.classList.contains('hidden')),
              approvalScanNull: window.__turgaliumPreservationTools?.getState?.().approvalScan === null,
            })""")
            assert post_disconnect["stripHidden"] and post_disconnect["approvalScanNull"], post_disconnect

            xss_p = pgP.evaluate("() => Boolean(window.__xssP)")
            assert not xss_p, "XSS payload executed in Preservation Tools!"
            assert all(v <= 0 for v in overflowP.values()), f"Preservation/AI overflow: {overflowP}"
            assert not errsP, f"Preservation/One-Click Sweep errors: {errsP}"
            assert not badHttpP, f"Preservation/One-Click Sweep bad HTTP: {badHttpP}"
            results["preservation_tools_and_one_click_sweep"] = {
                "ok": True,
                "tieredFeeAndRouteWinnerVerified": True,
                "workspaceHydrateUsed": len(hydrate_hits_p) >= 1,
                "solanaOverviewUsed": len(sol_overview_hits_p) >= 1,
                "prepareBatchUsed": len(prepare_batch_hits_p) >= 2,
                "rentReclaimSigned": True,
                "yieldParkPrincipalSafe100Pct": True,
                "approvalsSingleAndBatchRevoked": True,
                "gasWatchdogCreatedAndCancelled": True,
                "oneClickSweepSummaryAndConfirmVerified": True,
                "zeroGamblingElementsVerified": True,
                "liteResetAndDisconnectIsolationVerified": True,
                "xssBlocked": True,
                "overflowPx": overflowP,
            }
            ctxP.close()

            # ------------------------------------------------------------------
            # 8. WAVE 9 UI/UX, ZERO-401 ADMIN LOCK, UNIFIED TIERED FEE,
            #    ECOSYSTEM STATE ISOLATION, 390px OVERFLOW, RENT PRIORITY,
            #    BLOCKED LP NFT, 19 EVMs, & PRE-SIGN SECURITY REGRESSIONS
            # ------------------------------------------------------------------
            ctxW9 = browser.new_context(viewport={"width": 1440, "height": 900})
            pgW9 = ctxW9.new_page()
            errsW9 = []
            http401W9 = []
            badHttpW9 = []
            rent_scan_owners = []

            pgW9.on("pageerror", lambda e: errsW9.append(f"pageerror: {e}"))
            pgW9.on("console", lambda m: errsW9.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

            def on_w9_response(r):
                if r.status == 401:
                    http401W9.append(f"{r.status} {r.request.method} {r.url}")
                elif r.status >= 400 and "/api/solana/balance" not in r.url:
                    badHttpW9.append(f"{r.status} {r.request.method} {r.url}")

            pgW9.on("response", on_w9_response)

            pgW9.add_init_script("""
              window.__copiedW9 = [];
              try {
                Object.defineProperty(navigator, 'clipboard', {
                  configurable: true,
                  value: {
                    writeText: async (txt) => { window.__copiedW9.push(String(txt)); },
                  },
                });
              } catch {}
            """)

            # 8A. Simulate public Vercel deployment with adminSessionRequired=true
            def route_w9_config(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "coinbaseSmartWalletEnabled": True,
                        "walletConnectProjectId": None,
                        "l2IndexerProvider": "rpc_multicall",
                        "protocolFee": {
                            "feeBps": 700,
                            "feePercent": 7,
                            "minFeeBps": 500,
                            "maxFeeBps": 1000,
                            "feeRecipientEvm": "0x1111111111111111111111111111111111111111",
                            "feeRecipientSol": None,
                            "feeDestinationType": "contract",
                            "treasuryConfigured": True,
                        },
                        "gaslessRelayerConfigured": False,
                        "requirePluginAuth": True,
                        "adminSessionRequired": True,
                    }),
                )

            def route_w9_admin_401(route):
                route.fulfill(
                    status=401,
                    content_type="application/json",
                    body=json.dumps({"error": "Missing or invalid X-Turgalium-Admin-Session header."}),
                )

            def build_w9_scan(body=None):
                body = body or {}
                scan_copy = json.loads(json.dumps(veteran_fixture))
                scan_copy["walletAddress"] = body.get("address", VITALIK)
                scan_copy["family"] = "evm"
                # Add high-value asset ($80k), 36-digit huge balance token, blocked $0 LP NFT, and 1-item chain leg
                scan_copy["assets"].extend([
                    {
                        "id": "eth-whale-usdc",
                        "chain": "ethereum",
                        "chainId": 1,
                        "chainName": "Ethereum",
                        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                        "symbol": "USDC",
                        "name": "USD Coin",
                        "decimals": 6,
                        "rawBalance": "80000000000",
                        "uiBalance": 80000,
                        "priceUsd": 1.0,
                        "grossUsd": 80000,
                        "kind": "erc20",
                        "action": "BRIDGE_DIRECT_USDC",
                        "actionReason": "Direct USDC bridge",
                        "selectedByDefault": True,
                        "estimatedGasUsd": 0.45,
                        "batchedGasUsd": 0.25,
                        "estimatedSlippageUsd": 0,
                        "roiVerdict": "worth_it",
                        "netRoiUsd": 79949.75,
                    },
                    {
                        "id": "zksync-huge-amd",
                        "chain": "zksync",
                        "chainId": 324,
                        "chainName": "zkSync Era",
                        "address": "0x3333333333333333333333333333333333333333",
                        "symbol": "AMD",
                        "name": "Huge Supply Spam Token",
                        "decimals": 18,
                        "rawBalance": "880088008800880100000000000000000000000000000000000000",
                        "uiBalance": 8.800880088008801e35,
                        "priceUsd": 0,
                        "grossUsd": 0,
                        "kind": "dead_token",
                        "action": "BURN_ZERO_LIQUIDITY",
                        "actionReason": "Zero liquidity",
                        "selectedByDefault": False,
                        "estimatedGasUsd": 0.05,
                        "batchedGasUsd": 0.02,
                        "estimatedSlippageUsd": 0,
                    },
                    {
                        "id": "eth-uni-v3-zero-lp",
                        "chain": "ethereum",
                        "chainId": 1,
                        "chainName": "Ethereum",
                        "address": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
                        "symbol": "UNI-V3-#112161",
                        "name": "Uniswap V3 Position #112161",
                        "protocol": "Uniswap V3",
                        "decimals": 0,
                        "rawBalance": "137378032570732",
                        "uiBalance": 137378032570732,
                        "priceUsd": 0,
                        "grossUsd": 0,
                        "kind": "defi_position",
                        "action": "BURN_ZERO_LIQUIDITY",
                        "actionReason": "Zero verified DEX liquidity ($0.00). Opt-in burn to 0x...dEaD",
                        "selectedByDefault": False,
                        "estimatedGasUsd": 1.2,
                        "batchedGasUsd": 0.8,
                        "estimatedSlippageUsd": 0,
                        "roiVerdict": "negative_roi",
                        "netRoiUsd": -1.2,
                    },
                    {
                        "id": "unichain-single-eth",
                        "chain": "unichain",
                        "chainId": 130,
                        "chainName": "Unichain",
                        "address": "native",
                        "symbol": "ETH",
                        "name": "Ether",
                        "decimals": 18,
                        "rawBalance": "100000000000000000",
                        "uiBalance": 0.1,
                        "priceUsd": 2500,
                        "grossUsd": 250,
                        "kind": "native",
                        "action": "SELL_AND_BRIDGE",
                        "actionReason": "Liquid ETH",
                        "selectedByDefault": True,
                        "estimatedGasUsd": 0.02,
                        "batchedGasUsd": 0.01,
                        "estimatedSlippageUsd": 0.25,
                        "roiVerdict": "worth_it",
                        "netRoiUsd": 249.0,
                    },
                    {
                        "id": "eth-pos-net-neg-roi",
                        "chain": "ethereum",
                        "chainId": 1,
                        "chainName": "Ethereum",
                        "address": "0x4444444444444444444444444444444444444444",
                        "symbol": "BONDED",
                        "name": "Bonded Pool",
                        "decimals": 6,
                        "rawBalance": "6855593690000",
                        "uiBalance": 6855593.69,
                        "priceUsd": 1.0,
                        "grossUsd": 6855593.69,
                        "kind": "erc20",
                        "action": "SKIP_GAS_NEGATIVE",
                        "actionReason": "Unroutable bonded pool",
                        "selectedByDefault": False,
                        "estimatedGasUsd": 0.5,
                        "batchedGasUsd": 0.5,
                        "estimatedSlippageUsd": 0,
                        "roiVerdict": "negative_roi",
                        "netRoiUsd": 6855593.69,
                    },
                ])
                if not any(c.get("chain") == "unichain" for c in scan_copy["chains"]):
                    scan_copy["chains"].append({"chain": "unichain", "chainName": "Unichain", "assetCount": 1, "totalUsd": 250})
                if not any(c.get("chain") == "zksync" for c in scan_copy["chains"]):
                    scan_copy["chains"].append({"chain": "zksync", "chainName": "zkSync Era", "assetCount": 1, "totalUsd": 0})
                return scan_copy

            def route_w9_scan(route):
                body = route.request.post_data_json or {}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(build_w9_scan(body)))

            route_w9_hydrate = make_hydrate_route(build_w9_scan)

            def route_w9_rent_scan(route):
                body = route.request.post_data_json or {}
                rent_scan_owners.append(body.get("ownerAddress"))
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "ownerAddress": body.get("ownerAddress", ""),
                        "totalTokenAccountsScanned": 2,
                        "reclaimableCount": 0,
                        "reclaimableSol": 0,
                        "reclaimableUsd": 0,
                        "rentPerEmptyAccountSol": 0.00203928,
                        "reclaimableAccounts": [],
                    }),
                )

            pgW9.route("**/api/config", route_w9_config)
            pgW9.route("**/api/jobs*", route_w9_admin_401)
            pgW9.route("**/api/agents/mandates*", route_w9_admin_401)
            pgW9.route("**/api/agents/approvals*", route_w9_admin_401)
            pgW9.route("**/api/agents/gas-watch*", route_w9_admin_401)
            pgW9.route("**/api/plugin/setup*", route_w9_admin_401)
            pgW9.route("**/api/plugin/tokens*", route_w9_admin_401)
            pgW9.route("**/api/workspace/hydrate", route_w9_hydrate)
            pgW9.route("**/api/scan", route_w9_scan)
            pgW9.route("**/api/solana/overview", route_sol_overview)
            pgW9.route("**/api/solana/balance*", route_sol_balance)
            pgW9.route("**/api/solana/rent-scan", route_w9_rent_scan)

            pgW9.goto(BASE, wait_until="networkidle")
            pgW9.wait_for_timeout(400)
            assert not http401W9, f"Expected ZERO 401s on unauthenticated boot, got: {http401W9}"

            # Open Migrator -> scan via input -> verify Lite mode purity & unified tiered fee
            pgW9.click("#navLaunchBtn")
            pgW9.wait_for_selector("#appShell:not(.hidden)", timeout=10000)
            pgW9.fill("#appEvmInput", VITALIK)
            pgW9.click("#appScanBtn")
            pgW9.wait_for_selector("#preservationStripCard", timeout=15000)
            pgW9.wait_for_timeout(200)

            w9_lite = pgW9.evaluate("""() => {
              const isVis = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const st = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return st.display !== 'none' && r.width > 0 && r.height > 0;
              };
              return {
                liteCost: document.getElementById('summaryLiteCostText')?.textContent?.trim() || '',
                applyBtnVisible: isVis('#applyOptimalRouteBtn'),
                clarityRowVisible: isVis('.preservation-clarity-row'),
                evmBadgeCount: document.querySelector("#familyBar [data-family='evm'] .family-count")?.textContent?.trim() || '',
                approvalOptCount: document.querySelectorAll('#approvalChainSelect option').length,
                gasWatchOptCount: document.querySelectorAll('#gasWatchChainSelect option').length,
                hasHyperEvm: Boolean(document.querySelector("#approvalChainSelect option[value='hyperevm']")),
                hasGnosis: Boolean(document.querySelector("#gasWatchChainSelect option[value='gnosis']")),
              };
            }""")
            # Zero protocol fee (open source): Lite shows only small network gas (<$15), NEVER 7% flat or $50!
            lite_fee_num = float(w9_lite["liteCost"].replace("~", "").replace("$", "").replace(",", ""))
            assert 0.0 <= lite_fee_num <= 25.0, f"Lite Est. network gas should reflect 0% protocol fee, got {w9_lite}"
            assert not w9_lite["applyBtnVisible"] and not w9_lite["clarityRowVisible"], f"Pro-only controls leaked in Lite Preservation Strip: {w9_lite}"
            assert w9_lite["evmBadgeCount"] == "19", f"Expected dynamic 19 EVM badge, got {w9_lite}"
            assert w9_lite["approvalOptCount"] == 19 and w9_lite["gasWatchOptCount"] == 19, w9_lite
            assert w9_lite["hasHyperEvm"] and w9_lite["hasGnosis"], w9_lite

            # 8B. Verify blocked $0.00 Uniswap V3 LP NFT has single coherent blocked badge & compact liquidity
            lp_check = pgW9.evaluate("""() => {
              const row = document.querySelector("[data-defi-asset-id='eth-uni-v3-zero-lp']");
              if (!row) return null;
              return {
                text: row.innerText,
                badgeCount: row.querySelectorAll('.defi-pos-badges > span').length,
                hasBlockedBadge: Boolean(row.querySelector('.defi-badge-blocked')),
                hasOneClick: row.innerText.includes('1-Click Extract'),
                hasOptInBurn: row.innerText.toLowerCase().includes('opt-in burn'),
                hasCompactLiq: row.innerText.includes('137.38T'),
              };
            }""")
            assert lp_check and lp_check["hasBlockedBadge"] and lp_check["badgeCount"] == 1, lp_check
            assert not lp_check["hasOneClick"] and not lp_check["hasOptInBurn"], lp_check
            assert lp_check["hasCompactLiq"], lp_check

            # 8C. Verify Rent Vacuum #rentOwnerInput priority over #solanaDestInput
            pgW9.click("#toggleDestEditBtn")
            pgW9.fill("#solanaDestInput", SOL_PUBKEY)
            pgW9.locator("#solanaDestInput").dispatch_event("input")
            pgW9.fill("#rentOwnerInput", SOL_PUBKEY_ALT)
            pgW9.locator("#rentOwnerInput").dispatch_event("input")
            pgW9.click("#scanSolanaRentBtn")
            pgW9.wait_for_function("() => (document.getElementById('rentVacuumBody')?.innerText || '').includes('Clean wallet')", timeout=8000)
            assert rent_scan_owners[-1] == SOL_PUBKEY_ALT, f"Rent Vacuum ignored #rentOwnerInput! Sent {rent_scan_owners}"

            # 8D. Switch to Pro -> verify Tiered Protocol Fee, flat override, 1 item singular, comma formatting, Agents tab ZERO 401s
            pgW9.click(".ui-mode-btn[data-ui-mode='pro']")
            pgW9.wait_for_function("() => document.documentElement.dataset.uiMode === 'pro'", timeout=5000)
            pro_fee_check = pgW9.evaluate("""() => ({
              feeText: document.getElementById('summaryFeeText')?.textContent?.trim() || '',
              queueText: document.getElementById('chainQueueList')?.innerText || '',
              bondedRowText: document.querySelector("[data-row-asset='eth-pos-net-neg-roi']")?.innerText || '',
              applyBtnVis: getComputedStyle(document.getElementById('applyOptimalRouteBtn')).display !== 'none',
            })""")
            assert "0%" in pro_fee_check["feeText"] and "Free" in pro_fee_check["feeText"], pro_fee_check
            assert "1 item" in pro_fee_check["queueText"] and "1 items" not in pro_fee_check["queueText"], pro_fee_check
            assert "6,855,593.69" in pro_fee_check["bondedRowText"] and "Negative ROI ($6855593" not in pro_fee_check["bondedRowText"], pro_fee_check
            assert pro_fee_check["applyBtnVis"], pro_fee_check

            # Switch to Agents & AI tab while adminSessionRequired=true -> ZERO 401s, clean locked UI, working Copy JSON
            pgW9.click(".app-tab[data-view='agents']")
            pgW9.wait_for_timeout(250)
            agents_locked = pgW9.evaluate("""() => ({
              bannerVisible: !document.getElementById('agentsAdminLockedBanner')?.classList.contains('hidden'),
              claudeText: document.getElementById('claudeMcpConfigHost')?.textContent || '',
              cliText: document.getElementById('claudeCodeCmdHost')?.textContent || '',
              gptText: document.getElementById('chatgptPluginHost')?.textContent || '',
              mandatesText: document.getElementById('agentMandatesHost')?.innerText || '',
              tokensText: document.getElementById('pluginTokensHost')?.innerText || '',
              gasWatchText: document.getElementById('gasWatchListHost')?.innerText || '',
            })""")
            assert agents_locked["bannerVisible"], agents_locked
            assert "Loading…" not in agents_locked["claudeText"] and "mcpServers" in agents_locked["claudeText"], agents_locked
            assert "Loading…" not in agents_locked["cliText"] and "claude mcp add" in agents_locked["cliText"], agents_locked
            assert "Loading…" not in agents_locked["gptText"] and "openapi.json" in agents_locked["gptText"], agents_locked
            assert len(agents_locked["mandatesText"].strip()) > 10 and len(agents_locked["tokensText"].strip()) > 10, agents_locked
            assert "Admin session required" in agents_locked["gasWatchText"], agents_locked

            pgW9.click("#copyClaudeMcpBtn")
            pgW9.click("#issueMcpTokenBtn")
            pgW9.click("#createGasWatchForm button[type='submit']")
            pgW9.wait_for_timeout(200)
            copied_w9 = pgW9.evaluate("() => window.__copiedW9")
            assert len(copied_w9) >= 1 and "mcpServers" in copied_w9[0], copied_w9
            assert not http401W9, f"Expected ZERO 401s in Agents & AI locked mode, got: {http401W9}"

            # 8E. Mobile 390px huge-balance overflow check & Pro tab bar reachability
            pgW9.click(".app-tab[data-view='scanner']")
            pgW9.set_viewport_size({"width": 390, "height": 844})
            pgW9.wait_for_timeout(200)
            mobile_w9 = pgW9.evaluate("""() => {
              const row = document.querySelector("[data-row-asset='zksync-huge-amd']");
              const valCol = row?.querySelector('.asset-row-val-col');
              const balEl = row?.querySelector('.asset-row-bal');
              const rect = valCol?.getBoundingClientRect();
              return {
                docOverflow: document.documentElement.scrollWidth - window.innerWidth,
                balText: balEl?.textContent?.trim() || '',
                balTitle: balEl?.getAttribute('title') || '',
                valColRight: rect ? Math.ceil(rect.right) : -1,
                tabCount: document.querySelectorAll('.app-tab').length,
              };
            }""")
            assert mobile_w9["docOverflow"] <= 0, f"Mobile 390px overflow with 36-digit balance: {mobile_w9}"
            assert mobile_w9["valColRight"] <= 390 and len(mobile_w9["balText"]) <= 20, mobile_w9
            assert "880,088,008" in mobile_w9["balTitle"], mobile_w9

            # 8F. Ecosystem switch (EVM -> Cosmos) clears Preservation Strip AND Lite Est. Fees
            pgW9.click(".ui-mode-btn[data-ui-mode='lite']")
            pgW9.wait_for_timeout(120)
            pgW9.click("#familyBar [data-family='cosmos']")
            pgW9.wait_for_timeout(200)
            iso_check = pgW9.evaluate("""() => ({
              stripHidden: Boolean(document.getElementById('preservationStripHost')?.classList.contains('hidden')),
              liteCost: document.getElementById('summaryLiteCostText')?.textContent?.trim() || '',
              feeText: document.getElementById('summaryFeeText')?.textContent?.trim() || '',
            })""")
            assert iso_check["stripHidden"], f"Stale Preservation Strip leaked on Cosmos switch: {iso_check}"
            assert iso_check["liteCost"] == "$0.00", f"Stale Lite Est. Fees leaked on Cosmos switch: {iso_check}"

            # 8G. Verify client-side address family auto-detection (no manual family pill click needed)
            auto_detect_check = pgW9.evaluate("""() => {
              const fn = window.__turgaliumDetectAddressFamily;
              if (typeof fn !== 'function') return null;
              const appIn = document.getElementById('appEvmInput');
              if (appIn) {
                appIn.value = 'vitalik.eth';
                appIn.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const evmPillAfterEns = document.querySelector("#familyBar [data-family='evm']")?.classList.contains('active');
              if (appIn) {
                appIn.value = 'celestia1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3y3clr6';
                appIn.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const cosmosPillAfterCelestia = document.querySelector("#familyBar [data-family='cosmos']")?.classList.contains('active');
              return {
                ens: fn('vitalik.eth'),
                evm: fn('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
                cosmos: fn('celestia1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3y3clr6'),
                sui: fn('0x' + 'a'.repeat(64)),
                ton: fn('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
                tron: fn('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'),
                btc: fn('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
                evmPillAfterEns,
                cosmosPillAfterCelestia,
              };
            }""")
            assert auto_detect_check == {
                "ens": "evm",
                "evm": "evm",
                "cosmos": "cosmos",
                "sui": "sui",
                "ton": "ton",
                "tron": "tron",
                "btc": "btc",
                "evmPillAfterEns": True,
                "cosmosPillAfterCelestia": True,
            }, f"Auto-detect family check failed: {auto_detect_check}"

            assert not errsW9, f"Wave 9 errors: {errsW9}"
            assert not badHttpW9, f"Wave 9 bad HTTP: {badHttpW9}"
            assert not http401W9, f"Wave 9 unexpected 401s: {http401W9}"
            results["wave9_ui_ux_and_zero_401"] = {
                "ok": True,
                "zero401OnBootAndAgents": True,
                "unifiedTieredFeeVerified": True,
                "ecosystemSwitchIsolated": True,
                "mobile390HugeBalanceZeroOverflow": True,
                "rentOwnerInputPriorityVerified": True,
                "blockedLpNftCoherent": True,
                "dynamic19EvmChainsSynced": True,
                "litePreservationStripPure": True,
                "autoDetectFamilyVerified": True,
            }
            ctxW9.close()

            browser.close()

        print(json.dumps(results, indent=2))
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=3)
        except Exception:
            srv.kill()
        srv_log.close()


if __name__ == "__main__":
    main()
