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
        env={**os.environ, "PORT": str(PORT)},
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
                    'osmosis-1': 'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
                    'noble-1': 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
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
            pgD.click("[data-exec-chain-batch='optimism']")
            pgD.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=10000)
            pgD.wait_for_function("() => (window.__rpcD || []).some(r => r.method === 'eth_signTypedData_v4')", timeout=10000)

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
                    pgD.click("#simulateAiProposalBtn")
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

            assert all(v <= 0 for v in overflowD.values()), f"Desktop overflow: {overflowD}"
            assert not errsD, f"Desktop errors: {errsD}"
            assert not badHttpD, f"Desktop bad HTTP: {badHttpD}"
            results["desktop_1440"] = {
                "ok": True,
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

            overflowT = {}
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
