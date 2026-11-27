import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CCTP_V2_FALLBACK_FAST_FEE_BPS,
  encodeCctpDepositForBurn,
  fetchCctpV2BurnFee,
  solanaOwnerToUsdcAtaBytes32,
} from '../src/bridge/cctp.js';
import {
  isAllowedAaveV3Pool,
  isCuratedDefiVault,
  UNISWAP_V3_NFT_MANAGERS,
  V2_DEX_ROUTERS,
  validateTrustedProtocolTarget,
} from '../src/defi/extractors.js';
import {
  computeDynamicGasReserveSummary,
  computeDynamicGasReserveWei,
  DEBRIDGE_CHAIN_ID_OVERRIDE,
  fetchDeBridgeDlnQuote,
  fetchMayanSwiftQuote,
} from '../src/execution/route-auction.js';
import { getKnownApprovalSpenders } from '../src/scanner/approvals.js';
import {
  CCTP_V2_MESSAGE_TRANSMITTER,
  CCTP_V2_TOKEN_MESSENGER,
  CHAIN_LIST,
  EVM_CHAINS,
  MULTICALL3_ADDRESS,
  TOKEN_REGISTRY,
  ZKSYNC_MULTICALL3_ADDRESS,
  getProtocolFeeConfig,
} from '../src/scanner/chains.js';
import { ALCHEMY_NETWORK_SUBDOMAINS } from '../src/scanner/discovery.js';
import { FALLBACK_PRICES } from '../src/scanner/prices.js';
import { estimateBridgeFixedFeeUsd, estimateL1DataFeeUsd } from '../src/scanner/roi.js';
import type { EvmChainId, ScannedAsset } from '../src/scanner/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const NEW_2026_CHAINS: readonly EvmChainId[] = [
  'hyperevm',
  'berachain',
  'zksync',
  'ink',
  'gnosis',
] as const;

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SAMPLE_USER = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SAMPLE_SOLANA_DEST = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';

