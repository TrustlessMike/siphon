import crypto from 'node:crypto';
import { detectAddressFamily, getAdapterForFamily } from '../adapters/registry.js';
import { PROTOCOL_FEE_BPS } from './chains.js';
import { scanLiveWallet, scanPresetWallet } from './classifier.js';
import { applyTwoLevelRoiToReport } from './roi.js';
import type {
  ChainFamily,
  ChainScanSummary,
  ScannedAsset,
  ScanReport,
  UnifiedWalletSummary,
} from './types.js';

export interface UnifiedWalletInput {
  address?: string;
  presetId?: string;
  label?: string;
  family?: ChainFamily;
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Scans multiple source wallets across ANY combination of ecosystems (multiple EVMs,
 * Cosmos, Sui, Aptos, TON, Tron, Bitcoin) in parallel and unifies them into one
 * sweepable ScanReport with per-wallet provenance (`sourceWallet`, `sourceWalletLabel`).
 */
export async function scanUnifiedWallets(params: {
  wallets: UnifiedWalletInput[];
  hasSolanaUsdcAta?: boolean;
}): Promise<ScanReport> {
  const startedAt = performance.now();
  const deduped: UnifiedWalletInput[] = [];
  const seenKeys = new Set<string>();

  for (const w of params.wallets) {
    const key = (w.presetId ? `preset:${w.presetId}` : (w.address || '').trim().toLowerCase());
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(w);
  }

  if (!deduped.length) {
    throw new Error('At least one wallet address or presetId is required for unified scan.');
  }

  const perWalletResults = await Promise.all(
    deduped.map(async (w, idx) => {
      const t0 = performance.now();
      const fallbackLabel = w.label?.trim() || (w.presetId ? `Preset ${w.presetId}` : `Wallet ${idx + 1}`);
      try {
        let report: ScanReport;
        let family: ChainFamily;
        if (w.presetId) {
          report = await scanPresetWallet(w.presetId);
          family = 'evm';
        } else {
          const clean = (w.address || '').trim();
          const detected = detectAddressFamily(clean, w.family);
          if (!detected) {
            throw new Error(`Unsupported wallet address format: ${shortAddr(clean)}`);
          }
          family = detected;
          if (detected === 'evm') {
            report = await scanLiveWallet(clean, fallbackLabel);
            report.family = 'evm';
          } else {
            report = await getAdapterForFamily(detected).scanWallet(clean);
          }
        }
        return {
          ok: true as const,
          idx,
          family,
          label: w.label?.trim() || report.walletLabel || shortAddr(report.walletAddress),
          report,
          durationMs: Math.max(1, Math.round(performance.now() - t0)),
        };
      } catch (err) {
        return {
          ok: false as const,
          idx,
          family: w.family || 'evm',
          address: w.address || w.presetId || 'unknown',
          label: fallbackLabel,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Math.max(1, Math.round(performance.now() - t0)),
        };
      }
    })
  );

  const mergedAssets: ScannedAsset[] = [];
  const chainMap = new Map<string, ChainScanSummary>();
  const unifiedWallets: UnifiedWalletSummary[] = [];
  const warnings: string[] = [];
  let solPriceUsd = 70;
  let primaryMode: 'live_rpc' | 'preset' = 'live_rpc';

  for (const res of perWalletResults) {
    if (!res.ok) {
      warnings.push(`${res.label} scan failed: ${res.error}`);
      unifiedWallets.push({
        address: res.address,
        label: res.label,
        family: res.family,
        chainsWithAssets: 0,
        assetCount: 0,
        grossUsd: 0,
        scanDurationMs: res.durationMs,
        error: res.error,
      });
      continue;
    }

    const r = res.report;
    if (r.mode === 'preset') primaryMode = 'preset';
    if (r.totals.solPriceUsd > 0) solPriceUsd = r.totals.solPriceUsd;
    warnings.push(...r.warnings);

    unifiedWallets.push({
      address: r.walletAddress,
      label: res.label,
      family: res.family,
      chainsWithAssets: r.chains.filter((c) => c.assetCount > 0).length,
      assetCount: r.assets.length,
      grossUsd: r.totals.grossUsd,
      scanDurationMs: res.durationMs,
    });

    for (const a of r.assets) {
      mergedAssets.push({
        ...a,
        id: `w${res.idx}_${a.id}`,
        family: a.family || res.family,
        sourceWallet: a.sourceWallet || r.walletAddress,
        sourceWalletLabel: a.sourceWalletLabel || res.label,
      });
    }

    for (const c of r.chains) {
      const existing = chainMap.get(c.chain);
      if (!existing) {
        chainMap.set(c.chain, { ...c, family: c.family || res.family });
      } else {
        existing.assetCount += c.assetCount;
        existing.defiCount += c.defiCount;
        existing.liquidCount += c.liquidCount;
        existing.burnCount += c.burnCount;
        existing.skippedCount += c.skippedCount;
        existing.grossUsd = round2(existing.grossUsd + c.grossUsd);
        existing.netUsdcBridged = round2(existing.netUsdcBridged + c.netUsdcBridged);
        existing.totalGasUsd = round2(existing.totalGasUsd + c.totalGasUsd);
        existing.gasSavedByBatchUsd = round2(existing.gasSavedByBatchUsd + c.gasSavedByBatchUsd);
        existing.nativeBalance = round4(existing.nativeBalance + c.nativeBalance);
        existing.needsGasSponsorship = existing.needsGasSponsorship || c.needsGasSponsorship;
        if (c.rpcStatus === 'live') existing.rpcStatus = 'live';
        if (c.blockNumber > existing.blockNumber) existing.blockNumber = c.blockNumber;
      }
    }
  }

  const chains = Array.from(chainMap.values());
  const activeAll = mergedAssets.filter(
    (a) =>
      a.action === 'WITHDRAW_AND_BRIDGE' ||
      a.action === 'SELL_AND_BRIDGE' ||
      a.action === 'BRIDGE_DIRECT_USDC'
  );
  const grossUsd = round2(activeAll.reduce((s, a) => s + a.grossUsd, 0));
  const defiGrossUsd = round2(
    activeAll.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').reduce((s, a) => s + a.grossUsd, 0)
  );
  const liquidGrossUsd = round2(grossUsd - defiGrossUsd);
  const singleTxGasUsd = round2(mergedAssets.reduce((s, a) => s + a.estimatedGasUsd, 0));
  const batchedGasUsd = round2(mergedAssets.reduce((s, a) => s + a.batchedGasUsd, 0));
  const gasSavedUsd = round2(Math.max(0, singleTxGasUsd - batchedGasUsd));
  const estimatedSlippageUsd = round2(activeAll.reduce((s, a) => s + a.estimatedSlippageUsd, 0));
  const protocolFeeUsd = round2(
    (Math.max(0, grossUsd - estimatedSlippageUsd) * PROTOCOL_FEE_BPS) / 10_000
  );
  const netSolanaUsdc = round2(
    Math.max(0, grossUsd - estimatedSlippageUsd - batchedGasUsd - protocolFeeUsd)
  );

  const primaryWallet = unifiedWallets.find((w) => !w.error) || unifiedWallets[0];
  const combinedAddresses = unifiedWallets.map((w) => w.address).join(',');
  const familiesPresent = Array.from(new Set(unifiedWallets.map((w) => w.family)));

  const report: ScanReport = {
    scanId: `scan_unified_${crypto.randomBytes(5).toString('hex')}`,
    family: familiesPresent.length === 1 ? familiesPresent[0] : 'evm',
    unifiedWallets,
    mode: primaryMode,
    walletAddress: unifiedWallets.length === 1 ? primaryWallet.address : combinedAddresses,
    walletLabel:
      unifiedWallets.length === 1
        ? primaryWallet.label
        : `Unified (${unifiedWallets.length} wallets · ${familiesPresent.length} ecosystem${familiesPresent.length > 1 ? 's' : ''})`,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    chainsScanned: chains.length,
    chains,
    assets: mergedAssets,
    totals: {
      grossUsd,
      defiGrossUsd,
      liquidGrossUsd,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      protocolFeeUsd,
      singleTxGasUsd,
      batchedGasUsd,
      gasSavedUsd,
      estimatedSlippageUsd,
      netSolanaUsdc,
      solEquivalent: solPriceUsd > 0 ? round4(netSolanaUsdc / solPriceUsd) : 0,
      solPriceUsd: round2(solPriceUsd),
      defiPositionCount: mergedAssets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').length,
      liquidDustCount: mergedAssets.filter(
        (a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC'
      ).length,
      burnCandidateCount: mergedAssets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY').length,
      honeypotSkippedCount: mergedAssets.filter((a) => a.action === 'SKIP_HONEYPOT').length,
      gasNegativeCount: mergedAssets.filter(
        (a) => a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI'
      ).length,
    },
    warnings: Array.from(new Set(warnings)),
  };

  return applyTwoLevelRoiToReport(report, { hasSolanaUsdcAta: params.hasSolanaUsdcAta });
}
