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
  'osmosis',
  'sui',
  'aptos',
  'ton',
  'tron',
  'btc',
  'solana',
]);

function chainLogoForSvg(chain) {
  const c = String(chain || '').toLowerCase();
  if (['cosmoshub', 'noble', 'celestia', 'injective', 'neutron'].includes(c)) {
    return '/logos/cosmos.svg';
  }
  if (ALLOWED_LOGO_SLUGS.has(c)) {
    return `/logos/${c}.svg`;
  }
  return '/logos/ethereum.svg';
}

/**
 * Swiss-Infographic Daylight SVG Multi-Chain Convergence Flow with real official chain,
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
  if (safeNum(totals.protocolFeeUsd) > 0) {
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
          <rect width="${col1W}" height="46" rx="8" fill="#FFFFFF" stroke="#D4D8E0" />
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
        <rect width="${col2W}" height="52" rx="8" fill="${l.active ? '#FFFFFF' : '#F8F9FB'}" stroke="${l.active ? '#18181B' : '#E4E6EB'}" />
        <rect width="3.5" height="52" rx="1.75" fill="${l.active ? l.bar : '#D4D8E0'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="${l.active ? '#0A0A0A' : '#9CA3AF'}">${escapeXml(l.title)}</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#6B7280">${escapeXml(l.sub)}</text>
      </g>
    `
    )
    .join('');

  const outputLabel =
    outAsset === 'SOL'
      ? `${safeNum(totals.netSolanaSol).toFixed(2)} SOL`
      : `$${safeNum(totals.netSolanaUsdc).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`;

  const pref = plan?.bridgePreference || 'auto';
  const bridgeLogo =
    pref === 'cctp'
      ? '/logos/circle.svg'
      : pref === 'lifi'
      ? '/logos/lifi.svg'
      : '/logos/relay.svg';
  const bridgeNodeTitle =
    pref === 'cctp'
      ? 'Circle CCTP 1:1'
      : pref === 'relay'
      ? 'Relay Bridge'
      : pref === 'lifi'
      ? 'LI.FI Router'
      : 'Relay / LI.FI';
  const bridgeNodeSub =
    pref === 'cctp'
      ? `Domain 5 · ${activeLegs.length} leg(s)`
      : pref === 'relay'
      ? `~2s fill · ${activeLegs.length} leg(s)`
      : pref === 'lifi'
      ? `Aggregator · ${activeLegs.length} leg(s)`
      : `Auto-fill · ${activeLegs.length} leg(s)`;

  const feePct = Number.isFinite(Number(plan?.protocolFeePercent)) ? Number(plan.protocolFeePercent) : 7;
  const feeUsd = safeNum(totals.protocolFeeUsd).toLocaleString(undefined, {
    minimumFractionDigits: 2,
  });
  const feeDestShort = plan?.feeRecipientEvm
    ? `${String(plan.feeRecipientEvm).slice(0, 6)}…${String(plan.feeRecipientEvm).slice(-4)}`
    : 'Fee Vault';

  return `
    <svg id="siphonFlowSvg" role="img" aria-label="Multi-chain convergence topology to Solana" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="width:100%; min-width:720px; height:auto; display:block;">
      <defs>
        <pattern id="siphGrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#E2E5EC" />
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

      <rect width="${width}" height="${height}" fill="url(#siphGrid)" />
      ${edges.join('')}
      ${chainNodes}
      ${laneNodes}

      <!-- Stage 3: Active Bridge Provider -->
      <g transform="translate(${col3X}, ${cctpY})">
        <rect width="${col3W}" height="58" rx="8" fill="#FFFFFF" stroke="#0A0A0A" stroke-width="1.35" />
        <image href="${bridgeLogo}" x="12" y="18" width="22" height="22" />
        <text x="42" y="24" font-family="Inter, sans-serif" font-size="12.5" font-weight="700" fill="#0A0A0A">${escapeXml(bridgeNodeTitle)}</text>
        <text x="42" y="42" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#52525B">${escapeXml(bridgeNodeSub)}</text>
      </g>

      <!-- Burn Sink Receipt -->
      <g transform="translate(${col3X}, ${burnSinkY})">
        <rect width="${col3W}" height="52" rx="8" fill="${lanes[2].active ? '#FEF2F2' : '#F8F9FB'}" stroke="${lanes[2].active ? '#FCA5A5' : '#E4E6EB'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${lanes[2].active ? '#991B1B' : '#9CA3AF'}">0x000…dEaD</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10" fill="${lanes[2].active ? '#B91C1C' : '#9CA3AF'}">${tokensBurnedCount} burned · Receipt CSV</text>
      </g>

      <!-- Stage 4A: Solana Destination -->
      <g transform="translate(${col4X}, ${solY})">
        <rect width="${col4W}" height="64" rx="10" fill="#E8FAFF" stroke="#0A0A0A" stroke-width="1.6" />
        <image href="/logos/solana.svg" x="12" y="12" width="18" height="18" />
        <text x="36" y="25" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#0369A1">Solana · ${escapeXml(shortSol(plan?.solanaDestination))}</text>
        <text x="14" y="49" font-family="JetBrains Mono, monospace" font-size="13.2" font-weight="700" fill="#0A0A0A">${escapeXml(outputLabel)}</text>
      </g>

      <!-- Stage 4B: Protocol Treasury Fee Vault (5-10%) -->
      <g transform="translate(${col4X}, ${feeY})">
        <rect width="${col4W}" height="52" rx="8" fill="#FFFFFF" stroke="#D4D8E0" />
        <image href="/logos/siphon.svg" x="12" y="16" width="18" height="18" />
        <text x="36" y="22" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#0A0A0A">Fee (${escapeXml(feePct)}%) · ${escapeXml(feeDestShort)}</text>
        <text x="36" y="39" font-family="JetBrains Mono, monospace" font-size="10.2" fill="#52525B">$${escapeXml(feeUsd)} → Treasury</text>
      </g>
    </svg>
  `;
}
