function escapeXml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function shortSol(addr) {
  if (!addr || addr.length <= 12) return addr || 'Solana Wallet';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

const CHAIN_ACCENTS = {
  ethereum: '#18181B',
  base: '#0284C7',
  arbitrum: '#2563EB',
  optimism: '#DC2626',
  polygon: '#7C3AED',
  avalanche: '#E11D48',
};

/**
 * Swiss-Infographic Daylight SVG Multi-Chain Convergence Flow.
 * Maps active EVM source chains -> DeFi Withdraw / Batch Swap / Safe Burn ->
 * Circle CCTP (Domain 5) -> Native Solana Destination USDC.
 */
export function renderConvergenceSvg(plan, scan) {
  const activeLegs = plan?.legs ?? [];
  const totalChains = Math.max(1, activeLegs.length);
  const rowH = 56;
  const height = Math.max(296, totalChains * rowH + 44);
  const width = 1020;

  const col1X = 24;
  const col1W = 196;
  const col2X = 330;
  const col2W = 196;
  const col3X = 610;
  const col3W = 166;
  const col4X = 836;
  const col4W = 164;

  const leftStartY = (height - activeLegs.length * rowH) / 2;

  // Stage 2: 3 processing lanes
  const lanes = [
    {
      id: 'defi',
      title: 'DeFi Withdraw',
      sub: `${plan.totals.defiWithdrawnCount} contract exit(s)`,
      y: height * 0.22 - 26,
      bar: '#059669',
      active: plan.totals.defiWithdrawnCount > 0,
    },
    {
      id: 'swap',
      title: `Swap & Route → ${plan.outputAsset || 'USDC'}`,
      sub: `${plan.totals.tokensSoldCount} liquid asset(s)`,
      y: height * 0.5 - 26,
      bar: '#0A0A0A',
      active: plan.totals.tokensSoldCount > 0,
    },
    {
      id: 'burn',
      title: 'Safe Burn 0x…dEaD',
      sub: `${plan.totals.tokensBurnedCount} dead · ${plan.totals.honeypotsSkippedCount} skipped`,
      y: height * 0.78 - 26,
      bar: '#DC2626',
      active: plan.totals.tokensBurnedCount > 0,
    },
  ];

  const cctpY = height * 0.37 - 29;
  const solY = height * 0.37 - 32;
  const burnSinkY = height * 0.78 - 26;

  const defsPaths = [];
  const edges = [];

  // Chain -> Lane edges
  activeLegs.forEach((leg, idx) => {
    const cy = leftStartY + idx * rowH + 24;
    const x1 = col1X + col1W;

    if (leg.defiExits > 0) {
      const target = lanes[0];
      const d = `M ${x1} ${cy} C ${x1 + 52} ${cy}, ${col2X - 52} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_defi_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#9CA3AF" stroke-width="1.25" marker-end="url(#siphArrow)" />
        <circle r="2.1" fill="#059669">
          <animateMotion dur="2.8s" repeatCount="indefinite" begin="-${(idx * 0.42).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion>
        </circle>
      `);
    }

    if (leg.swaps > 0 || (leg.bridgedUsdc > 0 && leg.defiExits === 0)) {
      const target = lanes[1];
      const d = `M ${x1} ${cy} C ${x1 + 52} ${cy}, ${col2X - 52} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_swap_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#9CA3AF" stroke-width="1.25" marker-end="url(#siphArrow)" />
        <circle r="2.1" fill="#0A0A0A">
          <animateMotion dur="2.5s" repeatCount="indefinite" begin="-${(idx * 0.35 + 0.2).toFixed(2)}s"><mpath href="#${pid}" /></animateMotion>
        </circle>
      `);
    }

    if (leg.burns > 0) {
      const target = lanes[2];
      const d = `M ${x1} ${cy} C ${x1 + 52} ${cy}, ${col2X - 52} ${target.y + 26}, ${col2X - 4} ${target.y + 26}`;
      const pid = `c_burn_${idx}`;
      defsPaths.push(`<path id="${pid}" d="${d}" />`);
      edges.push(`
        <path d="${d}" fill="none" stroke="#FCA5A5" stroke-width="1.15" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />
      `);
    }
  });

  // Lane -> CCTP & Burn Sink edges
  const l1d = `M ${col2X + col2W} ${lanes[0].y + 26} C ${col2X + col2W + 42} ${lanes[0].y + 26}, ${col3X - 42} ${cctpY + 29}, ${col3X - 4} ${cctpY + 29}`;
  const l2d = `M ${col2X + col2W} ${lanes[1].y + 26} C ${col2X + col2W + 42} ${lanes[1].y + 26}, ${col3X - 42} ${cctpY + 29}, ${col3X - 4} ${cctpY + 29}`;
  const c2s = `M ${col3X + col3W} ${cctpY + 29} L ${col4X - 4} ${solY + 32}`;
  const b2d = `M ${col2X + col2W} ${lanes[2].y + 26} L ${col3X - 4} ${burnSinkY + 26}`;

  defsPaths.push(`<path id="p_l1" d="${l1d}" />`, `<path id="p_l2" d="${l2d}" />`, `<path id="p_c2s" d="${c2s}" />`);

  if (lanes[0].active) {
    edges.push(`
      <path d="${l1d}" fill="none" stroke="#059669" stroke-width="1.5" marker-end="url(#siphArrow)" />
      <circle r="2.3" fill="#059669"><animateMotion dur="2.1s" repeatCount="indefinite" begin="-0.4s"><mpath href="#p_l1" /></animateMotion></circle>
    `);
  }
  if (lanes[1].active) {
    edges.push(`
      <path d="${l2d}" fill="none" stroke="#0A0A0A" stroke-width="1.5" marker-end="url(#siphArrow)" />
      <circle r="2.3" fill="#0A0A0A"><animateMotion dur="2.0s" repeatCount="indefinite" begin="-0.9s"><mpath href="#p_l2" /></animateMotion></circle>
    `);
  }
  edges.push(`
    <path d="${c2s}" fill="none" stroke="#0284C7" stroke-width="2" marker-end="url(#siphArrowIce)" />
    <circle r="2.6" fill="#0284C7"><animateMotion dur="1.6s" repeatCount="indefinite" begin="-0.3s"><mpath href="#p_c2s" /></animateMotion></circle>
  `);
  if (lanes[2].active) {
    edges.push(`<path d="${b2d}" fill="none" stroke="#DC2626" stroke-width="1.2" stroke-dasharray="3 2.5" marker-end="url(#siphArrowRed)" />`);
  }

  // Render Chain Nodes
  const chainNodes = activeLegs
    .map((leg, idx) => {
      const y = leftStartY + idx * rowH;
      const bar = CHAIN_ACCENTS[leg.chain] || '#0A0A0A';
      return `
        <g transform="translate(${col1X}, ${y})">
          <rect width="${col1W}" height="46" rx="8" fill="#FFFFFF" stroke="#D4D8E0" />
          <rect width="3.5" height="46" rx="1.75" fill="${bar}" />
          <text x="14" y="20" font-family="Inter, sans-serif" font-size="12.5" font-weight="600" fill="#0A0A0A">${escapeXml(leg.chainName)}</text>
          <text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#52525B">$${leg.bridgedUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} · ${leg.defiExits + leg.swaps + leg.burns} items</text>
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
    plan.outputAsset === 'SOL'
      ? `${plan.totals.netSolanaSol.toFixed(2)} SOL`
      : `$${plan.totals.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`;

  const pref = plan.bridgePreference || 'auto';
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

  return `
    <svg id="siphonFlowSvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block;">
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
        <text x="14" y="23" font-family="Inter, sans-serif" font-size="12.5" font-weight="700" fill="#0A0A0A">${escapeXml(bridgeNodeTitle)}</text>
        <text x="14" y="42" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#52525B">${escapeXml(bridgeNodeSub)}</text>
      </g>

      <!-- Burn Sink Receipt -->
      <g transform="translate(${col3X}, ${burnSinkY})">
        <rect width="${col3W}" height="52" rx="8" fill="${lanes[2].active ? '#FEF2F2' : '#F8F9FB'}" stroke="${lanes[2].active ? '#FCA5A5' : '#E4E6EB'}" />
        <text x="14" y="22" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${lanes[2].active ? '#991B1B' : '#9CA3AF'}">0x000…dEaD</text>
        <text x="14" y="40" font-family="JetBrains Mono, monospace" font-size="10" fill="${lanes[2].active ? '#B91C1C' : '#9CA3AF'}">${plan.totals.tokensBurnedCount} burned · Receipt CSV</text>
      </g>

      <!-- Stage 4: Solana Destination -->
      <g transform="translate(${col4X}, ${solY})">
        <rect width="${col4W}" height="64" rx="10" fill="#E8FAFF" stroke="#0A0A0A" stroke-width="1.6" />
        <text x="14" y="24" font-family="Inter, sans-serif" font-size="11.5" font-weight="600" fill="#0369A1">Solana · ${escapeXml(shortSol(plan.solanaDestination))}</text>
        <text x="14" y="47" font-family="JetBrains Mono, monospace" font-size="13.5" font-weight="700" fill="#0A0A0A">${escapeXml(outputLabel)}</text>
      </g>
    </svg>
  `;
}
