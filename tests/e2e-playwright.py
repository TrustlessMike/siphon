#!/usr/bin/env python3
"""
Deterministic end-to-end headless Chromium regression & safety backtest suite for Siphon.
Verifies Desktop (1440x900), Tablet (900x800), and Mobile (390x844) across all 5 views:
  1. Zero-default Solana destination guard & disconnect clearing (C-2)
  2. Stored DOM XSS & injection immunity on leg.assetCount, symbols, protocols (C-1)
  3. Execution safety: atomicRequired:true for fee batches, sequential receipt failure abort,
     ton_rawSign removal, ensureEvmChain eth_chainId verification, and client pre-sign assertions (C-3, C-4, H-3)
  4. DeFi quick-unwind panel, guided 2-stage auto-bridge, Dust Converter CTA sync,
     mobile 390px visible Honeypot/ROI safety badges, connected 390px/900px 0px overflow,
     constrained mobile toast rect, non-EVM modal footer copy, and siphon-3d.js rAF pause when hidden.
"""
import json
import os
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get("SIPHON_E2E_PORT", "4439"))
BASE = f"http://127.0.0.1:{PORT}"
SHOT_DIR = os.environ.get("SIPHON_E2E_SCREENSHOT_DIR", "")
VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
VET_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
SOL_PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
SOL_PUBKEY_ALT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"


