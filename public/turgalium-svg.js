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
  ethereum: '#818CF8',
  base: '#0052FF',
  arbitrum: '#2563EB',
  optimism: '#EF4444',
  polygon: '#8B5CF6',
  avalanche: '#E84142',
  bnb: '#F0B90B',
  sonic: '#38BDF8',
  unichain: '#F50DB4',
  linea: '#61DFFF',
  scroll: '#F59E0B',
  mantle: '#14B8A6',
  blast: '#EAB308',
  worldchain: '#CBD5E1',
  hyperevm: '#97FCE4',
  berachain: '#F59E0B',
  zksync: '#3B82F6',
  ink: '#7C3AED',
  gnosis: '#10B981',
  cosmoshub: '#A855F7',
  osmosis: '#C084FC',
  noble: '#3B82F6',
  celestia: '#7B2BF9',
  injective: '#00F2FE',
  neutron: '#CBD5E1',
  sui: '#4BA2FF',
  aptos: '#E2E8F0',
  ton: '#0098EA',
  tron: '#EF4444',
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
 * Jupiter Dark Obsidian SVG Multi-Chain Convergence Flow with real chain,
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
      bar: '#14F195',
      active: defiWithdrawnCount > 0,
    },
    {
      id: 'swap',
      title: `Swap & Route → ${outAsset}`,
      sub: `${tokensSoldCount} liquid asset(s)`,
      y: height * 0.49 - 26,
      bar: '#C7F284',
      active: tokensSoldCount > 0,
    },
    {
      id: 'burn',
      title: 'Safe Burn 0x…dEaD',
      sub: `${tokensBurnedCount} dead · ${honeypotsSkippedCount} skipped`,
      y: height * 0.79 - 26,
      bar: '#F87171',
      active: tokensBurnedCount > 0,
    },
  ];

  const cctpY = height * 0.34 - 29;
  const solY = height * 0.27 - 32;
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
        <path d="${d}" fill="none" stroke="#364458" stroke-width="1.35" marker-end="url(#siphArrowMint)" />
        ${reducedMotion ? '' : `<circle r="2.2" fill="#14F195"><animateMotion dur="2.8s" repeatCount="indefinite" begin="-${(idx * 0.42).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion></circle>`}
      `);
    }

    if (legSwaps > 0 || (legBridged > 0 && legDefi === 0)) {
      const target = lanes[1];
      const d = `M ${x1} ${cy} C ${x1 + 48} ${cy}, ${col2X - 48} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_swap_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#364458" stroke-width="1.35" marker-end="url(#siphArrowLime)" />
        ${reducedMotion ? '' : `<circle r="2.2" fill="#C7F284"><animateMotion dur="2.5s" repeatCount="indefinite" begin="-${(idx * 0.35 + 0.2).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion></circle>`}
      `);
    }

    if (legBurns > 0) {
      const target = lanes[2];
      const d = `M ${x1} ${cy} C ${x1 + 48} ${cy}, ${col2X - 48} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_burn_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#7F1D1D" stroke-width="1.2" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />
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
      <path d="${l1d}" fill="none" stroke="#14F195" stroke-opacity="0.72" stroke-width="1.6" marker-end="url(#siphArrowMint)" />
      ${reducedMotion ? '' : `<circle r="2.4" fill="#14F195"><animateMotion dur="2.1s" repeatCount="indefinite" begin="-0.4s"><mpath href="#p_l1" /></animateMotion></circle>`}
    `);
  }
  if (lanes[1].active) {
    edges.push(`
      <path d="${l2d}" fill="none" stroke="#C7F284" stroke-opacity="0.78" stroke-width="1.6" marker-end="url(#siphArrowLime)" />
      ${reducedMotion ? '' : `<circle r="2.4" fill="#C7F284"><animateMotion dur="2.0s" repeatCount="indefinite" begin="-0.9s"><mpath href="#p_l2" /></animateMotion></circle>`}
    `);
  }
  edges.push(`
    <path d="${c2s}" fill="none" stroke="#14F195" stroke-width="2.1" marker-end="url(#siphArrowMint)" />
    ${reducedMotion ? '' : `<circle r="2.7" fill="#C7F284"><animateMotion dur="1.6s" repeatCount="indefinite" begin="-0.3s"><mpath href="#p_c2s" /></animateMotion></circle>`}
  `);
  if (safeNum(totals.protocolFeeUsd) > 0) {
    edges.push(
      `<path d="${c2f}" fill="none" stroke="#64748B" stroke-width="1.25" stroke-dasharray="3 2.5" marker-end="url(#siphArrow)" />`
    );
  }
  if (lanes[2].active) {
    edges.push(`<path d="${b2d}" fill="none" stroke="#F87171" stroke-width="1.25" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />`);
  }

  // Render Chain Nodes with real official chain logos
  const chainNodes = activeLegs
    .map((leg, idx) => {
      const y = leftStartY + idx * rowH;
      const bar = CHAIN_ACCENTS[leg.chain] || '#C7F284';
      const legItems = safeInt(leg.defiExits) + safeInt(leg.swaps) + safeInt(leg.burns);
      const legBridgedStr = safeNum(leg.bridgedUsdc).toLocaleString(undefined, { minimumFractionDigits: 2 });
      return `
        <g transform="translate(${col1X}, ${y})">
          <rect width="${col1W}" height="46" rx="10" fill="#1A212B" stroke="#283344" />
          <rect width="3.5" height="46" rx="1.75" fill="${bar}" />
          <image href="${escapeXml(chainLogoForSvg(leg.chain))}" x="13" y="13" width="20" height="20" />
          <text x="41" y="20" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="#F3F6FA">${escapeXml(leg.chainName)}</text>
          <text x="41" y="36" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#8B97A8">$${escapeXml(legBridgedStr)} · ${legItems} items</text>
        </g>
      `;
    })
    .join('');

  // Render Lane Nodes
  const laneNodes = lanes
    .map(
      (l) => `
      <g transform="translate(${col2X}, ${l.y})">
        <rect width="${col2W}" height="52" rx="10" fill="${l.active ? '#1A212B' : '#131820'}" stroke="${l.active ? '#334155' : '#1F2937'}" />
        <rect width="3.5" height="52" rx="1.75" fill="${l.active ? l.bar : '#334155'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="${l.active ? '#F3F6FA' : '#64748B'}">${escapeXml(l.title)}</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10.5" fill="${l.active ? '#8B97A8' : '#475569'}">${escapeXml(l.sub)}</text>
      </g>
    `
    )
    .join('');

  const outputLabel =
    outAsset === 'SOL'
      ? `${safeNum(totals.netSolanaSol).toFixed(2)} SOL`
      : `$${safeNum(totals.netSolanaUsdc).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`;

  const bridgeMeta = bridgeMetaForSvg(plan?.bridgePreference || plan?.routeWinner || 'auto', activeLegs.length);

  const feePct = Number.isFinite(Number(plan?.protocolFeePercent)) ? Number(plan.protocolFeePercent) : 7;
  const feeUsd = safeNum(totals.protocolFeeUsd).toLocaleString(undefined, {
    minimumFractionDigits: 2,
  });
  const feeDestShort = plan?.feeRecipientEvm
    ? `${String(plan.feeRecipientEvm).slice(0, 6)}…${String(plan.feeRecipientEvm).slice(-4)}`
    : 'Fee Vault';

  return `
    <svg id="turgaliumFlowSvg" role="img" aria-label="Multi-chain convergence topology to Solana" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="width:100%; min-width:720px; height:auto; display:block;">
      <defs>
        <pattern id="siphGrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#1F2937" />
        </pattern>
        <marker id="siphArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#64748B" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        <marker id="siphArrowLime" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#C7F284" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        <marker id="siphArrowMint" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#14F195" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        <marker id="siphArrowRed" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1 1.5 L 7 4 L 1 6.5" fill="none" stroke="#F87171" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
        ${defsPaths.join('')}
      </defs>

      <rect width="${width}" height="${height}" rx="14" fill="#0B0E13" />
      <rect width="${width}" height="${height}" rx="14" fill="url(#siphGrid)" />
      ${edges.join('')}
      ${chainNodes}
      ${laneNodes}

      <!-- Stage 3: Active Bridge Provider -->
      <g transform="translate(${col3X}, ${cctpY})">
        <rect width="${col3W}" height="58" rx="10" fill="#1A212B" stroke="#C7F284" stroke-opacity="0.55" stroke-width="1.35" />
        <image href="${escapeXml(bridgeMeta.logo)}" x="12" y="18" width="22" height="22" />
        <text x="42" y="24" font-family="Inter, sans-serif" font-size="12.5" font-weight="700" fill="#F3F6FA">${escapeXml(bridgeMeta.title)}</text>
        <text x="42" y="42" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#8B97A8">${escapeXml(bridgeMeta.sub)}</text>
      </g>

      <!-- Burn Sink Receipt -->
      <g transform="translate(${col3X}, ${burnSinkY})">
        <rect width="${col3W}" height="52" rx="10" fill="${lanes[2].active ? '#231418' : '#131820'}" stroke="${lanes[2].active ? '#7F1D1D' : '#1F2937'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${lanes[2].active ? '#FCA5A5' : '#64748B'}">0x000…dEaD</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10" fill="${lanes[2].active ? '#F87171' : '#475569'}">${tokensBurnedCount} burned · Receipt CSV</text>
      </g>

      <!-- Stage 4A: Solana Destination -->
      <g transform="translate(${col4X}, ${solY})">
        <rect width="${col4W}" height="64" rx="12" fill="#0D221C" stroke="#14F195" stroke-opacity="0.75" stroke-width="1.5" />
        <image href="/logos/solana.svg" x="12" y="12" width="18" height="18" />
        <text x="36" y="25" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#14F195">Solana · ${escapeXml(shortSol(plan?.solanaDestination))}</text>
        <text x="14" y="49" font-family="JetBrains Mono, monospace" font-size="13.2" font-weight="700" fill="#F3F6FA">${escapeXml(outputLabel)}</text>
      </g>

      <!-- Stage 4B: Protocol Treasury Fee Vault -->
      <g transform="translate(${col4X}, ${feeY})">
        <rect width="${col4W}" height="52" rx="10" fill="#131820" stroke="#283344" />
        <image href="/logos/turgalium.svg" x="12" y="16" width="18" height="18" />
        <text x="36" y="22" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#CBD5E1">Fee (${escapeXml(feePct)}%) · ${escapeXml(feeDestShort)}</text>
        <text x="36" y="39" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#8B97A8">$${escapeXml(feeUsd)} → Treasury</text>
      </g>
    </svg>
  `;
}
