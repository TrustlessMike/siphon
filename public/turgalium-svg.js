function escapeXml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeInt(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function safeNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function prefersReducedMotion() {
  return Boolean(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function shortSol(addr) {
  const s = String(addr || '').trim();
  if (!s) return 'Not set';
  if (s.length <= 12) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Strict static allowlist of Lucide-style 24x24 UI stroke SVG icons.
 * Rendered inline so they inherit CSS `currentColor` cleanly across dark obsidian & badges.
 */
const UI_ICON_PATHS = Object.freeze({
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'shield-check':
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  'shield-alert':
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  'alert-triangle':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'activity-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  wallet:
    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sliders:
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'external-link':
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
});

export function renderTurgaliumUiIcon(name, size = 14) {
  const key = String(name || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(UI_ICON_PATHS, key)) {
    return '';
  }
  const n = Number(size);
  const px = Number.isFinite(n) ? Math.min(48, Math.max(10, Math.round(n))) : 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="tg-ui-icon tg-ui-icon-${key}">${UI_ICON_PATHS[key]}</svg>`;
}

export const renderUiIcon = renderTurgaliumUiIcon;

if (typeof window !== 'undefined') {
  window.renderTurgaliumUiIcon = renderTurgaliumUiIcon;
}

const CHAIN_ACCENTS = {
  ethereum: '#18181B',
  base: '#0052FF',
  arbitrum: '#2563EB',
  optimism: '#DC2626',
  polygon: '#7C3AED',
  avalanche: '#E84142',
  bnb: '#D97706',
  sonic: '#0284C7',
  unichain: '#EC4899',
  linea: '#18181B',
  scroll: '#B45309',
  mantle: '#0F766E',
  blast: '#CA8A04',
  worldchain: '#111827',
  hyperevm: '#0F766E',
  berachain: '#92400E',
  zksync: '#1E3A8A',
  ink: '#6D28D9',
  gnosis: '#047857',
  monad: '#836EF9',
  cosmoshub: '#312E81',
  osmosis: '#7E22CE',
  noble: '#1D4ED8',
  celestia: '#7C3AED',
  injective: '#0284C7',
  neutron: '#18181B',
  sui: '#2563EB',
  aptos: '#0F172A',
  ton: '#0098EA',
  tron: '#DC2626',
  btc: '#F7931A',
};

const ALLOWED_LOGO_SLUGS = new Set([
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
  'bnb',
  'sonic',
  'unichain',
  'linea',
  'scroll',
  'mantle',
  'blast',
  'worldchain',
  'hyperevm',
  'berachain',
  'zksync',
  'ink',
  'gnosis',
  'monad',
  'cosmos',
  'osmosis',
  'celestia',
  'noble',
  'injective',
  'neutron',
  'sui',
  'aptos',
  'ton',
  'tron',
  'btc',
  'solana',
  'mayan',
  'debridge',
  'skip',
  'circle',
  'relay',
  'lifi',
]);

function chainLogoForSvg(chain) {
  const c = String(chain || '').toLowerCase();
  if (c === 'cosmoshub' || c === 'cosmos') {
    return '/logos/cosmos.svg';
  }
  if (ALLOWED_LOGO_SLUGS.has(c)) {
    return `/logos/${c}.svg`;
  }
  return '/logos/ethereum.svg';
}

function bridgeMetaForSvg(preference, activeLegCount) {
  const pref = String(preference || 'auto').toLowerCase();
  const suffix = `${activeLegCount} leg(s)`;
  if (pref === 'cctp' || pref === 'circle' || pref === 'noble_cctp') {
    return {
      logo: '/logos/circle.svg',
      title: 'Circle CCTP 1:1',
      sub: `Domain 5 · ${suffix}`,
    };
  }
  if (pref === 'mayan' || pref === 'mayan_swift') {
    return {
      logo: '/logos/mayan.svg',
      title: 'Mayan Swift',
      sub: `Auction fill · ${suffix}`,
    };
  }
  if (pref === 'debridge' || pref === 'debridge_dln') {
    return {
      logo: '/logos/debridge.svg',
      title: 'deBridge DLN',
      sub: `Solver fill · ${suffix}`,
    };
  }
  if (pref === 'skip' || pref === 'skip_go') {
    return {
      logo: '/logos/skip.svg',
      title: 'Skip Go IBC',
      sub: `Smart relay · ${suffix}`,
    };
  }
  if (pref === 'lifi') {
    return {
      logo: '/logos/lifi.svg',
      title: 'LI.FI Router',
      sub: `Aggregator · ${suffix}`,
    };
  }
  if (pref === 'relay') {
    return {
      logo: '/logos/relay.svg',
      title: 'Relay Bridge',
      sub: `~2s fill · ${suffix}`,
    };
  }
  return {
    logo: '/logos/relay.svg',
    title: 'Auto Route Auction',
    sub: `Best fill · ${suffix}`,
  };
}

/**
 * Turgalium Daylight Editorial SVG Multi-Chain Convergence Flow with real chain,
 * bridge provider, protocol treasury fee, and Solana destination logos.
 */
export function renderConvergenceSvg(plan, scan) {
  const activeLegs = Array.isArray(plan?.legs) ? plan.legs : [];
  const totals = plan?.totals || {};
  const reducedMotion = prefersReducedMotion();
  const totalChains = Math.max(1, activeLegs.length);
  const rowH = 56;
  const height = Math.max(316, totalChains * rowH + 48);
  const width = 1060;

  const col1X = 24;
  const col1W = 204;
  const col2X = 326;
  const col2W = 196;
  const col3X = 602;
  const col3W = 178;
  const col4X = 836;
  const col4W = 200;

  const leftStartY = (height - activeLegs.length * rowH) / 2;

  const defiWithdrawnCount = safeInt(totals.defiWithdrawnCount);
  const tokensSoldCount = safeInt(totals.tokensSoldCount);
  const tokensBurnedCount = safeInt(totals.tokensBurnedCount);
  const honeypotsSkippedCount = safeInt(totals.honeypotsSkippedCount);
  const outAsset = plan?.outputAsset === 'SOL' ? 'SOL' : 'USDC';

  const lanes = [
    {
      id: 'defi',
      title: 'DeFi Withdraw',
      sub: `${defiWithdrawnCount} contract exit(s)`,
      y: height * 0.2 - 26,
      bar: '#059669',
      active: defiWithdrawnCount > 0,
    },
    {
      id: 'swap',
      title: `Swap & Route → ${outAsset}`,
      sub: `${tokensSoldCount} liquid asset(s)`,
      y: height * 0.49 - 26,
      bar: '#0A0A0A',
      active: tokensSoldCount > 0,
    },
    {
      id: 'burn',
      title: 'Safe Burn 0x…dEaD',
      sub: `${tokensBurnedCount} dead · ${honeypotsSkippedCount} skipped`,
      y: height * 0.79 - 26,
      bar: '#DC2626',
      active: tokensBurnedCount > 0,
    },
  ];

  const effectiveFeeRaw = Number.isFinite(Number(totals.effectiveProtocolFeeUsd))
    ? safeNum(totals.effectiveProtocolFeeUsd)
    : safeNum(totals.protocolFeeUsd);
  const cctpY = height * 0.34 - 29;
  const solY = effectiveFeeRaw > 0 ? height * 0.27 - 32 : cctpY - 3;
  const feeY = height * 0.56 - 26;
  const burnSinkY = height * 0.79 - 26;

  const defsPaths = [];
  const edges = [];

  // Chain -> Lane edges
  activeLegs.forEach((leg, idx) => {
    const cy = leftStartY + idx * rowH + 23;
    const x1 = col1X + col1W;
    const legDefi = safeInt(leg.defiExits);
    const legSwaps = safeInt(leg.swaps);
    const legBurns = safeInt(leg.burns);
    const legBridged = safeNum(leg.bridgedUsdc);

    if (legDefi > 0) {
      const target = lanes[0];
      const d = `M ${x1} ${cy} C ${x1 + 48} ${cy}, ${col2X - 48} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_defi_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#9CA3AF" stroke-width="1.25" marker-end="url(#siphArrow)" />
        ${reducedMotion ? '' : `<circle r="2.1" fill="#059669"><animateMotion dur="2.8s" repeatCount="indefinite" begin="-${(idx * 0.42).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion></circle>`}
      `);
    }

    if (legSwaps > 0 || (legBridged > 0 && legDefi === 0)) {
      const target = lanes[1];
      const d = `M ${x1} ${cy} C ${x1 + 48} ${cy}, ${col2X - 48} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_swap_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#9CA3AF" stroke-width="1.25" marker-end="url(#siphArrow)" />
        ${reducedMotion ? '' : `<circle r="2.1" fill="#0A0A0A"><animateMotion dur="2.5s" repeatCount="indefinite" begin="-${(idx * 0.35 + 0.2).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion></circle>`}
      `);
    }

    if (legBurns > 0) {
      const target = lanes[2];
      const d = `M ${x1} ${cy} C ${x1 + 48} ${cy}, ${col2X - 48} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_burn_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#FCA5A5" stroke-width="1.15" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />
      `);
    }
  });

  // Lane -> Bridge -> Solana + Fee Vault edges
  const l1d = `M ${col2X + col2W} ${lanes[0].y + 26} C ${col2X + col2W + 38} ${lanes[0].y + 26}, ${col3X - 38} ${cctpY + 29}, ${col3X - 4} ${cctpY + 29}`;
  const l2d = `M ${col2X + col2W} ${lanes[1].y + 26} C ${col2X + col2W + 38} ${lanes[1].y + 26}, ${col3X - 38} ${cctpY + 29}, ${col3X - 4} ${cctpY + 29}`;
  const c2s = `M ${col3X + col3W} ${cctpY + 24} C ${col3X + col3W + 26} ${cctpY + 24}, ${col4X - 26} ${solY + 32}, ${col4X - 4} ${solY + 32}`;
  const c2f = `M ${col3X + col3W} ${cctpY + 38} C ${col3X + col3W + 26} ${cctpY + 38}, ${col4X - 26} ${feeY + 26}, ${col4X - 4} ${feeY + 26}`;
  const b2d = `M ${col2X + col2W} ${lanes[2].y + 26} L ${col3X - 4} ${burnSinkY + 26}`;

  defsPaths.push(`<path id="p_l1" d="${l1d}" />`, `<path id="p_l2" d="${l2d}" />`, `<path id="p_c2s" d="${c2s}" />`);

  if (lanes[0].active) {
    edges.push(`
      <path d="${l1d}" fill="none" stroke="#059669" stroke-width="1.5" marker-end="url(#siphArrow)" />
      ${reducedMotion ? '' : `<circle r="2.3" fill="#059669"><animateMotion dur="2.1s" repeatCount="indefinite" begin="-0.4s"><mpath href="#p_l1" /></animateMotion></circle>`}
    `);
  }
  if (lanes[1].active) {
    edges.push(`
      <path d="${l2d}" fill="none" stroke="#0A0A0A" stroke-width="1.5" marker-end="url(#siphArrow)" />
      ${reducedMotion ? '' : `<circle r="2.3" fill="#0A0A0A"><animateMotion dur="2.0s" repeatCount="indefinite" begin="-0.9s"><mpath href="#p_l2" /></animateMotion></circle>`}
    `);
  }
  edges.push(`
    <path d="${c2s}" fill="none" stroke="#0284C7" stroke-width="2" marker-end="url(#siphArrowIce)" />
    ${reducedMotion ? '' : `<circle r="2.6" fill="#0284C7"><animateMotion dur="1.6s" repeatCount="indefinite" begin="-0.3s"><mpath href="#p_c2s" /></animateMotion></circle>`}
  `);
  if (effectiveFeeRaw > 0) {
    edges.push(
      `<path d="${c2f}" fill="none" stroke="#6B7280" stroke-width="1.25" stroke-dasharray="3 2.5" marker-end="url(#siphArrow)" />`
    );
  }
  if (lanes[2].active) {
    edges.push(`<path d="${b2d}" fill="none" stroke="#DC2626" stroke-width="1.2" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />`);
  }

  // Render Chain Nodes with real official chain logos
  const chainNodes = activeLegs
    .map((leg, idx) => {
      const y = leftStartY + idx * rowH;
      const bar = CHAIN_ACCENTS[leg.chain] || '#0A0A0A';
      const legItems = safeInt(leg.defiExits) + safeInt(leg.swaps) + safeInt(leg.burns);
      const legBridgedStr = safeNum(leg.bridgedUsdc).toLocaleString(undefined, { minimumFractionDigits: 2 });
      return `
        <g transform="translate(${col1X}, ${y})">
          <rect width="${col1W}" height="46" rx="10" fill="#FFFFFF" stroke="#E4E6EB" />
          <rect width="3.5" height="46" rx="1.75" fill="${bar}" />
          <image href="${escapeXml(chainLogoForSvg(leg.chain))}" x="13" y="13" width="20" height="20" />
          <text x="41" y="20" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="#0A0A0A">${escapeXml(leg.chainName)}</text>
          <text x="41" y="36" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#52525B">$${escapeXml(legBridgedStr)} · ${legItems} items</text>
        </g>
      `;
    })
    .join('');

  // Render Lane Nodes
  const laneNodes = lanes
    .map(
      (l) => `
      <g transform="translate(${col2X}, ${l.y})">
        <rect width="${col2W}" height="52" rx="10" fill="${l.active ? '#FFFFFF' : '#F8F9FB'}" stroke="${l.active ? '#D1D5DB' : '#E4E6EB'}" />
        <rect width="3.5" height="52" rx="1.75" fill="${l.active ? l.bar : '#D1D5DB'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="${l.active ? '#0A0A0A' : '#71717A'}">${escapeXml(l.title)}</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10.5" fill="${l.active ? '#52525B' : '#A1A1AA'}">${escapeXml(l.sub)}</text>
      </g>
    `
    )
    .join('');

  const netUsdcVal = Number.isFinite(Number(totals.effectiveNetSolanaUsdc))
    ? safeNum(totals.effectiveNetSolanaUsdc)
    : safeNum(totals.netSolanaUsdc);
  const netSolVal = Number.isFinite(Number(totals.effectiveNetSolanaSol))
    ? safeNum(totals.effectiveNetSolanaSol)
    : safeNum(totals.netSolanaSol);

  const outputLabel =
    outAsset === 'SOL'
      ? `${netSolVal.toFixed(2)} SOL`
      : `$${netUsdcVal.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`;

  const bridgeMeta = bridgeMetaForSvg(plan?.bridgePreference || plan?.routeWinner || 'auto', activeLegs.length);

  const feePctLabel = plan?.effectiveFeeLabel
    ? String(plan.effectiveFeeLabel)
    : `${Number.isFinite(Number(plan?.protocolFeePercent)) ? Number(plan.protocolFeePercent) : 0}%`;
  const feeUsd = effectiveFeeRaw.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const feeDestShort = plan?.feeRecipientEvm
    ? `${String(plan.feeRecipientEvm).slice(0, 6)}…${String(plan.feeRecipientEvm).slice(-4)}`
    : 'Fee Vault';

  return `
    <svg id="turgaliumFlowSvg" role="img" aria-label="Multi-chain convergence topology to Solana" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="width:100%; min-width:720px; height:auto; display:block;">
      <defs>
        <pattern id="siphGrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#E5E7EB" />
        </pattern>
        <marker id="siphArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#6B7280" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        <marker id="siphArrowIce" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#0284C7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        <marker id="siphArrowRed" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#DC2626" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        ${defsPaths.join('')}
      </defs>

      <rect width="${width}" height="${height}" rx="14" fill="#FCFCFC" />
      <rect width="${width}" height="${height}" rx="14" fill="url(#siphGrid)" />
      ${edges.join('')}
      ${chainNodes}
      ${laneNodes}

      <!-- Stage 3: Active Bridge Provider -->
      <g transform="translate(${col3X}, ${cctpY})">
        <rect width="${col3W}" height="58" rx="10" fill="#FFFFFF" stroke="#0A0A0A" stroke-width="1.25" />
        <image href="${escapeXml(bridgeMeta.logo)}" x="12" y="18" width="22" height="22" />
        <text x="42" y="24" font-family="Inter, sans-serif" font-size="12.5" font-weight="700" fill="#0A0A0A">${escapeXml(bridgeMeta.title)}</text>
        <text x="42" y="42" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#52525B">${escapeXml(bridgeMeta.sub)}</text>
      </g>

      <!-- Burn Sink Receipt -->
      <g transform="translate(${col3X}, ${burnSinkY})">
        <rect width="${col3W}" height="52" rx="10" fill="${lanes[2].active ? '#FEF2F2' : '#F8F9FB'}" stroke="${lanes[2].active ? '#FECACA' : '#E4E6EB'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${lanes[2].active ? '#991B1B' : '#71717A'}">0x000…dEaD</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10" fill="${lanes[2].active ? '#DC2626' : '#A1A1AA'}">${tokensBurnedCount} burned · Receipt CSV</text>
      </g>

      <!-- Stage 4A: Solana Destination -->
      <g transform="translate(${col4X}, ${solY})">
        <rect width="${col4W}" height="64" rx="12" fill="#E8FAFF" stroke="#7DD3FC" stroke-width="1.5" />
        <image href="/logos/solana.svg" x="12" y="12" width="18" height="18" />
        <text x="36" y="25" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#0369A1">Solana · ${escapeXml(shortSol(plan?.solanaDestination))}</text>
        <text x="14" y="49" font-family="JetBrains Mono, monospace" font-size="13.2" font-weight="700" fill="#0A0A0A">${escapeXml(outputLabel)}</text>
      </g>

      ${
        effectiveFeeRaw > 0
          ? `<!-- Stage 4B: Protocol Treasury Fee Vault -->
      <g transform="translate(${col4X}, ${feeY})">
        <rect width="${col4W}" height="52" rx="10" fill="#FFFFFF" stroke="#E4E6EB" />
        <image href="/logos/turgalium.svg" x="12" y="16" width="18" height="18" />
        <text x="36" y="22" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#0A0A0A">Fee (${escapeXml(feePctLabel)}) · ${escapeXml(feeDestShort)}</text>
        <text x="36" y="39" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#52525B">$${escapeXml(feeUsd)} → Treasury</text>
      </g>`
          : ''
      }
    </svg>
  `;
}

const HERO_CHAINS = Object.freeze([
  // Left Hemisphere — EVM Ecosystem (6 flagships + 14 satellites = 20 EVMs)
  { id: 'ethereum', name: 'Ethereum', group: 'evm', angle: -106, color: '#818CF8', labelPos: 'top', route: 'Ethereum → Solana' },
  { id: 'base', name: 'Base', group: 'evm', angle: -134, color: '#3B82F6', labelPos: 'top-left', route: 'Base → Solana' },
  { id: 'arbitrum', name: 'Arbitrum', group: 'evm', angle: -164, color: '#12AAFF', labelPos: 'left', route: 'Arbitrum → Solana' },
  { id: 'optimism', name: 'Optimism', group: 'evm', angle: 164, color: '#FF4D5E', labelPos: 'left', route: 'Optimism → Solana' },
  { id: 'polygon', name: 'Polygon', group: 'evm', angle: 134, color: '#A46BFF', labelPos: 'bottom-left', route: 'Polygon → Solana' },
  { id: 'bnb', name: 'BNB', group: 'evm', angle: 106, color: '#F0B90B', labelPos: 'bottom', route: 'BNB Chain → Solana' },

  // Right Hemisphere — Non-EVM Ecosystems (all 6 non-EVM families)
  { id: 'btc', name: 'Bitcoin', group: 'btc', angle: -74, color: '#F7931A', labelPos: 'top', route: 'Bitcoin → Solana' },
  { id: 'cosmos', name: 'Cosmos', group: 'cosmos', angle: -46, color: '#D46BF0', labelPos: 'top-right', route: 'Cosmos IBC → Solana' },
  { id: 'sui', name: 'Sui', group: 'sui', angle: -16, color: '#4BA2FF', labelPos: 'right', route: 'Sui → Solana' },
  { id: 'aptos', name: 'Aptos', group: 'aptos', angle: 16, color: '#E5E7EB', labelPos: 'right', route: 'Aptos → Solana' },
  { id: 'ton', name: 'TON', group: 'ton', angle: 46, color: '#29B6F6', labelPos: 'bottom-right', route: 'TON → Solana' },
  { id: 'tron', name: 'Tron', group: 'tron', angle: 74, color: '#FF5247', labelPos: 'bottom', route: 'Tron → Solana' },
]);

// Launch order for the intro + flow waves: clockwise from the top.
const HERO_LAUNCH_ORDER = Object.freeze([
  'ethereum', 'btc', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'bnb', 'polygon', 'optimism', 'arbitrum', 'base',
]);

const HERO_EVM_SATELLITES = Object.freeze([
  { deg: -113, color: '#E84142' },
  { deg: -120, color: '#836EF9' },
  { deg: -127, color: '#38BDF8' },
  { deg: -141, color: '#EC4899' },
  { deg: -149, color: '#A1A1AA' },
  { deg: -157, color: '#F59E0B' },
  { deg: -172, color: '#2DD4BF' },
  { deg: 172, color: '#FACC15' },
  { deg: 157, color: '#94A3B8' },
  { deg: 149, color: '#34D399' },
  { deg: 141, color: '#FB923C' },
  { deg: 127, color: '#60A5FA' },
  { deg: 120, color: '#A78BFA' },
  { deg: 113, color: '#10B981' },
]);

const HERO_CX = 340;
const HERO_CY = 232;
const HERO_CORE_R = 39;
const HERO_TRAIL = 38;

const HERO_LABEL_OFFSETS = Object.freeze({
  top: [0, -30, 'middle'],
  bottom: [0, 37, 'middle'],
  left: [-29, 4, 'end'],
  right: [29, 4, 'start'],
  'top-left': [-25, -14, 'end'],
  'top-right': [25, -14, 'start'],
  'bottom-left': [-25, 21, 'end'],
  'bottom-right': [25, 21, 'start'],
});

/**
 * Static markup = the finished composition (every chain connected to Solana).
 * GSAP only animates on top of it, so reduced-motion users and a failed GSAP
 * load still get the complete graphic.
 */
function buildHeroSvgMarkup() {
  const CX = HERO_CX;
  const CY = HERO_CY;
  const RX = 232;
  const RY = 158;
  const NODE_R = 20.5;

  const sats = HERO_EVM_SATELLITES.map(({ deg, color }) => {
    const rad = (deg * Math.PI) / 180;
    const sx = CX + Math.cos(rad) * (RX + 14);
    const sy = CY + Math.sin(rad) * (RY + 10);
    return `<circle class="tg-hero-sat" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2.4" fill="${color}" fill-opacity="0.9" stroke="#07070B" stroke-width="0.8" />`;
  });

  const dynDefs = [];
  const conduits = [];
  const pulses = [];
  const ripples = [];
  const nodes = [];

  for (const chain of HERO_CHAINS) {
    const rad = (chain.angle * Math.PI) / 180;
    const x0 = CX + Math.cos(rad) * RX;
    const y0 = CY + Math.sin(rad) * RY;
    const dx = x0 - CX;
    const dy = y0 - CY;

    const c1x = CX + dx * 0.62;
    const c1y = CY + dy * 0.84;
    const c2x = CX + dx * 0.34;
    const c2y = CY + dy * 0.24;

    const endLen = Math.hypot(dx, dy);
    const ex = CX + (dx / endLen) * 50;
    const ey = CY + (dy / endLen) * 50;

    const exitAngle = Math.atan2(c1y - y0, c1x - x0);
    const sx = x0 + Math.cos(exitAngle) * NODE_R;
    const sy = y0 + Math.sin(exitAngle) * NODE_R;

    const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    const gradId = `tg-hero-grad-${chain.id}`;
    const tokId = `tg-hero-tok-${chain.id}`;
    const attrs = `data-hero-chain="${chain.id}" data-hero-group="${chain.group}"`;

    dynDefs.push(`
      <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}">
        <stop offset="0%" stop-color="${chain.color}" />
        <stop offset="100%" stop-color="#14F195" />
      </linearGradient>
      <radialGradient id="${tokId}">
        <stop offset="0%" stop-color="${chain.color}" stop-opacity="0.95" />
        <stop offset="45%" stop-color="${chain.color}" stop-opacity="0.38" />
        <stop offset="100%" stop-color="${chain.color}" stop-opacity="0" />
      </radialGradient>
    `);

    conduits.push(`<path d="${d}" class="tg-hero-conduit-base" ${attrs} />`);
    conduits.push(`<path d="${d}" stroke="url(#${gradId})" class="tg-hero-conduit-flow" ${attrs} />`);

    // Motion layer: hidden until GSAP drives it.
    pulses.push(`
      <g class="tg-hero-pulse" ${attrs}>
        <path d="${d}" class="tg-hero-flash" fill="none" stroke="url(#${gradId})" stroke-width="4.5" stroke-linecap="round" opacity="0" />
        <path d="${d}" class="tg-hero-trail-glow" fill="none" stroke="${chain.color}" stroke-width="5" stroke-linecap="round" stroke-opacity="0.28" opacity="0" />
        <path d="${d}" class="tg-hero-trail" fill="none" stroke="${chain.color}" stroke-width="2" stroke-linecap="round" opacity="0" />
        <g class="tg-hero-token" opacity="0">
          <circle r="9" fill="url(#${tokId})" />
          <circle r="2.4" fill="#FFFFFF" />
        </g>
      </g>
    `);
    ripples.push(
      `<circle class="tg-hero-ripple" ${attrs} cx="${CX}" cy="${CY}" r="${HERO_CORE_R + 9}" fill="none" stroke="${chain.color}" stroke-width="1.4" opacity="0" />`
    );

    const [lx, ly, anchor] = HERO_LABEL_OFFSETS[chain.labelPos] || HERO_LABEL_OFFSETS.top;

    nodes.push(`
      <g class="tg-hero-node" ${attrs} transform="translate(${x0.toFixed(1)}, ${y0.toFixed(1)})" tabindex="0" role="button" aria-label="${escapeXml(chain.route)}">
        <g class="tg-hero-node-body">
          <circle r="26.5" fill="${chain.color}" fill-opacity="0.16" stroke="${chain.color}" stroke-opacity="0.6" stroke-width="1" class="tg-hero-node-ring" />
          <circle r="${NODE_R}" fill="#FFFFFF" stroke="${chain.color}" stroke-opacity="0" stroke-width="1.6" class="tg-hero-node-disc" />
          <g transform="translate(-10, -10) scale(0.8333)"><use href="#tg-hero-icon-${chain.id}" /></g>
        </g>
        <text x="${lx}" y="${ly}" text-anchor="${anchor}" class="tg-hero-node-label">${escapeXml(chain.name)}</text>
      </g>
    `);
  }

  return `
    <svg id="turgaliumHeroSvg" class="tg-hero-svg" viewBox="0 0 680 468" role="img" aria-label="Multi-chain convergence to Solana: 20 EVM chains, Bitcoin, Cosmos, Sui, Aptos, TON, and Tron flowing home to Solana" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="tg-hero-bg" cx="50%" cy="48%" r="62%">
          <stop offset="0%" stop-color="#161629" />
          <stop offset="55%" stop-color="#0A0A12" />
          <stop offset="100%" stop-color="#07070B" />
        </radialGradient>
        <pattern id="tg-hero-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.85" fill="#2A2A3C" />
        </pattern>
        <radialGradient id="tg-hero-grid-fade" cx="50%" cy="50%" r="56%">
          <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.9" />
          <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0" />
        </radialGradient>
        <mask id="tg-hero-grid-mask">
          <rect width="680" height="468" fill="url(#tg-hero-grid-fade)" />
        </mask>
        <radialGradient id="tg-hero-sol-bloom" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#14F195" stop-opacity="0.4" />
          <stop offset="40%" stop-color="#00C2FF" stop-opacity="0.15" />
          <stop offset="72%" stop-color="#9945FF" stop-opacity="0.05" />
          <stop offset="100%" stop-color="#9945FF" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="tg-hero-sol-spectrum" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#9945FF" />
          <stop offset="48%" stop-color="#00C2FF" />
          <stop offset="100%" stop-color="#14F195" />
        </linearGradient>
        <linearGradient id="tg-hero-sol-b1" x1="3" y1="6.5" x2="21" y2="6.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#00D4FF" />
          <stop offset="100%" stop-color="#14F195" />
        </linearGradient>
        <linearGradient id="tg-hero-sol-b2" x1="3" y1="12" x2="21" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#7B61FF" />
          <stop offset="100%" stop-color="#1FE4B5" />
        </linearGradient>
        <linearGradient id="tg-hero-sol-b3" x1="3" y1="17.5" x2="21" y2="17.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#B84DFF" />
          <stop offset="100%" stop-color="#38BDF8" />
        </linearGradient>
        <radialGradient id="tg-hero-core-fill" cx="38%" cy="26%" r="74%">
          <stop offset="0%" stop-color="#2B2B36" />
          <stop offset="60%" stop-color="#0F0F16" />
          <stop offset="100%" stop-color="#050507" />
        </radialGradient>
        <linearGradient id="tg-hero-poly-g" x1="3" y1="17" x2="20" y2="7" gradientUnits="userSpaceOnUse">
          <stop stop-color="#A726C1" />
          <stop offset="1" stop-color="#7B3FE4" />
        </linearGradient>
        ${dynDefs.join('')}
        <g id="tg-hero-icon-ethereum">
          <path fill="#8FFCF3" d="M12 3v6.651l5.625 2.516z" />
          <path fill="#CABCF8" d="m12 3-5.625 9.166L12 9.653z" />
          <path fill="#CBA7F5" d="M12 16.478V21l5.625-7.784z" />
          <path fill="#74A0F3" d="M12 21v-4.522l-5.625-3.262z" />
          <path fill="#CBA7F5" d="m12 15.43 5.625-3.263L12 9.652z" />
          <path fill="#74A0F3" d="M6.375 12.167 12 15.43V9.652z" />
          <path fill="#202699" fill-rule="evenodd" d="m12 15.43-5.625-3.263L12 3l5.624 9.166zm-5.252-3.528 5.161-8.41v6.114zm-.077.229 5.238-2.327v5.364zm5.418-2.327v5.364l5.234-3.037zm0-.198 5.161 2.296-5.161-8.41z" clip-rule="evenodd" />
          <path fill="#202699" fill-rule="evenodd" d="m12 16.406-5.625-3.195L12 21l5.624-7.79zm-4.995-2.633 4.904 2.79v4.005zm5.084 2.79v4.005l4.905-6.795z" clip-rule="evenodd" />
        </g>
        <g id="tg-hero-icon-base">
          <path fill="#0052FF" d="M11.985 21a9 9 0 1 0 0-18c-4.703 0-8.56 3.606-8.965 8.204h11.884v1.592H3.02c.405 4.598 4.262 8.204 8.965 8.204Z" />
        </g>
        <g id="tg-hero-icon-arbitrum">
          <path fill="#213147" d="M4.515 8.471v7.056c0 .45.245.867.64 1.092l6.205 3.529a1.3 1.3 0 0 0 1.28 0l6.203-3.53c.396-.224.64-.64.64-1.09V8.47c0-.45-.244-.867-.64-1.091L12.64 3.85a1.3 1.3 0 0 0-1.28 0L5.155 7.38a1.25 1.25 0 0 0-.639 1.091" />
          <path fill="#12AAFF" d="m13.353 13.368-.885 2.39a.3.3 0 0 0 0 .205l1.523 4.112 1.76-1.001-2.113-5.706a.152.152 0 0 0-.285 0m1.774-4.019a.152.152 0 0 0-.285 0l-.885 2.39a.3.3 0 0 0 0 .205l2.494 6.732 1.761-1.001z" />
          <path fill="#9DCCED" d="M11.998 4.115a.3.3 0 0 1 .126.033l6.715 3.818a.25.25 0 0 1 .126.214v7.635c0 .089-.048.17-.126.214l-6.715 3.819a.25.25 0 0 1-.126.032.3.3 0 0 1-.125-.032l-6.715-3.815a.25.25 0 0 1-.126-.215V8.182c0-.089.048-.17.126-.215l6.715-3.818a.26.26 0 0 1 .125-.034m0-1.115c-.238 0-.478.06-.692.183L4.593 7A1.36 1.36 0 0 0 3.9 8.182v7.635c0 .487.264.938.693 1.181l6.714 3.819a1.41 1.41 0 0 0 1.386 0l6.714-3.818a1.36 1.36 0 0 0 .693-1.182V8.182A1.36 1.36 0 0 0 19.407 7l-6.716-3.817A1.4 1.4 0 0 0 11.998 3" />
          <path fill="#FFFFFF" d="M11.433 7.635H9.731a.3.3 0 0 0-.285.197l-3.649 9.852 1.761 1.001 4.018-10.849a.15.15 0 0 0-.143-.2m2.979-.001h-1.703a.3.3 0 0 0-.284.197l-4.167 11.25 1.761 1 4.535-12.246a.15.15 0 0 0-.142-.2" />
        </g>
        <g id="tg-hero-icon-optimism">
          <path fill="#FE0420" fill-rule="evenodd" d="M3.966 15.8q.979.7 2.512.7 1.854 0 2.962-.838 1.108-.85 1.559-2.562.27-1.05.464-2.163.063-.398.064-.663 0-.874-.451-1.499a2.7 2.7 0 0 0-1.237-.95Q9.053 7.5 8.062 7.5q-3.644 0-4.52 3.437a40 40 0 0 0-.477 2.163q-.058.335-.065.674 0 1.314.966 2.026m4.65-2.775c-.247.957-.926 1.58-1.958 1.58-1.02 0-1.368-.69-1.184-1.58a27 27 0 0 1 .464-2.05c.265-1.034.89-1.58 1.956-1.58 1.017 0 1.348.68 1.173 1.58a30 30 0 0 1-.451 2.05m3.902 3.385q.076.09.214.089h1.704a.38.38 0 0 0 .238-.089.36.36 0 0 0 .138-.232l.538-2.52h1.733c1.094 0 1.95-.53 2.576-1.002q.953-.707 1.266-2.186.075-.348.075-.67 0-1.117-.851-1.71-.84-.591-2.23-.591h-3.333a.38.38 0 0 0-.238.09.38.38 0 0 0-.138.232l-1.73 8.356a.3.3 0 0 0 .038.232m6.09-5.966c-.157.689-.757 1.319-1.462 1.319h-1.44l.496-2.369h1.503c.512 0 .94.102.94.665q0 .165-.037.385" clip-rule="evenodd" />
        </g>
        <g id="tg-hero-icon-polygon">
          <path fill="url(#tg-hero-poly-g)" d="m16.364 15.217 4.27-2.435a.73.73 0 0 0 .366-.627V7.284a.72.72 0 0 0-.366-.627l-4.27-2.435a.74.74 0 0 0-.732 0l-4.27 2.435a.72.72 0 0 0-.366.627v8.704l-2.994 1.707-2.994-1.707v-3.415l2.994-1.707 1.974 1.127V9.702l-1.608-.918a.75.75 0 0 0-.732 0l-4.27 2.435a.72.72 0 0 0-.366.627v4.87c0 .258.14.498.366.627l4.27 2.436a.75.75 0 0 0 .732 0l4.27-2.436a.72.72 0 0 0 .366-.626V8.012l.053-.03 2.94-1.677 2.994 1.707v3.415l-2.994 1.707-1.972-1.124v2.291l1.606.916a.75.75 0 0 0 .732 0z" />
        </g>
        <g id="tg-hero-icon-bnb">
          <path fill="#F0B90B" d="M7.09 5.755 12 3l4.91 2.755-1.8 1.02L12 5.035l-3.105 1.74zm9.82 3.48-1.8-1.02L12 9.955l-3.105-1.74-1.805 1.02v2.035l3.1 1.74v3.475l1.81 1.02 1.805-1.02V13.01l3.105-1.74zm0 5.515v-2.04l-1.8 1.02v2.035zm1.285.72-3.105 1.735v2.04l4.91-2.76v-5.51l-1.805 1.015zM16.39 7.495l1.8 1.02v2.035L20 9.535v-2.04l-1.805-1.02L16.39 7.5zm-6.2 10.45v2.035L12 21l1.805-1.02v-2.03L12 18.965l-1.805-1.02zm-3.1-3.2 1.8 1.02V13.73l-1.8-1.02v2.04zm3.1-7.25L12 8.515l1.805-1.02L12 6.475 10.195 7.5zm-4.385 1.02 1.805-1.02-1.8-1.02L4 7.5v2.04l1.805 1.015zm0 3.475L4 10.975v5.51l4.91 2.76V17.2l-3.1-1.735v-3.48z" />
        </g>
        <g id="tg-hero-icon-btc">
          <path fill="#F7931A" d="M18.763 10.236c.279-1.895-1.155-2.905-3.131-3.591l.64-2.553-1.56-.389-.623 2.49-1.245-.297.631-2.508L11.915 3l-.641 2.562-.992-.234v-.01l-2.157-.54-.415 1.668s1.155.272 1.137.28c.631.163.74.578.722.903l-.723 2.923.163.054-.171-.036-1.02 4.087c-.072.19-.27.478-.712.36.018.028-1.128-.27-1.128-.27l-.776 1.778 2.03.505 1.11.289-.65 2.59 1.56.387.633-2.562 1.253.324-.64 2.554 1.56.388.641-2.59c2.662.505 4.665.307 5.505-2.102.676-1.94-.037-3.05-1.435-3.79 1.02-.225 1.786-.902 1.985-2.282zm-3.564 4.999c-.479 1.94-3.745.884-4.8.63l.857-3.436c1.055.27 4.448.784 3.943 2.796zm.478-5.026c-.433 1.76-3.158.866-4.033.65l.775-3.113c.885.217 3.718.632 3.258 2.463" />
        </g>
        <g id="tg-hero-icon-cosmos">
          <path fill="#BA3FD9" fill-rule="evenodd" d="M12 3.624 4.577 7.812v8.376L12 20.376l7.423-4.188V7.812zM19.975 7.5 12 3 4.024 7.5v9L12 21l7.975-4.5z" clip-rule="evenodd" />
          <path fill="#BA3FD9" fill-rule="evenodd" d="M11.997 8.772c-.57 0-1.034-.454-1.034-1.012 0-.557.464-1.01 1.034-1.01s1.034.453 1.034 1.01c0 .558-.464 1.012-1.034 1.012m0-1.472c-.26 0-.47.207-.47.46 0 .254.21.46.47.46s.47-.206.47-.46a.466.466 0 0 0-.47-.46" clip-rule="evenodd" />
          <path fill="#BA3FD9" d="M11.731 8.94a1.25 1.25 0 0 0 .553 0v1.89a1.3 1.3 0 0 0-.553 0zm-.621 2.241-1.676-.946a1.2 1.2 0 0 1-.277.468l1.676.945c.056-.176.151-.335.277-.467m-.277 1.169-1.676.946a1.2 1.2 0 0 1 .277.468l1.676-.946a1.2 1.2 0 0 1-.277-.467m.898.818v1.891a1.3 1.3 0 0 1 .553 0v-1.89a1.25 1.25 0 0 1-.553 0m1.173-.352 1.677.946a1.2 1.2 0 0 1 .276-.468l-1.676-.945a1.2 1.2 0 0 1-.277.467m.277-1.17 1.676-.945a1.2 1.2 0 0 1-.276-.468l-1.677.946c.126.132.222.291.277.467" />
          <path fill="#BA3FD9" fill-rule="evenodd" d="M9.142 10.395a1.05 1.05 0 0 1-1.413.37 1 1 0 0 1-.38-1.381 1.05 1.05 0 0 1 1.414-.37 1 1 0 0 1 .379 1.38m-1.304-.736a.455.455 0 0 0 .172.629.477.477 0 0 0 .643-.169.455.455 0 0 0-.172-.628.477.477 0 0 0-.643.168m1.313 3.964a1 1 0 0 1-.379 1.38 1.05 1.05 0 0 1-1.413-.37 1 1 0 0 1 .38-1.38 1.05 1.05 0 0 1 1.412.37m-1.303.736c.13.22.418.294.643.168a.455.455 0 0 0 .172-.629.477.477 0 0 0-.643-.168.455.455 0 0 0-.172.629m4.169.869c.57 0 1.034.454 1.034 1.011 0 .558-.464 1.011-1.034 1.011s-1.034-.453-1.034-1.01c0-.558.464-1.012 1.034-1.012m0 1.472c.26 0 .47-.207.47-.46a.466.466 0 0 0-.47-.46c-.26 0-.47.206-.47.46 0 .253.21.46.47.46m2.855-3.094a1.05 1.05 0 0 1 1.413-.37 1 1 0 0 1 .379 1.381 1.05 1.05 0 0 1-1.413.37 1 1 0 0 1-.379-1.38m1.304.736a.455.455 0 0 0-.173-.628.477.477 0 0 0-.643.168.455.455 0 0 0 .173.628.477.477 0 0 0 .643-.168m-1.313-3.965a1 1 0 0 1 .38-1.38 1.05 1.05 0 0 1 1.412.37 1 1 0 0 1-.379 1.38 1.05 1.05 0 0 1-1.413-.37m1.304-.735a.477.477 0 0 0-.643-.168.455.455 0 0 0-.172.628c.13.22.418.295.643.168a.455.455 0 0 0 .172-.628m-4.17 1.889c-.26 0-.47.207-.47.46 0 .254.21.46.47.46s.47-.206.47-.46a.466.466 0 0 0-.47-.46m0 1.471c-.57 0-1.034-.453-1.034-1.01 0-.558.464-1.012 1.034-1.012s1.034.454 1.034 1.011c0 .558-.464 1.011-1.034 1.011" clip-rule="evenodd" />
        </g>
        <g id="tg-hero-icon-sui">
          <path fill="#4BA2FF" d="M16.128 10.508a5.44 5.44 0 0 1 1.15 3.356 5.47 5.47 0 0 1-1.182 3.4l-.063.079-.016-.107a5 5 0 0 0-.053-.26c-.37-1.656-1.566-3.08-3.546-4.233-1.334-.774-2.102-1.705-2.304-2.765a4.1 4.1 0 0 1 .16-1.969c.15-.494.385-.961.693-1.376l.773-.963a.332.332 0 0 1 .518 0zm1.218-.964L12.19 3.092a.244.244 0 0 0-.38 0L6.653 9.549l-.016.016a7.1 7.1 0 0 0-1.52 4.405C5.118 17.85 8.199 21 12 21s6.883-3.15 6.883-7.03a7.1 7.1 0 0 0-1.52-4.405zm-9.46.943.46-.577.017.105.037.255c.301 1.604 1.366 2.938 3.15 3.97 1.551.905 2.45 1.943 2.71 3.081.1.443.128.898.079 1.35v.027l-.021.01a5.2 5.2 0 0 1-2.319.544c-2.911 0-5.278-2.412-5.278-5.388a5.44 5.44 0 0 1 1.165-3.377" />
        </g>
        <g id="tg-hero-icon-aptos">
          <circle cx="12" cy="12" r="10.2" fill="#18181B" />
          <g transform="translate(12 12) scale(0.76) translate(-12 -12)">
            <path fill="#F8FAFC" d="M15.336 9.02a.65.65 0 0 1-.483-.217l-.643-.726a.507.507 0 0 0-.757 0l-.552.623a.95.95 0 0 1-.713.322h-8.68a9 9 0 0 0-.473 2.221h8.196a.53.53 0 0 0 .38-.163l.764-.796a.5.5 0 0 1 .365-.155h.031c.145 0 .283.061.379.17l.643.726a.65.65 0 0 0 .483.218h6.69a9 9 0 0 0-.473-2.221zm-7.341 6.894a.53.53 0 0 0 .38-.163l.764-.796a.5.5 0 0 1 .365-.156h.031c.145 0 .283.062.379.17l.643.727a.65.65 0 0 0 .483.218h9.066c.34-.702.588-1.456.736-2.244h-8.701a.65.65 0 0 1-.483-.217l-.643-.727a.507.507 0 0 0-.757 0l-.552.624a.95.95 0 0 1-.713.321H3.158c.148.789.397 1.542.737 2.243zm6.431-9.32a.53.53 0 0 0 .382-.163l.763-.796a.5.5 0 0 1 .364-.155h.032c.144 0 .283.061.378.17l.643.727a.65.65 0 0 0 .484.217h1.723A8.99 8.99 0 0 0 12.001 3a8.99 8.99 0 0 0-7.195 3.594zm-5.82 11.544a.65.65 0 0 1-.484-.218l-.643-.726a.507.507 0 0 0-.756 0l-.552.623a.95.95 0 0 1-.713.321h-.037A8.97 8.97 0 0 0 12.001 21a8.97 8.97 0 0 0 6.578-2.862z" />
          </g>
        </g>
        <g id="tg-hero-icon-ton">
          <path fill="#0098EA" d="M18.078 3H5.922C3.687 3 2.27 5.41 3.394 7.36l7.503 13.003c.49.85 1.716.85 2.206 0L20.607 7.36C21.729 5.414 20.313 3 18.079 3zM10.89 16.464l-1.634-3.162L5.314 6.25a.689.689 0 0 1 .606-1.03h4.969v11.244zm7.791-10.215-3.94 7.054-1.635 3.16V5.22h4.97c.544 0 .865.578.605 1.03" />
        </g>
        <g id="tg-hero-icon-tron">
          <path fill="#D92D20" fill-rule="evenodd" d="M4.42 3.186a.57.57 0 0 1 .552-.17L16.876 5.93a.5.5 0 0 1 .197.092l2.422 1.767a.565.565 0 0 1 .133.773l-8.332 12.191a.563.563 0 0 1-.998-.13L4.306 3.753a.57.57 0 0 1 .114-.566M6.383 6.23l4.16 11.712.684-6.069zm5.958 5.838-.695 6.175 5.884-8.61zm5.72-3.93-3.793 1.78 2.542-2.691zm-2.396-1.343L6.41 4.531l5.426 6.318z" clip-rule="evenodd" />
        </g>
        <g id="tg-hero-icon-solana">
          <path fill="url(#tg-hero-sol-b1)" d="M18.413 7.902a.62.62 0 0 1-.411.163H3.58c-.512 0-.77-.585-.416-.928l2.369-2.284a.6.6 0 0 1 .41-.169H20.42c.517 0 .77.59.41.935z" />
          <path fill="url(#tg-hero-sol-b2)" d="M18.413 10.473a.62.62 0 0 0-.411-.158H3.58c-.512 0-.77.58-.416.923l2.369 2.29c.111.103.257.16.41.163H20.42c.517 0 .77-.586.41-.928z" />
          <path fill="url(#tg-hero-sol-b3)" d="M18.413 19.158a.62.62 0 0 1-.411.158H3.58c-.512 0-.77-.58-.416-.923l2.369-2.29a.6.6 0 0 1 .41-.163H20.42c.517 0 .77.586.41.928z" />
        </g>
      </defs>

      <rect width="680" height="468" fill="url(#tg-hero-bg)" />
      <rect width="680" height="468" fill="url(#tg-hero-dots)" mask="url(#tg-hero-grid-mask)" />

      <g class="tg-hero-content">
        <ellipse class="tg-hero-orbit" cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}" fill="none" stroke="#2B2B3D" stroke-width="1" stroke-dasharray="3 6" />
        <circle cx="${CX}" cy="${CY}" r="150" fill="url(#tg-hero-sol-bloom)" class="tg-hero-sol-bloom" />

        <g>${conduits.join('')}</g>
        <g>${pulses.join('')}</g>
        <g>
          ${ripples.join('')}
          <circle class="tg-hero-big-ripple" cx="${CX}" cy="${CY}" r="${HERO_CORE_R}" fill="none" stroke="url(#tg-hero-sol-spectrum)" stroke-width="2.2" opacity="0" />
          <circle class="tg-hero-big-ripple" cx="${CX}" cy="${CY}" r="${HERO_CORE_R}" fill="none" stroke="url(#tg-hero-sol-spectrum)" stroke-width="1.4" opacity="0" />
        </g>

        <g id="tg-hero-solana-home">
          <circle class="tg-hero-ring" cx="${CX}" cy="${CY}" r="56" fill="none" stroke="url(#tg-hero-sol-spectrum)" stroke-width="1.35" stroke-dasharray="12 8 3 8" stroke-opacity="0.8" />
          <circle cx="${CX}" cy="${CY}" r="46" fill="#0B0B12" stroke="#30303F" stroke-width="1" />
          <circle cx="${CX}" cy="${CY}" r="${HERO_CORE_R}" fill="url(#tg-hero-core-fill)" stroke="url(#tg-hero-sol-spectrum)" stroke-width="1.8" />
          <g transform="translate(319, 211) scale(1.75)"><use href="#tg-hero-icon-solana" /></g>
        </g>

        <g>${sats.join('')}</g>
        <g>${nodes.join('')}</g>

        <g id="tg-hero-status-pill" transform="translate(340, 300)">
          <rect id="tg-hero-status-bg" x="-62" y="-11.5" width="124" height="23" rx="11.5" fill="#0E0E17" stroke="#34344A" stroke-width="1" />
          <circle id="tg-hero-status-dot" cx="-48" cy="0" r="3.2" fill="#14F195" class="tg-hero-live-dot" />
          <text id="tg-hero-status-text" x="5" y="3.8" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" fill="#F4F4F8" letter-spacing="-0.01em">Solana Home</text>
        </g>

        <g id="tg-hero-more-evms" transform="translate(60, 232)" tabindex="0" role="button" aria-label="20 EVM chains to Solana" class="tg-hero-more-evms">
          <rect x="-34" y="-11" width="68" height="22" rx="11" fill="#0E0E17" stroke="#34344A" stroke-width="1" />
          <text x="0" y="3.5" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, SFMono-Regular, monospace" font-size="10" font-weight="600" fill="#D4D4DC">+14 EVMs</text>
        </g>
      </g>
    </svg>
  `;
}

/**
 * Builds the GSAP choreography on an already-rendered hero SVG.
 * Intro (plays once): Solana core lands, chains pop in, conduits draw home.
 * Loop (repeats): three waves of tokens fly home, then every route flashes.
 */
function buildHeroMotion(gsap, svg) {
  const origin = `${HERO_CX} ${HERO_CY}`;
  const q = (sel) => Array.from(svg.querySelectorAll(sel));
  const one = (sel) => svg.querySelector(sel);
  const ordered = (sel) =>
    HERO_LAUNCH_ORDER.map((id) => svg.querySelector(`${sel}[data-hero-chain="${id}"]`)).filter(Boolean);

  const core = one('#tg-hero-solana-home');
  const bloom = one('.tg-hero-sol-bloom');
  const orbit = one('.tg-hero-orbit');
  const pills = [one('#tg-hero-status-pill'), one('#tg-hero-more-evms')].filter(Boolean);
  const nodes = ordered('.tg-hero-node');
  const bodies = nodes.map((n) => n.querySelector('.tg-hero-node-body'));
  const labels = nodes.map((n) => n.querySelector('.tg-hero-node-label'));
  const rings = nodes.map((n) => n.querySelector('.tg-hero-node-ring'));
  const flows = ordered('.tg-hero-conduit-flow');
  const bases = ordered('.tg-hero-conduit-base');
  const pulses = ordered('.tg-hero-pulse');
  const ripples = ordered('.tg-hero-ripple');
  const bigRipples = q('.tg-hero-big-ripple');
  const flashes = pulses.map((p) => p.querySelector('.tg-hero-flash'));
  const sats = q('.tg-hero-sat');

  // ---- Intro -------------------------------------------------------------
  gsap.set(core, { svgOrigin: origin, scale: 0, opacity: 0 });
  gsap.set(bloom, { svgOrigin: origin, scale: 0.4, opacity: 0 });
  gsap.set(bodies, { svgOrigin: '0 0', scale: 0 });
  gsap.set([...labels, ...bases, ...pills], { opacity: 0 });
  gsap.set(sats, { transformOrigin: '50% 50%', scale: 0 });
  gsap.set(flows, { drawSVG: '0% 0%' });
  gsap.set(orbit, { opacity: 0 });

  const intro = gsap.timeline({ paused: true, defaults: { ease: 'power2.out' } });
  intro
    .to(core, { scale: 1, opacity: 1, duration: 0.8, ease: 'back.out(1.9)' }, 0.15)
    .to(bloom, { scale: 1, opacity: 0.85, duration: 1.1 }, 0.2)
    .to(orbit, { opacity: 1, duration: 0.9 }, 0.3)
    .to(bodies, { scale: 1, duration: 0.5, ease: 'back.out(2.2)', stagger: 0.07 }, 0.7)
    .to(labels, { opacity: 1, duration: 0.3, stagger: 0.07 }, 0.86)
    .to(sats, { scale: 1, duration: 0.3, ease: 'back.out(3)', stagger: 0.025 }, 1.3)
    .to(flows, { drawSVG: '0% 100%', duration: 0.7, ease: 'power2.inOut', stagger: 0.05 }, 1.6)
    .to(bases, { opacity: 1, duration: 0.45, stagger: 0.05 }, 1.9)
    .to(pills, { opacity: 1, duration: 0.4 }, 2.4)
    // hand opacity back to CSS so hover route-isolation can dim these again
    .set([...labels, ...bases, ...pills, bloom, orbit], { clearProps: 'opacity' }, 3.0);

  // ---- Loop --------------------------------------------------------------
  const TRAVEL = 1.15;
  const STAGGER = 0.11;
  const WAVE_GAP = 1.6;
  const WAVES = 3;
  const loop = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.5 });

  pulses.forEach((pulse, i) => {
    const flow = flows[i];
    const token = pulse.querySelector('.tg-hero-token');
    const trails = [pulse.querySelector('.tg-hero-trail-glow'), pulse.querySelector('.tg-hero-trail')];
    const length = flow.getTotalLength();
    gsap.set(trails, { strokeDasharray: `${HERO_TRAIL} ${length + HERO_TRAIL}`, strokeDashoffset: HERO_TRAIL });

    for (let wave = 0; wave < WAVES; wave += 1) {
      const start = wave * WAVE_GAP + i * STAGGER;
      const arrive = start + TRAVEL;
      loop
        .fromTo(rings[i], { scale: 1 }, { scale: 1.22, svgOrigin: '0 0', duration: 0.17, yoyo: true, repeat: 1, ease: 'sine.inOut' }, start)
        .set([token, ...trails], { opacity: 1 }, start + 0.1)
        .fromTo(
          token,
          { motionPath: { path: flow, align: flow, alignOrigin: [0.5, 0.5], start: 0, end: 0 } },
          { motionPath: { path: flow, align: flow, alignOrigin: [0.5, 0.5], start: 0, end: 1 }, duration: TRAVEL, ease: 'power2.in', immediateRender: false },
          start + 0.1
        )
        .fromTo(trails, { strokeDashoffset: HERO_TRAIL }, { strokeDashoffset: HERO_TRAIL - length, duration: TRAVEL, ease: 'power2.in', immediateRender: false }, start + 0.1)
        .to([token, ...trails], { opacity: 0, duration: 0.12 }, arrive + 0.04)
        .fromTo(
          ripples[i],
          { attr: { r: HERO_CORE_R + 9 }, opacity: 0.85 },
          { attr: { r: HERO_CORE_R + 46 }, opacity: 0, duration: 0.7, ease: 'power1.out', immediateRender: false },
          arrive + 0.1
        );
    }
  });

  const finale = (WAVES - 1) * WAVE_GAP + (pulses.length - 1) * STAGGER + TRAVEL + 0.35;
  loop
    .to(flashes, { opacity: 0.9, duration: 0.25, stagger: 0.015 }, finale)
    .to(flashes, { opacity: 0, duration: 0.9 }, finale + 0.45)
    .to(core, { scale: 1.12, duration: 0.22, ease: 'power2.out' }, finale + 0.05)
    .to(core, { scale: 1, duration: 0.9, ease: 'elastic.out(1, 0.4)' }, finale + 0.27)
    .to(bloom, { scale: 1.3, duration: 0.5, ease: 'power2.out' }, finale)
    .to(bloom, { scale: 1, duration: 1.2, ease: 'sine.inOut' }, finale + 0.5)
    .fromTo(
      bigRipples[0],
      { attr: { r: HERO_CORE_R }, opacity: 0.9 },
      { attr: { r: 300 }, opacity: 0, duration: 1.5, ease: 'power2.out', immediateRender: false },
      finale + 0.08
    )
    .fromTo(
      bigRipples[1],
      { attr: { r: HERO_CORE_R }, opacity: 0.65 },
      { attr: { r: 225 }, opacity: 0, duration: 1.5, ease: 'power2.out', immediateRender: false },
      finale + 0.3
    );

  const spin = gsap.to(one('.tg-hero-ring'), { rotation: 360, svgOrigin: origin, duration: 48, ease: 'none', repeat: -1, paused: true });

  return { intro, loop, spin };
}

/**
 * Mounts the Turgalium custom SVG multi-chain convergence hero.
 * Motion is a GSAP timeline loaded lazily from /vendor/gsap.js; it is fully
 * paused (GSAP ticker asleep, zero rAF) while the site shell is hidden, the tab
 * is in the background, or the stage is scrolled off-screen.
 */
export function mountTurgaliumHeroSvg(container) {
  if (!container) {
    return { setActive() {}, setPaused() {}, isRunning() { return false; }, destroy() {} };
  }

  container.innerHTML = buildHeroSvgMarkup();
  const svg = container.querySelector('#turgaliumHeroSvg');
  if (!svg) {
    return { setActive() {}, setPaused() {}, isRunning() { return false; }, destroy() {} };
  }

  const statusText = svg.querySelector('#tg-hero-status-text');
  const statusDot = svg.querySelector('#tg-hero-status-dot');
  const statusBg = svg.querySelector('#tg-hero-status-bg');
  const stageCard = container.closest('.hero-visual-col');
  const footerChips = Array.from(stageCard?.querySelectorAll('.hero-chain-chip') || []);
  const listeners = [];

  let paused = false;
  let destroyed = false;
  let inView = true;
  let boosted = false;
  let engine = null; // gsap instance once loaded
  let motion = null; // { intro, loop, spin }
  let introDone = false;

  const isShellHidden = () => {
    const shell = document.getElementById('siteShell');
    if (shell && (shell.classList.contains('hidden') || shell.hidden)) return true;
    return Boolean(container.closest('.hidden'));
  };

  const shouldRun = () =>
    !destroyed && !paused && inView && !document.hidden && !isShellHidden() && !prefersReducedMotion();

  const syncAnimationState = () => {
    const running = shouldRun();
    svg.classList.toggle('is-paused', !running);
    if (!engine || !motion) return;
    if (running) {
      engine.ticker.wake();
      motion.spin.play();
      if (introDone) motion.loop.play();
      else motion.intro.play();
    } else {
      motion.intro.pause();
      motion.loop.pause();
      motion.spin.pause();
      // Nothing else on the page uses GSAP: put its rAF ticker to sleep entirely.
      engine.ticker.sleep();
    }
  };

  const startMotion = async () => {
    if (prefersReducedMotion()) return; // static composition only
    svg.classList.add('is-preparing');
    const revealTimer = setTimeout(() => svg.classList.remove('is-preparing'), 4000);
    try {
      const mod = await import('./vendor/gsap.js?v=1');
      if (destroyed || !mod?.gsap) return;
      engine = mod.gsap;
      motion = buildHeroMotion(engine, svg);
      motion.intro.eventCallback('onComplete', () => {
        introDone = true;
        if (shouldRun()) motion.loop.play(0);
      });
      motion.loop.timeScale(boosted ? 1.35 : 1);
      svg.setAttribute('data-hero-engine', 'gsap');
    } catch {
      // GSAP unavailable: keep the complete static graphic.
      svg.setAttribute('data-hero-engine', 'static');
    } finally {
      clearTimeout(revealTimer);
      svg.classList.remove('is-preparing');
      syncAnimationState();
    }
  };

  const updatePill = (text, dotColor) => {
    if (!statusText || !statusDot || !statusBg) return;
    statusText.textContent = text;
    statusDot.setAttribute('fill', dotColor);
    const w = Math.max(120, Math.round(text.length * 6.5 + 42));
    statusBg.setAttribute('width', String(w));
    statusBg.setAttribute('x', String(Math.round(-w / 2)));
    statusDot.setAttribute('cx', String(Math.round(-w / 2 + 14)));
  };

  const setFocus = ({ chainId = null, group = null }) => {
    svg.classList.add('has-focus');
    const isMatch = (elNode) => {
      if (chainId) return elNode.getAttribute('data-hero-chain') === chainId;
      if (group) return elNode.getAttribute('data-hero-group') === group;
      return false;
    };

    svg.querySelectorAll('[data-hero-chain]').forEach((node) => {
      node.classList.toggle('is-active', isMatch(node));
    });

    footerChips.forEach((chip) => {
      const chipChain = chip.getAttribute('data-hero-chain');
      const chipGroup = chip.getAttribute('data-hero-group');
      const matchedChain = chainId ? HERO_CHAINS.find((c) => c.id === chainId) : null;
      const active =
        (chainId && chipChain === chainId) ||
        (group && chipGroup === group) ||
        (matchedChain?.group === 'evm' && chipGroup === 'evm');
      chip.classList.toggle('is-active', Boolean(active));
    });

    if (group === 'evm') {
      updatePill('20 EVMs → Solana', '#3B82F6');
    } else if (chainId) {
      const chain = HERO_CHAINS.find((c) => c.id === chainId);
      if (chain) updatePill(chain.route, chain.color);
    }
  };

  const clearFocus = () => {
    svg.classList.remove('has-focus');
    svg.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
    footerChips.forEach((c) => c.classList.remove('is-active'));
    updatePill('Solana Home', '#14F195');
  };

  const bind = (target, event, handler) => {
    if (!target) return;
    target.addEventListener(event, handler);
    listeners.push([target, event, handler]);
  };

  svg.querySelectorAll('.tg-hero-node').forEach((node) => {
    const chainId = node.getAttribute('data-hero-chain');
    bind(node, 'mouseenter', () => setFocus({ chainId }));
    bind(node, 'focus', () => setFocus({ chainId }));
    bind(node, 'mouseleave', clearFocus);
    bind(node, 'blur', clearFocus);
  });

  const moreEvms = svg.querySelector('#tg-hero-more-evms');
  bind(moreEvms, 'mouseenter', () => setFocus({ group: 'evm' }));
  bind(moreEvms, 'focus', () => setFocus({ group: 'evm' }));
  bind(moreEvms, 'mouseleave', clearFocus);
  bind(moreEvms, 'blur', clearFocus);

  footerChips.forEach((chip) => {
    const group = chip.getAttribute('data-hero-group');
    const chainId = chip.getAttribute('data-hero-chain');
    bind(chip, 'mouseenter', () => setFocus({ chainId, group }));
    bind(chip, 'focus', () => setFocus({ chainId, group }));
    bind(chip, 'mouseleave', clearFocus);
    bind(chip, 'blur', clearFocus);
  });

  bind(document, 'visibilitychange', syncAnimationState);

  const siteShellEl = document.getElementById('siteShell');
  const mo =
    siteShellEl && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => syncAnimationState())
      : null;
  if (mo && siteShellEl) {
    mo.observe(siteShellEl, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  }

  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          syncAnimationState();
        })
      : null;
  io?.observe(container);

  syncAnimationState();
  startMotion();

  return {
    setActive(isActive) {
      boosted = Boolean(isActive);
      svg.classList.toggle('is-boosted', boosted);
      motion?.loop.timeScale(boosted ? 1.35 : 1);
    },
    setPaused(isPaused) {
      paused = Boolean(isPaused);
      syncAnimationState();
    },
    isRunning() {
      return shouldRun();
    },
    destroy() {
      destroyed = true;
      syncAnimationState();
      motion?.intro.kill();
      motion?.loop.kill();
      motion?.spin.kill();
      mo?.disconnect();
      io?.disconnect();
      for (const [target, event, handler] of listeners) {
        target.removeEventListener(event, handler);
      }
      listeners.length = 0;
    },
  };
}
