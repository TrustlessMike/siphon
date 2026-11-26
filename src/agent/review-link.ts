import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { detectAddress } from '../scanner/address.js';
import { CHAIN_LIST } from '../scanner/chains.js';
import type { ChainFamily, EvmChainId } from '../scanner/types.js';

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;
const RAW_PRIVATE_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const VALID_EVM_CHAIN_IDS = new Set<string>(CHAIN_LIST.map((c) => c.id));
const VALID_FAMILIES = new Set<ChainFamily>(['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc']);

export interface BuildAgentReviewLinkInput {
  baseUrl: string;
  wallet: string;
  family?: ChainFamily;
  solanaDestination?: string;
  outputAsset?: 'USDC' | 'SOL';
  chains?: string[];
  agentName?: string;
  note?: string;
}

export interface AgentReviewLinkResult {
  reviewUrl: string;
  wallet: string;
  family: ChainFamily;
  solanaDestination: string | null;
  outputAsset: 'USDC' | 'SOL';
  chains: EvmChainId[];
  agentName: string;
  note: string | null;
  nonCustodial: true;
  privateKeyRequired: false;
  securityNotice: string;
}

function cleanShortText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHAR_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

/**
 * Builds a strictly non-custodial Turgalium review & sign deep-link that any AI agent
 * (ChatGPT, Claude, Cursor, OpenClaw) can hand back to the user so the user inspects
 * the live scan and signs locally in their own wallet — zero private keys ever shared.
 */
export function buildAgentReviewLink(input: BuildAgentReviewLinkInput): AgentReviewLinkResult {
  const rawBase = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  let parsedBase: URL;
  try {
    parsedBase = new URL(rawBase || 'https://turgalium.vercel.app');
  } catch {
    throw new Error('Invalid baseUrl for review link.');
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    throw new Error('baseUrl must use http or https protocol.');
  }

  const rawWallet = typeof input.wallet === 'string' ? input.wallet.trim() : '';
  if (!rawWallet || rawWallet.length > 160 || CONTROL_CHAR_RE.test(rawWallet)) {
    throw new Error('Valid public wallet address is required.');
  }
  // Fail closed if someone accidentally pastes a 64-hex private key instead of a public address
  if (RAW_PRIVATE_KEY_RE.test(rawWallet) && input.family !== 'sui' && input.family !== 'aptos') {
    throw new Error(
      'Refused: input looks like a 64-hex key. Supply a public wallet address only (or specify family: "sui" / "aptos" for Move addresses).'
    );
  }
  const familyHint =
    input.family && VALID_FAMILIES.has(input.family) ? input.family : undefined;
  const detected = detectAddress(rawWallet, familyHint);
  if (!detected) {
    throw new Error(
      'Invalid public wallet address. Supported: EVM (0x… / .eth), Cosmos Bech32, Sui, Aptos, TON, Tron, Bitcoin.'
    );
  }

  let solanaDestination: string | null = null;
  if (input.solanaDestination !== undefined && input.solanaDestination !== '') {
    if (typeof input.solanaDestination !== 'string') {
      throw new Error('solanaDestination must be a Base58 Solana address string.');
    }
    const trimmedDest = input.solanaDestination.trim();
    if (trimmedDest.length < 32 || trimmedDest.length > 64 || CONTROL_CHAR_RE.test(trimmedDest)) {
      throw new Error('Invalid solanaDestination address.');
    }
    try {
      solanaAddressToBytes32(trimmedDest);
    } catch {
      throw new Error('Invalid Base58 solanaDestination address.');
    }
    solanaDestination = trimmedDest;
  }

  const rawOutput = typeof input.outputAsset === 'string' ? input.outputAsset.trim().toUpperCase() : 'USDC';
  if (rawOutput !== 'USDC' && rawOutput !== 'SOL') {
    throw new Error('outputAsset must be USDC or SOL.');
  }
  const outputAsset: 'USDC' | 'SOL' = rawOutput;

  const chains: EvmChainId[] = [];
  if (Array.isArray(input.chains)) {
    const seen = new Set<string>();
    for (const rawChain of input.chains) {
      if (typeof rawChain !== 'string') continue;
      const clean = rawChain.trim().toLowerCase();
      if (VALID_EVM_CHAIN_IDS.has(clean) && !seen.has(clean)) {
        seen.add(clean);
        chains.push(clean as EvmChainId);
      }
    }
  }

  const agentName = cleanShortText(input.agentName, 40) ?? 'AI Agent';
  const note = cleanShortText(input.note, 160);

  const review = new URL('/', parsedBase.origin);
  review.searchParams.set('view', 'scanner');
  review.searchParams.set('wallet', detected.normalized);
  review.searchParams.set('family', detected.family);
  if (solanaDestination) review.searchParams.set('dest', solanaDestination);
  if (outputAsset !== 'USDC') review.searchParams.set('output', outputAsset);
  if (chains.length > 0 && detected.family === 'evm') {
    review.searchParams.set('chains', chains.join(','));
  }
  review.searchParams.set('agent', agentName);
  if (note) review.searchParams.set('note', note);

  return {
    reviewUrl: review.toString(),
    wallet: detected.normalized,
    family: detected.family,
    solanaDestination,
    outputAsset,
    chains,
    agentName,
    note,
    nonCustodial: true,
    privateKeyRequired: false,
    securityNotice:
      'Non-custodial review link: Turgalium scans read-only and you inspect & sign every transaction locally in your own wallet. Never share a private key or seed phrase with an AI.',
  };
}