function makeAsset(chain: EvmChainId, overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  const cfg = EVM_CHAINS[chain];
  return {
    id: `${chain}:usdc`,
    chain,
    chainName: cfg.name,
    address: cfg.usdcAddress,
    symbol: 'USDC',
    name: `USD Coin (${cfg.name})`,
    decimals: 6,
    kind: 'erc20',
    rawBalance: '500000000', // 500 USDC
    uiBalance: 500,
    priceUsd: 1,
    grossUsd: 500,
    liquidityUsd: 25_000_000,
    estimatedGasUsd: 0.05,
    batchedGasUsd: 0.03,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 498,
    netUsdcBatched: 498.5,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct USDC bridge',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

test('Wave 7B: All 20 EVM chains have unique EIP-155 chainIds, valid addresses, RPC failover arrays, and explorer URLs', () => {
  assert.equal(CHAIN_LIST.length, 20, `Expected 20 EVM chains, got ${CHAIN_LIST.length}`);

  const seenIds = new Set<string>();
  const seenChainIds = new Set<number>();
  const seenCctpDomains = new Set<number>();

  for (const chain of CHAIN_LIST) {
    assert.ok(!seenIds.has(chain.id), `Duplicate chain id: ${chain.id}`);
    seenIds.add(chain.id);

    assert.ok(Number.isInteger(chain.chainId) && chain.chainId > 0, `Invalid chainId for ${chain.id}`);
    assert.ok(!seenChainIds.has(chain.chainId), `Duplicate numeric chainId ${chain.chainId}`);
    seenChainIds.add(chain.chainId);

    assert.match(chain.multicall3, EVM_ADDR_RE, `${chain.id} invalid multicall3`);
    assert.match(chain.usdcAddress, EVM_ADDR_RE, `${chain.id} invalid usdcAddress`);
    assert.ok(chain.rpcUrls.length >= 2, `${chain.id} must have >= 2 RPC URLs for failover`);
    for (const url of chain.rpcUrls) {
      assert.ok(url.startsWith('https://'), `${chain.id} RPC URL must use HTTPS: ${url}`);
    }
    assert.ok(chain.explorerUrl.startsWith('https://'), `${chain.id} explorerUrl must use HTTPS`);
    assert.ok(
      Number.isFinite(chain.gasReserveNative) && chain.gasReserveNative > 0,
      `${chain.id} gasReserveNative must be > 0`
    );

    if (chain.aaveV3Pool) {
      assert.match(chain.aaveV3Pool, EVM_ADDR_RE, `${chain.id} invalid aaveV3Pool`);
    }
    if (chain.cctpDomain !== null) {
      assert.ok(!seenCctpDomains.has(chain.cctpDomain), `Duplicate CCTP domain ${chain.cctpDomain}`);
      seenCctpDomains.add(chain.cctpDomain);
      assert.equal(chain.cctpVersion, 2);
      assert.equal(chain.cctpTokenMessenger, CCTP_V2_TOKEN_MESSENGER);
      assert.equal(chain.cctpMessageTransmitter, CCTP_V2_MESSAGE_TRANSMITTER);
    } else {
      assert.equal(chain.cctpVersion, null);
      assert.equal(chain.cctpTokenMessenger, null);
      assert.equal(chain.cctpMessageTransmitter, null);
    }
  }

  // Exact EIP-155 chain IDs and Multicall3 configurations for the 5 new 2026 chains
  assert.equal(EVM_CHAINS.hyperevm.chainId, 999);
  assert.equal(EVM_CHAINS.hyperevm.nativeSymbol, 'HYPE');
  assert.equal(EVM_CHAINS.hyperevm.multicall3, MULTICALL3_ADDRESS);

  assert.equal(EVM_CHAINS.berachain.chainId, 80094);
  assert.equal(EVM_CHAINS.berachain.nativeSymbol, 'BERA');
  assert.equal(EVM_CHAINS.berachain.multicall3, MULTICALL3_ADDRESS);

  assert.equal(EVM_CHAINS.zksync.chainId, 324);
  assert.equal(EVM_CHAINS.zksync.nativeSymbol, 'ETH');
  assert.equal(EVM_CHAINS.zksync.multicall3, ZKSYNC_MULTICALL3_ADDRESS);

  assert.equal(EVM_CHAINS.ink.chainId, 57073);
  assert.equal(EVM_CHAINS.ink.nativeSymbol, 'ETH');
  assert.equal(EVM_CHAINS.ink.multicall3, MULTICALL3_ADDRESS);

  assert.equal(EVM_CHAINS.gnosis.chainId, 100);
  assert.equal(EVM_CHAINS.gnosis.nativeSymbol, 'xDAI');
  assert.equal(EVM_CHAINS.gnosis.multicall3, MULTICALL3_ADDRESS);
});

test('Wave 7B: 100% of TOKEN_REGISTRY tokens & native keys across all 19 EVM chains have positive FALLBACK_PRICES & valid hex addresses', () => {
  const lowerFallbacks = new Map<string, number>(
    Object.entries(FALLBACK_PRICES).map(([k, v]) => [k.toLowerCase(), v])
  );

  for (const chain of CHAIN_LIST) {
    const nativePrice =
      FALLBACK_PRICES[chain.nativeLlamaId] ?? lowerFallbacks.get(chain.nativeLlamaId.toLowerCase());
    assert.ok(
      typeof nativePrice === 'number' && Number.isFinite(nativePrice) && nativePrice > 0,
      `Missing positive FALLBACK_PRICES for ${chain.id} native key ${chain.nativeLlamaId}`
    );
  }

  const seenTokens = new Set<string>();
  for (const tok of TOKEN_REGISTRY) {
    assert.match(tok.address, EVM_ADDR_RE, `Invalid token address ${tok.address} on ${tok.chain}`);
    const key = `${tok.chain}:${tok.address.toLowerCase()}`;
    assert.ok(!seenTokens.has(key), `Duplicate TOKEN_REGISTRY key ${key}`);
    seenTokens.add(key);

    assert.ok(tok.llamaKey, `Missing llamaKey on ${tok.chain} ${tok.symbol}`);
    const price = FALLBACK_PRICES[tok.llamaKey] ?? lowerFallbacks.get(tok.llamaKey.toLowerCase());
    assert.ok(
      typeof price === 'number' && Number.isFinite(price) && price > 0,
      `Missing positive FALLBACK_PRICES for ${tok.chain} ${tok.symbol} (${tok.llamaKey})`
    );
    if (tok.underlyingAddress) {
      assert.match(tok.underlyingAddress, EVM_ADDR_RE, `Invalid underlyingAddress on ${tok.chain} ${tok.symbol}`);
    }
    if (tok.protocolAddress) {
      assert.match(tok.protocolAddress, EVM_ADDR_RE, `Invalid protocolAddress on ${tok.chain} ${tok.symbol}`);
    }
  }

  // Every new 2026 chain must have multiple curated registry tokens
  for (const chain of NEW_2026_CHAINS) {
    const count = TOKEN_REGISTRY.filter((t) => t.chain === chain).length;
    assert.ok(count >= 5, `Expected >= 5 curated tokens for ${chain}, got ${count}`);
  }
});

test('Wave 7B: Circle CCTP V2 enabled ONLY on verified domains (HyperEVM 19, Ink 21) and null on Berachain, zkSync, Gnosis', async () => {
  assert.equal(EVM_CHAINS.hyperevm.cctpDomain, 19);
  assert.equal(EVM_CHAINS.hyperevm.cctpVersion, 2);
  assert.equal(EVM_CHAINS.ink.cctpDomain, 21);
  assert.equal(EVM_CHAINS.ink.cctpVersion, 2);

  assert.ok(CCTP_V2_FALLBACK_FAST_FEE_BPS[19] > 0);
  assert.ok(CCTP_V2_FALLBACK_FAST_FEE_BPS[21] > 0);

  const ataBytes32 = solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_DEST);
  for (const chain of ['hyperevm', 'ink'] as const) {
    const cfg = EVM_CHAINS[chain];
    const calldata = encodeCctpDepositForBurn({
      rawUsdcAmount: 100_000_000n,
      destinationDomain: 5,
      solanaMintRecipientBytes32: ataBytes32,
      usdcAddress: cfg.usdcAddress,
      cctpVersion: 2,
      transferMode: 'fast',
      fastFeeBps: CCTP_V2_FALLBACK_FAST_FEE_BPS[cfg.cctpDomain!],
    });
    assert.ok(calldata.startsWith('0x8e0250ee'), `${chain} must encode CCTP V2 depositForBurn`);
    assert.equal(calldata.length, 2 + 8 + 64 * 7);

    // Offline fallback fee check (no network dependency)
    const feeQuote = await fetchCctpV2BurnFee({
      sourceDomain: cfg.cctpDomain!,
      mode: 'fast',
      rawUsdcAmount: 100_000_000n,
      fetcher: async () => new Response('offline', { status: 503 }),
    });
    assert.equal(feeQuote.source, 'fallback');
    assert.equal(feeQuote.feeBps, CCTP_V2_FALLBACK_FAST_FEE_BPS[cfg.cctpDomain!]);
  }

  for (const chain of ['berachain', 'zksync', 'gnosis'] as const) {
    assert.equal(EVM_CHAINS[chain].cctpDomain, null);
    assert.equal(EVM_CHAINS[chain].cctpVersion, null);
    assert.equal(EVM_CHAINS[chain].cctpTokenMessenger, null);
  }
});

test('Wave 7B: DeFi extractors & approval spenders cover HyperEVM, Berachain, zkSync Era, Ink, and Gnosis', () => {
  // Aave v3 allowlist verification
  assert.equal(isAllowedAaveV3Pool('hyperevm', '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b'), true);
  assert.equal(isAllowedAaveV3Pool('zksync', '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c'), true);
  assert.equal(isAllowedAaveV3Pool('ink', '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA'), true);
  assert.equal(isAllowedAaveV3Pool('gnosis', '0xb50201558B00496A145fE76f7424749556E326D8'), true);

  // Gnosis sDAI ERC-4626 curated vault trust check
  const gnosisSdai = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
  assert.equal(isCuratedDefiVault('gnosis', gnosisSdai), true);
  assert.equal(
    validateTrustedProtocolTarget({
      chain: 'gnosis',
      protocolId: 'erc4626',
      assetAddress: gnosisSdai,
      protocolAddress: gnosisSdai,
    }).trusted,
    true
  );

  // V2 DEX routers & V3 NFT managers
  assert.ok((V2_DEX_ROUTERS.berachain?.length ?? 0) >= 1, 'Berachain should register Kodiak v2');
  assert.ok((UNISWAP_V3_NFT_MANAGERS.berachain?.length ?? 0) >= 1, 'Berachain should register Kodiak v3 NFT manager');
  assert.ok((V2_DEX_ROUTERS.gnosis?.length ?? 0) >= 2, 'Gnosis should register Honeyswap v2 + SushiSwap v2');

  // Known approval spenders for every new chain (including Permit2 + chain-specific DEX/Lending routers)
  for (const chain of NEW_2026_CHAINS) {
    const spenders = getKnownApprovalSpenders(chain);
    assert.ok(spenders.length >= 8, `${chain} should expose >= 8 known approval spenders (got ${spenders.length})`);
    assert.ok(
      spenders.some((s) => s.address.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3'),
      `${chain} must include Permit2 spender`
    );
    for (const s of spenders) {
      assert.match(s.address, EVM_ADDR_RE, `${chain} invalid spender address ${s.address}`);
    }
  }

  // Alchemy subdomains where supported
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.berachain, 'berachain-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.zksync, 'zksync-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.ink, 'ink-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.gnosis, 'gnosis-mainnet');
});

test('Wave 7B: Dynamic gas reserve math, ROI fee tiers, and route auction adapters work across all 5 new EVM chains', async () => {
  // Dynamic gas reserve >= 2.0x safety ratio across all 19 EVM chains
  for (const chain of CHAIN_LIST) {
    const reserveWei = computeDynamicGasReserveWei(chain.id, 0n, 1);
    assert.ok(reserveWei > 0n, `${chain.id} dynamic gas reserve must be > 0n`);
    const summary = computeDynamicGasReserveSummary({
      chain: chain.id,
      liveGasPriceWei: 100_000_000n,
      plannedTxCount: 1,
      nativePriceUsd: 100,
    });
    assert.ok(
      summary.effectiveSafetyRatio >= 2.0,
      `${chain.id} safety ratio ${summary.effectiveSafetyRatio} dropped below 2.0x`
    );
  }

  // L2 data fee & bridge fixed fee sanity
  assert.ok(estimateL1DataFeeUsd('zksync', true) > 0, 'zkSync Era L2 should include L1 data fee');
  assert.ok(estimateL1DataFeeUsd('ink', true) > 0, 'Ink L2 should include L1 data fee');
  assert.equal(estimateL1DataFeeUsd('hyperevm', true), 0, 'HyperEVM L1 should have 0 L1 blob fee');
  assert.equal(estimateL1DataFeeUsd('berachain', true), 0, 'Berachain L1 should have 0 L1 blob fee');
  assert.equal(estimateL1DataFeeUsd('gnosis', true), 0, 'Gnosis L1 should have 0 L1 blob fee');
  for (const chain of NEW_2026_CHAINS) {
    assert.ok(estimateBridgeFixedFeeUsd(chain) > 0, `${chain} bridge fixed fee must be > 0`);
  }

  // Route auction: HyperEVM maps to Mayan Swift slug `hyperevm` and deBridge DLN internal ID `100000022`
  assert.equal(DEBRIDGE_CHAIN_ID_OVERRIDE.hyperevm, 100000022);
  const feeCfg = getProtocolFeeConfig();
  const hypeUsdc = makeAsset('hyperevm');

  let seenMayanUrl = '';
  const mayanQuote = await fetchMayanSwiftQuote({
    asset: hypeUsdc,
    userAddress: SAMPLE_USER,
    solanaDestination: SAMPLE_SOLANA_DEST,
    outputAsset: 'USDC',
    feeConfig: feeCfg,
    allowanceCheckFn: async () => 10n ** 18n,
    fetcher: async (url) => {
      seenMayanUrl = url;
      return new Response(
        JSON.stringify([
          {
            type: 'SWIFT',
            quoteId: 'mayan-hype-1',
            expectedAmountOut: '499.4',
            expectedAmountOutUsd: '499.4',
            etaSeconds: 10,
            tx: {
              to: '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2',
              data: '0x12345678' + '00'.repeat(32),
              value: '0x0',
            },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });
  assert.ok(mayanQuote, 'HyperEVM should return a valid Mayan Swift quote');
  assert.ok(seenMayanUrl.includes('fromChain=hyperevm'), `Expected fromChain=hyperevm, got ${seenMayanUrl}`);

  let seenDeBridgeUrl = '';
  const dlnQuote = await fetchDeBridgeDlnQuote({
    asset: hypeUsdc,
    userAddress: SAMPLE_USER,
    solanaDestination: SAMPLE_SOLANA_DEST,
    outputAsset: 'USDC',
    feeConfig: feeCfg,
    allowanceCheckFn: async () => 10n ** 18n,
    fetcher: async (url) => {
      seenDeBridgeUrl = url;
      return new Response(
        JSON.stringify({
          orderId: '0x' + 'aa'.repeat(32),
          estimation: {
            dstChainTokenOut: {
              amount: '499100000',
              decimals: 6,
              symbol: 'USDC',
              approximateUsdValue: 499.1,
            },
          },
          tx: {
            to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66',
            data: '0x87654321' + '00'.repeat(32),
            value: '0x0',
          },
          order: { approximateFulfillmentDelay: 12 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });
  assert.ok(dlnQuote, 'HyperEVM should return a valid deBridge DLN quote');
  assert.ok(
    seenDeBridgeUrl.includes('srcChainId=100000022'),
    `Expected deBridge HyperEVM internal srcChainId=100000022, got ${seenDeBridgeUrl}`
  );
});

test('Wave 7B: Frontend SVG logos and chain theme mappings exist for all 19 EVM chains', () => {
  const appJs = fs.readFileSync(path.join(REPO_ROOT, 'public/app.js'), 'utf8');
  const svgJs = fs.readFileSync(path.join(REPO_ROOT, 'public/turgalium-svg.js'), 'utf8');

  for (const chain of CHAIN_LIST) {
    const logoPath = path.join(REPO_ROOT, 'public/logos', `${chain.id}.svg`);
    assert.ok(fs.existsSync(logoPath), `Missing SVG logo at public/logos/${chain.id}.svg`);
    const svgContent = fs.readFileSync(logoPath, 'utf8');
    assert.ok(svgContent.includes('<svg') && svgContent.includes('</svg>'), `Invalid SVG content for ${chain.id}`);
    assert.ok(appJs.includes(`'${chain.id}'`), `public/app.js missing chain slug '${chain.id}'`);
    assert.ok(svgJs.includes(`'${chain.id}'`), `public/turgalium-svg.js missing chain slug '${chain.id}'`);
  }
});
