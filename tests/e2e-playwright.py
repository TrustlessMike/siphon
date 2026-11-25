#!/usr/bin/env python3
"""
End-to-end headless Chromium regression suite for Siphon.
Verifies desktop (1440px) & mobile (390px), all 5 views, multi-plugin EVM & Solana discovery,
Coinbase Smart Wallet + WalletConnect SDK bundle runtime, EIP-5792 batching, legacy sequential
fallback, WebGL + SVG graphics, and zero console/HTTP/overflow errors.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get("SIPHON_E2E_PORT", "4439"))
BASE = f"http://127.0.0.1:{PORT}"
SHOT_DIR = os.environ.get("SIPHON_E2E_SCREENSHOT_DIR", "")
VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
VET_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
SOL_PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"


def wait_ready():
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Siphon server failed to start on {BASE}")


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
        results = {}

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # ------------------------------------------------------------------
            # 1. DESKTOP 1440px: Website, Multi-Plugin Discovery, SDK Runtime,
            #    EIP-5792 1-Click Batch, Clear Button, All 5 Views & Graphics
            # ------------------------------------------------------------------
            ctxD = browser.new_context(viewport={"width": 1440, "height": 900})
            pgD = ctxD.new_page()
            errsD = []
            badHttpD = []
            pgD.on("pageerror", lambda e: errsD.append(f"pageerror: {e}"))
            pgD.on("console", lambda m: errsD.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgD.on("response", lambda r: badHttpD.append(f"{r.status} {r.request.method} {r.url}") if r.status >= 400 and "/api/solana/balance" not in r.url else None)

            pgD.add_init_script(f"""
              window.__rpcD = [];
              let statusPoll = 0;
              let chainHex = '0x1';
              const makeEvm = (name) => ({{
                on() {{}},
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
                    return {{ status: 200, receipts: [{{ transactionHash: '0x' + 'aa'.repeat(32) }}] }};
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
                solana: {{ isPhantom: true, async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }} }}
              }};
              window.okxwallet = makeEvm('OKX');
              window.solflare = {{ async connect() {{ return {{ publicKey: {{ toString: () => '{SOL_PUBKEY}' }} }}; }} }};
              window.keplr = {{
                async enable(chainIds) {{
                  window.__keplrEnabled = chainIds;
                  return true;
                }},
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
                  features: {{ 'standard:connect': {{ async connect() {{ return {{ accounts: [{{ address: '{SOL_PUBKEY}' }}] }}; }} }} }}
                }}, {{
                  name: 'Backpack',
                  chains: ['solana:mainnet'],
                  features: {{ 'standard:connect': {{ async connect() {{ return {{ accounts: [{{ address: '{SOL_PUBKEY}' }}] }}; }} }} }}
                }});
              }});
            """)

            pgD.goto(BASE, wait_until="networkidle")
            pgD.wait_for_timeout(450)

            # Verify Coinbase Smart Wallet SDK + WalletConnect SDK + HEAD / COOP + WebGL canvas
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

            # Open Wallet Modal from homepage -> verify all plugins + Solana tab + Escape close
            pgD.click("#heroConnectBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            evmWallets = pgD.locator(".wallet-option-name").all_inner_texts()
            assert "MetaMask" in evmWallets and "Rabby Wallet" in evmWallets, evmWallets
            assert "Coinbase Smart Wallet" in evmWallets and "WalletConnect (Mobile QR)" in evmWallets, evmWallets
            # Verify every official brand logo SVG in the wallet modal + hero bar loaded cleanly!
            pgD.wait_for_timeout(150)
            brokenWalletImgs = pgD.evaluate("""() => {
              const imgs = Array.from(document.querySelectorAll('#walletModalBackdrop img, .hero-stage-bar img'));
              return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
            }""")
            assert not brokenWalletImgs, f"Broken brand logo images: {brokenWalletImgs}"
            maybe_shot(pgD, "goal_desktop_wallet_modal_1440.png", full_page=False)

            # Verify WalletConnect inline Project ID setup opens smoothly when clicked without env var
            pgD.click("[data-pick-wc='true']")
            pgD.wait_for_selector("#modalWcProjectForm", timeout=3000)
            pgD.click("[data-pick-wc='true']")

            pgD.click("#walletTabSol")
            solWallets = pgD.locator(".wallet-option-name").all_inner_texts()
            assert "Phantom" in solWallets and "Backpack" in solWallets and "Solflare" in solWallets, solWallets
            pgD.click("[data-pick-sol='std:phantom']")
            pgD.wait_for_timeout(250)

            # Connect Rabby EVM from site header -> auto-scans & opens console
            pgD.click("#siteConnectBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            pgD.click("#walletTabEvm")
            pgD.click("[data-pick-evm='rabby-1']")
            pgD.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#connectEvmBtn')?.textContent?.includes('Rabby')", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#connectSolBtn')?.textContent?.includes('Phantom')", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=15000)
            pgD.wait_for_timeout(400)

            # Verify all 7 ecosystem family pills render with zero broken SVG logos!
            famPills = pgD.locator("#familyBar .family-pill").count()
            assert famPills == 7, f"Expected 7 ecosystem family pills, got {famPills}"
            brokenFamLogos = pgD.evaluate("""() => {
              const imgs = Array.from(document.querySelectorAll('#familyBar img'));
              return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
            }""")
            assert not brokenFamLogos, f"Broken family logos: {brokenFamLogos}"

            # Verify switching to Cosmos & connecting Keplr enables multi-chain Cosmos wallets cleanly!
            pgD.click("#familyBar [data-family='cosmos']")
            pgD.wait_for_function("() => (document.querySelector('#connectEvmBtn')?.innerText || '').includes('Cosmos')", timeout=10000)
            pgD.click("#connectEvmBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            cosmosModalText = pgD.locator("#walletModalBackdrop").inner_text()
            assert "Keplr" in cosmosModalText and "Leap" in cosmosModalText and "Cosmostation" in cosmosModalText, cosmosModalText
            pgD.click("[data-pick-family-wallet='keplr']")
            pgD.wait_for_selector("#walletModalBackdrop", state="hidden", timeout=10000)
            pgD.wait_for_function(
                "() => (document.querySelector('#connectEvmBtn')?.innerText || '').includes('Keplr')",
                timeout=10000,
            )

            pgD.click("#familyBar [data-family='btc']")
            pgD.wait_for_function("() => (document.querySelector('#connectEvmBtn')?.innerText || '').includes('Bitcoin')", timeout=10000)
            pgD.click("#connectEvmBtn")
            pgD.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            btcModalText = pgD.locator("#walletModalBackdrop").inner_text()
            assert "UniSat" in btcModalText and "Xverse" in btcModalText, btcModalText
            pgD.keyboard.press("Escape")
            pgD.wait_for_selector("#walletModalBackdrop", state="hidden")

            # Switch back to EVM for full EVM batch & proof assertions
            pgD.click("#familyBar [data-family='evm']")
            pgD.wait_for_function("() => document.querySelector('#connectEvmBtn')?.textContent?.includes('Rabby')", timeout=15000)
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=15000)
            pgD.wait_for_timeout(300)

            # Verify Rabby Small-Swap 2-column workspace: chain filter chips, fee drawer, bridge route, & contracts!
            pgD.click("#chainFilterBar [data-chain-filter='base']")
            pgD.wait_for_timeout(120)
            pgD.click("#chainFilterBar [data-chain-filter='all']")
            pgD.wait_for_timeout(120)

            # Open fee drawer -> switch 7% -> 10% + treasury -> back to 7%
            pgD.click("#toggleFeeDrawerBtn")
            pgD.wait_for_selector("#feeOptionsDrawer:not(.hidden)")
            pgD.select_option("#protocolFeeSelect", "1000")
            pgD.fill("#feeRecipientInput", "0x1111111111111111111111111111111111111111")
            pgD.locator("#feeRecipientInput").dispatch_event("change")
            pgD.wait_for_function("() => (document.querySelector('#summaryFeeText')?.innerText || '').includes('10%')", timeout=5000)
            pgD.select_option("#protocolFeeSelect", "700")
            pgD.fill("#feeRecipientInput", "")
            pgD.locator("#feeRecipientInput").dispatch_event("change")
            pgD.wait_for_function("() => (document.querySelector('#summaryFeeText')?.innerText || '').includes('7%')", timeout=5000)
            pgD.click("#toggleFeeDrawerBtn")

            # Bridge route selector updates logos & Activity SVG dynamically
            pgD.select_option("#bridgePrefSelect", "lifi")
            pgD.wait_for_function("() => (document.querySelector('#convergenceSvgHost')?.innerText || '').includes('LI.FI')", timeout=5000)
            pgD.select_option("#bridgePrefSelect", "cctp")
            pgD.wait_for_function("() => (document.querySelector('#convergenceSvgHost')?.innerText || '').includes('Circle CCTP')", timeout=5000)
            pgD.select_option("#bridgePrefSelect", "auto")
            pgD.wait_for_function("() => (document.querySelector('#convergenceSvgHost')?.innerText || '').includes('Relay / LI.FI')", timeout=5000)

            # Check live vitalik.eth headline USD + SVG paths
            netUsdcText = pgD.locator("#kpiNetUsdc").inner_text()
            svgPaths = pgD.locator("#convergenceSvgHost svg path").count()
            assert svgPaths >= 10, f"Expected SVG convergence paths, got {svgPaths}"
            maybe_shot(pgD, "goal_desktop_scanner_1440.png", full_page=True)

            # Test Clear button resets legs to 0, then re-select profitable
            pgD.click("#clearSelectionBtn")
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent === '0'", timeout=5000)
            pgD.click("#selectProfitableBtn")
            pgD.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=5000)

            # Verify live Pre-Sign Proof (real RPC eth_call + bytes32 check + SHA-256 digest)
            pgD.click("#verifyProofBtn")
            pgD.wait_for_selector("#preSignProofCard:not(.hidden)", timeout=20000)
            proofText = pgD.locator("#preSignProofCard").inner_text()
            assert "Matched bit-for-bit" in proofText, proofText

            # Verify Gasless 1-Sig Permit2 / EIP-7702 mode signs ONE off-chain EIP-712 message ($0 gas!)
            pgD.click(".mode-opt[data-exec-mode='gasless']")
            pgD.click("[data-exec-chain-batch='base']")
            pgD.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=15000)
            pgD.wait_for_function(
                "() => (window.__rpcD || []).some(r => r.method === 'eth_signTypedData_v4')",
                timeout=15000,
            )

            # Switch back to Direct Batch and execute Base 1-click EIP-5792 batch
            pgD.click(".mode-opt[data-exec-mode='direct']")
            pgD.wait_for_selector("[data-exec-chain-batch='base']")
            pgD.click("[data-exec-chain-batch='base']")
            pgD.wait_for_selector("#agentStatusCard:not(.hidden)", timeout=20000)
            pgD.wait_for_function(
                "() => (document.querySelector('#agentLegsFeed')?.innerText || '').includes('EVM ↗')",
                timeout=20000,
            )
            rpcD = pgD.evaluate("() => window.__rpcD")
            sendCallsD = [c for c in rpcD if c["method"] == "wallet_sendCalls"]
            assert len(sendCallsD) == 1, f"Expected 1 wallet_sendCalls, got {len(sendCallsD)}"
            assert sendCallsD[0]["params"][0]["chainId"] == "0x2105"
            maybe_shot(pgD, "goal_desktop_pipeline_1440.png", full_page=True)

            # Verify Contract switcher toggles between SiphonRouter.sol, SiphonSweepDelegate.sol, SiphonAgentVault.sol & SiphonFeeVault.sol + Agents & AI tab
            for view in ["scanner", "activity", "agents", "contract"]:
                pgD.click(f".app-tab[data-view='{view}']")
                pgD.wait_for_timeout(250)
                overflowD[view] = pgD.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                if view == "activity":
                    maybe_shot(pgD, "goal_desktop_burns_1440.png", full_page=True)
                elif view == "agents":
                    pgD.wait_for_function("() => (document.querySelector('#claudeMcpConfigHost')?.innerText || '').includes('siphon')", timeout=5000)
                    pgD.click("#simulateAiProposalBtn")
                    pgD.wait_for_function("() => (document.querySelector('#agentApprovalsHost')?.innerText || '').includes('Approve Permission')", timeout=5000)
                    pgD.click("[data-decision='approve']")
                    pgD.wait_for_function("() => (document.querySelector('#agentApprovalsHost')?.innerText || '').includes('approved')", timeout=5000)
                    maybe_shot(pgD, "goal_desktop_agents_1440.png", full_page=True)
                elif view == "contract":
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract SiphonRouter')", timeout=5000)
                    pgD.click(".contract-tab[data-contract-id='delegate']")
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract SiphonSweepDelegate')", timeout=5000)
                    pgD.click(".contract-tab[data-contract-id='agent']")
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract SiphonAgentVault')", timeout=5000)
                    pgD.click(".contract-tab[data-contract-id='vault']")
                    pgD.wait_for_function("() => (document.querySelector('#contractCodeHost')?.innerText || '').includes('contract SiphonFeeVault')", timeout=5000)
                    pgD.click(".contract-tab[data-contract-id='router']")
                    maybe_shot(pgD, "goal_desktop_contract_1440.png", full_page=True)

            assert all(v <= 0 for v in overflowD.values()), f"Desktop overflow: {overflowD}"
            assert not errsD, f"Desktop console errors: {errsD}"
            assert not badHttpD, f"Desktop bad HTTP: {badHttpD}"

            results["desktop_1440"] = {
                "ok": True,
                "sdkAndGraphics": sdk_gfx,
                "svgPaths": svgPaths,
                "liveVitalikNetUsdc": netUsdcText,
                "evmWallets": evmWallets,
                "solWallets": solWallets,
                "eip5792CallsBatched": len(sendCallsD[0]["params"][0]["calls"]),
                "overflowPx": overflowD,
            }
            ctxD.close()

            # ------------------------------------------------------------------
            # 2. LEGACY EOA SEQUENTIAL FALLBACK (-32601 -> eth_sendTransaction)
            # ------------------------------------------------------------------
            ctxL = browser.new_context(viewport={"width": 1440, "height": 900})
            pgL = ctxL.new_page()
            errsL = []
            pgL.on("pageerror", lambda e: errsL.append(str(e)))
            pgL.add_init_script(f"""
              window.__legacyMethods = [];
              let chainHex = '0x89';
              let n = 0;
              window.ethereum = {{
                isMetaMask: true,
                on() {{}},
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
            """)

            def route_vet(route):
                body = route.request.post_data_json or {}
                if str(body.get("address", "")).lower() == VET_ADDR.lower():
                    req = urllib.request.Request(
                        f"{BASE}/api/scan",
                        data=json.dumps({"presetId": "veteran_defi"}).encode(),
                        headers={"Content-Type": "application/json"},
                    )
                    with urllib.request.urlopen(req) as resp:
                        route.fulfill(status=200, content_type="application/json", body=resp.read())
                    return
                route.continue_()

            def route_tx_status(route):
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"evmConfirmed": True, "evmFailed": False, "bridgeStatus": "confirmed"}),
                )

            pgL.route("**/api/scan", route_vet)
            pgL.route("**/api/tx/status", route_tx_status)
            pgL.goto(BASE, wait_until="networkidle")
            pgL.click("#siteConnectBtn")
            pgL.wait_for_selector("[data-pick-evm]")
            pgL.click("[data-pick-evm]")
            pgL.wait_for_selector("#appShell:not(.hidden)", timeout=15000)
            pgL.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent === '6'", timeout=15000)
            pgL.select_option("#bridgePrefSelect", "cctp")
            pgL.click("[data-exec-chain-batch='polygon']")
            pgL.wait_for_function(
                "() => (window.__legacyMethods || []).filter(m => m === 'eth_sendTransaction').length === 3",
                timeout=20000,
            )
            legacyMethods = pgL.evaluate("() => window.__legacyMethods")
            assert legacyMethods.count("eth_sendTransaction") == 3
            assert not errsL, f"Legacy fallback errors: {errsL}"
            results["legacy_sequential_fallback"] = {
                "ok": True,
                "ethSendTransactionCount": legacyMethods.count("eth_sendTransaction"),
            }
            ctxL.close()

            # ------------------------------------------------------------------
            # 3. MOBILE 390x844: All 5 Views + Wallet Modal + 3D Graphics
            # ------------------------------------------------------------------
            ctxM = browser.new_context(viewport={"width": 390, "height": 844})
            pgM = ctxM.new_page()
            errsM = []
            pgM.on("pageerror", lambda e: errsM.append(f"pageerror: {e}"))
            pgM.on("console", lambda m: errsM.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            pgM.goto(BASE, wait_until="networkidle")
            pgM.wait_for_timeout(450)

            overflowM = {"website": pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")}
            maybe_shot(pgM, "goal_mobile_website_390.png", full_page=True)

            # Wallet modal on mobile
            pgM.click("#heroConnectBtn")
            pgM.wait_for_selector("#walletModalBackdrop:not(.hidden)")
            maybe_shot(pgM, "goal_mobile_wallet_modal_390.png", full_page=False)
            pgM.keyboard.press("Escape")

            pgM.click("#navLaunchBtn")
            pgM.wait_for_selector("#appShell:not(.hidden)")
            pgM.wait_for_function("() => document.querySelector('#tabLegCount')?.textContent !== '0'", timeout=15000)
            pgM.wait_for_timeout(300)

            for view in ["scanner", "activity", "agents", "contract"]:
                pgM.click(f".app-tab[data-view='{view}']")
                pgM.wait_for_timeout(250)
                overflowM[view] = pgM.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                shot_name = "burns" if view == "activity" else view
                maybe_shot(pgM, f"goal_mobile_{shot_name}_390.png", full_page=True)

            assert all(v <= 0 for v in overflowM.values()), f"Mobile overflow: {overflowM}"
            assert not errsM, f"Mobile console errors: {errsM}"
            results["mobile_390"] = {"ok": True, "overflowPx": overflowM}
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