def wait_ready():
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Siphon server failed to start on {BASE}")


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


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    srv = subprocess.Popen(
        ["node", "dist/src/server/index.js"],
        cwd=repo_root,
        env={
            **os.environ,
            "PORT": str(PORT),
            "SIPHON_ROUTER_OPTIMISM": "0x2222222222222222222222222222222222222222",
            "SIPHON_FEE_RECIPIENT_EVM": "0x1111111111111111111111111111111111111111",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        wait_ready()
        veteran_fixture = fetch_veteran_scan()
        results = {}

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

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

            # Deterministic scan + proof routes so Desktop E2E never flakes on public RPC latency
            def route_scan_deterministic(route):
                body = route.request.post_data_json or {}
                if body.get("family") and body.get("family") != "evm":
                    route.continue_()
                    return
                scan_copy = json.loads(json.dumps(veteran_fixture))
                if body.get("address"):
                    scan_copy["walletAddress"] = body["address"]
                else:
                    scan_copy["walletAddress"] = VITALIK
                    scan_copy["walletLabel"] = "vitalik.eth"
                route.fulfill(status=200, content_type="application/json", body=json.dumps(scan_copy))

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

            pgD.route("**/api/scan", route_scan_deterministic)
            pgD.route("**/api/tx/simulate-proof", route_proof_deterministic)
            pgD.route("**/api/solana/balance*", route_sol_balance)
            pgD.route("**/api/tx/prepare-chain-batch", route_prepare_base_eip5792)

            pgD.goto(BASE, wait_until="networkidle")
            pgD.wait_for_timeout(450)

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
              const sdk = mod.createCoinbaseWalletSDK({ appName: 'Siphon', appChainIds: [1, 8453] });
              const prov = sdk.getProvider();
              const canvas = document.getElementById('siphonHeroCanvas');
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

            # 1D. Verify siphon-3d.js pauses rAF completely while #siteShell is hidden!
            pgD.wait_for_timeout(120)
            raf_before = pgD.evaluate("() => window.__rafCount")
            pgD.wait_for_timeout(320)
            raf_after = pgD.evaluate("() => window.__rafCount")
            scene_running = pgD.evaluate("() => Boolean(window.__siphonHeroScene?.isRunning?.())")
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
            maybe_shot(pgD, "goal_desktop_lite_1440.png", full_page=True)

            # Switch to Pro mode and verify all Pro controls + EIP / program data appear
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
              return {
                mode: document.documentElement.dataset.uiMode,
                stored: localStorage.getItem('siphon_ui_mode'),
                liteCostVisible: isVis('#summaryLiteCostText'),
                bridgeRouteVisible: isVis('#bridgePrefSelect'),
                feeDrawerBtnVisible: isVis('#toggleFeeDrawerBtn'),
                modeSwitchVisible: isVis('.mode-switch-bar'),
                verifyProofVisible: isVis('#verifyProofBtn'),
                chainQueueVisible: isVis('#chainQueueList'),
                agentsTabVisible: isVis(".app-tab[data-view='agents']"),
                contractTabVisible: isVis(".app-tab[data-view='contract']"),
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
            pgD.route(
                "**/api/relayer/submit",
                lambda route: route.fulfill(
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
                ),
            )
            pgD.click("[data-exec-chain-batch='optimism']")
            pgD.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=10000)
            pgD.wait_for_function("() => (window.__rpcD || []).some(r => r.method === 'eth_signTypedData_v4')", timeout=10000)
            pgD.unroute("**/api/relayer/submit")

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

            # 1H. Check all 5 views + Agents Mandate CRUD + HTTP 500 revoke handling (0 uncaught pageerror!)
            for view in ["scanner", "activity", "agents", "contract"]:
                pgD.click(f".app-tab[data-view='{view}']")
                pgD.wait_for_timeout(200)
                overflowD[view] = pgD.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                if view == "agents":
                    pgD.wait_for_function("() => (document.querySelector('#claudeMcpConfigHost')?.innerText || '').includes('siphon')", timeout=5000)
                    # Queue a real permission request via POST /api/agents/approvals (replaces removed demo button)
                    queued_ok = pgD.evaluate("""async () => {
                      const dest = document.getElementById('solanaDestInput')?.value?.trim();
                      const res = await fetch('/api/agents/approvals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Siphon-Requested-With': 'siphon-ui' },
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
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract SiphonRouter')", timeout=5000)

            # Switching back to Lite from Contracts view must gracefully return to Sweep view
            pgD.click(".ui-mode-btn[data-ui-mode='lite']")
            pgD.wait_for_function("() => document.documentElement.dataset.uiMode === 'lite' && document.getElementById('view-scanner')?.classList.contains('active')", timeout=5000)

            assert all(v <= 0 for v in overflowD.values()), f"Desktop overflow: {overflowD}"
            assert not errsD, f"Desktop errors: {errsD} | badHttpD={badHttpD}"
            assert not badHttpD, f"Desktop bad HTTP: {badHttpD}"
            results["desktop_1440"] = {
                "ok": True,
                "liteAndProVerified": True,
                "zeroDefaultDestVerified": True,
                "rafPausedWhenHidden": True,
                "atomicRequiredForFeeBatch": True,
                "cosmosModalFooterFixed": True,
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

            def route_safety_scan(route):
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
                route.fulfill(status=200, content_type="application/json", body=json.dumps(dust_scan))

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
            pgS_null.route("**/api/scan", lambda r: r.abort())  # keep currentScan null
            pgS_null.goto(BASE, wait_until="domcontentloaded")
            pgS_null.wait_for_selector("#navLaunchBtn", timeout=5000)
            pgS_null.click("#navLaunchBtn")
            pgS_null.click("#selectProfitableBtn")
            pgS_null.wait_for_timeout(150)
            assert not errsS_null, f"#selectProfitableBtn before scan threw: {errsS_null}"
            pgS_null.close()

            pgS.route("**/api/scan", route_safety_scan)
            pgS.route("**/api/jobs", route_xss_jobs)
            pgS.route("**/api/dust/plan", route_dust_plan_mock)
            pgS.route("**/api/tx/prepare-chain-batch", route_prepare_3step_seq)
            pgS.route("**/api/tx/status", route_status_reverted)
            pgS.route("**/api/solana/balance*", route_sol_balance)

            pgS.goto(BASE, wait_until="networkidle")
            pgS.wait_for_timeout(350)

            # 2A. Stored XSS Backtest: leg.assetCount coerced to 0 assets & 0 script execution!
            xss_check = pgS.evaluate("""() => ({
              xssFired: Boolean(window.__xssFired),
              tableText: document.getElementById('liveExecLogBody')?.innerText || '',
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
              const w = await import('/wallets.js?v=7');
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

            def route_vet(route):
                scan_copy = json.loads(json.dumps(veteran_fixture))
                scan_copy["walletAddress"] = VET_ADDR
                route.fulfill(status=200, content_type="application/json", body=json.dumps(scan_copy))

            def route_tx_status_ok(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"evmConfirmed": True, "evmFailed": False, "bridgeStatus": "confirmed"}),
                )

            pgL.route("**/api/scan", route_vet)
            pgL.route("**/api/tx/status", route_tx_status_ok)
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

            def route_defi_plan_scan(route):
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
                route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

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

            pgX.route("**/api/scan", route_defi_plan_scan)
            pgX.route("**/api/tx/prepare-chain-batch", route_prepare_two_stage)
            pgX.route("**/api/tx/status", route_tx_status_ok)
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
            assert pgX.locator("[data-stepper-step='withdraw'].is-done").count() == 1
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
            pgT.route("**/api/scan", route_scan_deterministic)
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
            pgT.click(".ui-mode-btn[data-ui-mode='pro']")
            pgT.wait_for_timeout(120)
            for view in ["scanner", "activity", "agents", "contract"]:
                pgT.click(f".app-tab[data-view='{view}']")
                pgT.wait_for_timeout(150)
                overflowT[view] = pgT.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
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
            pgM.route("**/api/scan", route_scan_deterministic)
            pgM.route("**/api/solana/balance*", route_sol_balance)
            pgM.goto(BASE, wait_until="networkidle")
            pgM.wait_for_timeout(350)

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

            # Verify Lite mode 0px overflow on mobile before switching to Pro for full-view checks
            overflowM["scanner_lite"] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            maybe_shot(pgM, "goal_mobile_lite_390.png", full_page=True)

            pgM.click(".ui-mode-btn[data-ui-mode='pro']")
            pgM.wait_for_timeout(150)
            pgM.locator(".defi-tech-details > summary").first.click()
            pgM.wait_for_timeout(150)
            overflowM["scanner_defi"] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")

            for view in ["scanner", "activity", "agents", "contract"]:
                pgM.click(f".app-tab[data-view='{view}']")
                pgM.wait_for_timeout(200)
                overflowM[view] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                if view == "activity":
                    svg_w = pgM.evaluate("() => document.getElementById('siphonFlowSvg')?.getBoundingClientRect()?.width || 0")
                    assert svg_w >= 700, f"Expected horizontally scrollable readable SVG (>=700px) on mobile, got {svg_w}px"
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

            def route_export_scan(route):
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
                route.fulfill(status=200, content_type="application/json", body=json.dumps(scan_copy))

            pgE.route("**/api/scan", route_export_scan)
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
            assert download.suggested_filename.startswith("siphon-burn-receipt-") and download.suggested_filename.endswith(".csv"), download.suggested_filename
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
            # 7. PRESERVATION TOOLS (RENT VACUUM, YIELD PARK, APPROVAL REVOKER),
            #    TIERED FEE & ROUTE AUCTION CLARITY, GAS WATCHDOG, & DEGEN TAB
            #    ACROSS DESKTOP (1440px), TABLET (900px), AND MOBILE (390px)
            # ------------------------------------------------------------------
            ctxP = browser.new_context(viewport={"width": 1440, "height": 900})
            pgP = ctxP.new_page()
            errsP = []
            badHttpP = []
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

            pgP.route("**/api/scan", route_scan_deterministic)
            pgP.route("**/api/solana/balance*", route_sol_balance)

            # Valid base64 dummy bytes (>=16 bytes) for Solana VersionedTransaction signing mock
            dummy_sol_tx_b64 = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED"

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
                            "serializedTransactionBase64": dummy_sol_tx_b64,
                            "serializedMessageBase64": dummy_sol_tx_b64,
                        },
                        "txBuildWarning": None,
                    }),
                )

            def route_yield_park_mock(route):
                body = route.request.post_data_json or {}
                total = float(body.get("totalUsdcAmount", 100))
                pct = float(body.get("preservePct", 90))
                yield_usdc = round(total * pct / 100.0, 2)
                degen_usdc = round(total - yield_usdc, 2)
                build_tx = bool(body.get("buildTransaction", False))
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "planVersion": "siphon-solana-yield-park-v1",
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
                            "preservePct": pct,
                            "degenPct": round(100.0 - pct, 2),
                            "yieldUsdc": yield_usdc,
                            "degenSidePocketUsdc": degen_usdc,
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
                            "yieldFundedDegenMonthlyBudgetUsd": round(yield_usdc * 0.0745 / 12.0, 2),
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
                                "swapTransactionBase64": dummy_sol_tx_b64,
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

            def route_degen_markets_mock(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "ok": True,
                        "live": True,
                        "cached": False,
                        "fetchedAt": "2026-11-25T20:00:00.000Z",
                        "apiKeyConfigured": True,
                        "geoBlocked": False,
                        "events": [
                            {
                                "eventId": "evt-sol-e2e-1",
                                "title": "Will SOL close above $250 this month?",
                                "slug": "sol-above-250",
                                "category": "crypto",
                                "isLive": True,
                                "volumeUsd": 1425000,
                                "volume24hrUsd": 325000,
                                "closeTime": "2026-12-31T00:00:00.000Z",
                                "jupiterUrl": "https://jup.ag/prediction/sol-above-250",
                                "markets": [
                                    {
                                        "marketId": "mkt-sol-250-yes",
                                        "title": "SOL > $250",
                                        "yes": {
                                            "priceUsd": 0.42,
                                            "cents": 42.0,
                                            "impliedProbPct": 42.0,
                                            "payoutMultiplier": 2.38,
                                        },
                                        "no": {
                                            "priceUsd": 0.58,
                                            "cents": 58.0,
                                            "impliedProbPct": 58.0,
                                            "payoutMultiplier": 1.72,
                                        },
                                    }
                                ],
                            }
                        ],
                        "gameModes": [],
                    }),
                )

            def route_degen_positions_mock(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "ok": True,
                        "owner": SOL_PUBKEY,
                        "positions": [],
                        "summary": {
                            "openCount": 0,
                            "claimableCount": 0,
                            "totalClaimablePayoutUsd": 0,
                            "totalUnrealizedPnlUsd": 0,
                        },
                    }),
                )

            pgP.route("**/api/solana/rent-scan", route_rent_scan_mock)
            pgP.route("**/api/solana/yield-park", route_yield_park_mock)
            pgP.route("**/api/approvals/scan", route_approvals_scan_mock)
            pgP.route("**/api/degen/markets*", route_degen_markets_mock)
            pgP.route("**/api/degen/positions*", route_degen_positions_mock)

            pgP.goto(BASE, wait_until="networkidle")
            pgP.wait_for_timeout(300)

            # Connect EVM wallet to launch Migrator & trigger scan + Preservation Strip
            pgP.click("#heroConnectBtn")
            pgP.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            pgP.click("[data-pick-evm]")
            pgP.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgP.wait_for_selector("#preservationStripCard", timeout=15000)

            # 7A. Verify Preservation Strip surfaces Tiered Preservation Fee + Route Auction Winner
            strip_info = pgP.evaluate("""() => ({
              feeText: document.getElementById('preservationTieredFeePill')?.textContent?.trim() || '',
              routeText: document.getElementById('preservationRouteWinnerPill')?.textContent?.trim() || '',
              stripText: document.getElementById('preservationStripCard')?.innerText || '',
            })""")
            assert "Tiered Fee:" in strip_info["feeText"] and "vs 7%" in strip_info["feeText"], strip_info
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

            # 7C. 1-Click Post-Arrival Solana Yield Park: strategies loaded, split toggle, preview + 1-Click Park
            pgP.wait_for_function(
                "() => (document.querySelectorAll('#yieldStrategySelect option').length) >= 3",
                timeout=8000,
            )
            pgP.click("[data-yield-split='100']")
            pgP.click("[data-yield-split='90']")
            pgP.fill("#yieldAmountInput", "500")
            pgP.locator("#yieldAmountInput").dispatch_event("input")
            pgP.click("#previewYieldBtn")
            pgP.wait_for_function(
                "() => (document.getElementById('yieldParkBody')?.innerText || '').includes('Orca Whirlpool')",
                timeout=8000,
            )
            yield_preview_text = pgP.locator("#yieldParkCard").inner_text()
            assert "7.45%" in yield_preview_text and "$450.00" in yield_preview_text, yield_preview_text
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

            # Return to Sweep for multi-viewport overflow check
            pgP.click(".app-tab[data-view='scanner']")
            pgP.wait_for_timeout(150)

            # 7F. Degen Tab: mocked live markets + side-pocket cap (default 10%, clamped max 50%)
            pgP.click(".app-tab[data-view='degen']")
            pgP.wait_for_selector("#degenCustomPctInput", timeout=10000)
            pgP.wait_for_function(
                "() => (document.getElementById('degenRoot')?.innerText || '').includes('SOL close above $250')",
                timeout=10000,
            )
            degen_default_pct = pgP.evaluate("() => Number(document.getElementById('degenCustomPctInput')?.value)")
            assert degen_default_pct == 10, f"Expected default Degen side-pocket cap 10%, got {degen_default_pct}"
            pgP.fill("#degenCustomPctInput", "85")
            pgP.locator("#degenCustomPctInput").dispatch_event("change")
            pgP.wait_for_timeout(150)
            degen_clamped_pct = pgP.evaluate("() => Number(document.getElementById('degenCustomPctInput')?.value)")
            assert degen_clamped_pct == 50, f"Expected Degen side-pocket cap clamped to 50%, got {degen_clamped_pct}"

            # 7G. Verify 0px horizontal overflow across Desktop (1440px), Tablet (900px), Mobile (390px)
            # on BOTH Sweep (with Preservation Tools populated) and Degen views
            overflowP = {}
            for label, vp in [("1440", {"width": 1440, "height": 900}), ("900", {"width": 900, "height": 800}), ("390", {"width": 390, "height": 844})]:
                pgP.set_viewport_size(vp)
                pgP.click(".app-tab[data-view='scanner']")
                pgP.wait_for_timeout(180)
                overflowP[f"scanner_{label}"] = pgP.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                pgP.click(".app-tab[data-view='degen']")
                pgP.wait_for_timeout(180)
                overflowP[f"degen_{label}"] = pgP.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")

            xss_p = pgP.evaluate("() => Boolean(window.__xssP)")
            assert not xss_p, "XSS payload executed in Preservation Tools!"
            assert all(v <= 0 for v in overflowP.values()), f"Preservation/Degen overflow: {overflowP}"
            assert not errsP, f"Preservation/Degen errors: {errsP}"
            assert not badHttpP, f"Preservation/Degen bad HTTP: {badHttpP}"
            results["preservation_tools_and_degen_ux"] = {
                "ok": True,
                "tieredFeeAndRouteWinnerVerified": True,
                "rentReclaimSigned": True,
                "yieldParkQuotedAndSigned": True,
                "approvalsSingleAndBatchRevoked": True,
                "gasWatchdogCreatedAndCancelled": True,
                "degenCapDefault10Clamped50": True,
                "xssBlocked": True,
                "overflowPx": overflowP,
            }
            ctxP.close()

            browser.close()

        print(json.dumps(results, indent=2))
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=3)
        except Exception:
            srv.kill()


if __name__ == "__main__":
    main()
