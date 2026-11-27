import type { ScannedAsset } from './types.js';

export type DefiDisplayCategory =
  | 'one_click'
  | 'instant_swap'
  | 'debt_guard'
  | 'cooldown'
  | 'external_app';

export interface DefiDisplayMetadata {
  protocolGroup: string;
  category: DefiDisplayCategory;
  badgeIcon: string;
  badgeText: string;
  requiresTwoStep: boolean;
  signaturesRequired: number;
  sigLabel: string;
  plainRouteSummary: string;
}

function deriveProtocolGroup(
  asset: Pick<ScannedAsset, 'protocol' | 'symbol' | 'name' | 'defiExitPlan'>
): string {
  const plan = asset.defiExitPlan as Record<string, unknown> | undefined;
  const raw = String(plan?.protocolName || plan?.protocol || asset.protocol || '').trim();
  const low = raw.toLowerCase();
  if (low.includes('aave')) return 'Aave v3';
  if (low.includes('compound')) return 'Compound v3';
  if (low.includes('morpho')) return 'Morpho / Vaults';
  if (low.includes('lido')) return 'Lido';
  if (low.includes('uniswap')) return 'Uniswap LP';
  if (low.includes('curve')) return 'Curve';
  if (low.includes('spark')) return 'Spark Vaults';
  if (low.includes('sky')) return 'Sky Vaults';
  if (low.includes('neverland')) return 'Neverland';
  if (low.includes('hyperlend')) return 'Hyperlend';
  if (low.includes('sparklend')) return 'SparkLend';
  if (low.includes('seamless')) return 'Seamless';
  if (low.includes('lendle')) return 'Lendle';
  if (low.includes('ethena')) return 'Ethena Vaults';
  if (low.includes('erc-4626') || low.includes('erc4626') || low === 'vault') return 'Morpho / Vaults';
  if (low.includes('pendle')) return 'Pendle';
  if (low.includes('fluid')) return 'Fluid';
  if (low.includes('beefy')) return 'Beefy';
  if (low.includes('convex')) return 'Convex';
  if (low.includes('yearn')) return 'Yearn';
  if (low.includes('aerodrome')) return 'Aerodrome';
  if (low.includes('cosmos')) return 'Cosmos Staking';
  if (low.includes('sui')) return 'Sui Staking';
  return raw || 'DeFi Vaults';
}

/**
 * Computes canonical plain-English DeFi display metadata on the backend so Web UI,
 * MCP tools, ChatGPT Actions, and TypeScript SDK all share one single source of truth.
 */
export function computeDefiDisplayMetadata(
  asset: Pick<
    ScannedAsset,
    | 'chain'
    | 'family'
    | 'symbol'
    | 'name'
    | 'uiBalance'
    | 'protocol'
    | 'underlyingSymbol'
    | 'aaveDebtUsd'
    | 'defiDebtUsd'
    | 'defiUnlockAt'
    | 'stakedExitMode'
    | 'defiExitPlan'
  >,
  targetOut: 'USDC' | 'SOL' = 'USDC'
): DefiDisplayMetadata {
  const plan = (asset.defiExitPlan ?? null) as Record<string, unknown> | null;
  const protocolGroup = deriveProtocolGroup(asset);
  const protoLow = protocolGroup.toLowerCase();
  const modeRaw = String(
    plan?.exitStrategy ?? plan?.routeKind ?? plan?.mode ?? plan?.exitMode ?? plan?.strategy ?? ''
  ).toLowerCase();
  const statusRaw = String(plan?.preflightStatus ?? plan?.status ?? plan?.healthStatus ?? '').toLowerCase();

  const debtUsd = Number(asset.aaveDebtUsd || asset.defiDebtUsd || plan?.debtUsd || 0);
  const unlockAt = Number(asset.defiUnlockAt || plan?.unlockAt || 0);
  const isExternalApp = Boolean(
    plan?.protocolId === 'external_protocol' ||
      plan?.exitStrategy === 'external_app_exit' ||
      plan?.routeKind === 'external_app'
  );
  const hasDebt = Boolean(
    plan?.debtGuardActive || modeRaw.includes('debt') || modeRaw.includes('partial') || debtUsd > 0
  );
  const explicitSwapStrategy = Boolean(
    modeRaw.includes('direct_swap') ||
      modeRaw.includes('instant_dex_swap') ||
      modeRaw.includes('swap') ||
      asset.stakedExitMode === 'instant_liquid_stake'
  );
  const hasCooldown = Boolean(
    !explicitSwapStrategy &&
      (plan?.cooldownDetected ||
        modeRaw.includes('cooldown') ||
        modeRaw.includes('unbonding') ||
        modeRaw.includes('lock') ||
        modeRaw.includes('unstake') ||
        statusRaw === 'cooldown' ||
        statusRaw === 'locked' ||
        unlockAt > Math.floor(Date.now() / 1000) ||
        asset.stakedExitMode === 'native_unstake' ||
        asset.stakedExitMode === 'scheduled_authz_autosweep')
  );
  const isInstantSwap = Boolean(explicitSwapStrategy || (!hasCooldown && protoLow.includes('lido')));

  let category: DefiDisplayCategory = 'one_click';
  if (hasCooldown) category = 'cooldown';
  else if (hasDebt) category = 'debt_guard';
  else if (isInstantSwap) category = 'instant_swap';
  else if (isExternalApp) category = 'external_app';

  const badges: Record<DefiDisplayCategory, { icon: string; text: string }> = {
    one_click: { icon: 'zap', text: '1-Click Extract → Solana' },
    instant_swap: { icon: 'refresh-cw', text: 'Instant Swap (Skips Cooldown)' },
    debt_guard: isExternalApp
      ? { icon: 'shield-alert', text: 'Active Borrow · Protocol App' }
      : { icon: 'shield-check', text: 'Safe Partial (Debt Guard)' },
    cooldown: { icon: 'clock', text: 'Cooldown / Locked' },
    external_app: { icon: 'external-link', text: 'Protocol App Position' },
  };

  const underlyingSym = String(plan?.underlyingSymbol || asset.underlyingSymbol || asset.symbol || 'USDC');
  const isNonUsdcContractExit =
    category === 'one_click' &&
    !isInstantSwap &&
    underlyingSym.toUpperCase() !== 'USDC' &&
    asset.family !== 'cosmos' &&
    asset.family !== 'sui';
  const requiresTwoStep = Boolean(
    plan?.requiresSecondStep || plan?.twoStep || plan?.requiresFollowUpBridge || isNonUsdcContractExit
  );
  const signaturesRequired =
    typeof plan?.signaturesRequired === 'number'
      ? plan.signaturesRequired
      : typeof plan?.signatureCount === 'number'
        ? plan.signatureCount
        : requiresTwoStep || category === 'cooldown'
          ? 2
          : 1;
  const sigLabel = signaturesRequired <= 1 ? '1 signature' : `${signaturesRequired} guided steps`;

  const chainLabel = asset.chain.charAt(0).toUpperCase() + asset.chain.slice(1);
  const balFmt =
    asset.uiBalance >= 1000
      ? asset.uiBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : asset.uiBalance.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const plainRouteSummary = `${protocolGroup} (${chainLabel}) · ${balFmt} ${underlyingSym} → Solana ${targetOut} · ${sigLabel}`;

  return {
    protocolGroup,
    category,
    badgeIcon: badges[category].icon,
    badgeText: badges[category].text,
    requiresTwoStep,
    signaturesRequired,
    sigLabel,
    plainRouteSummary,
  };
}
