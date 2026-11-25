import type { AnyChainId, ChainFamily, EvmChainId } from '../scanner/types.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import { aptosAdapter } from './aptos.js';
import { btcAdapter } from './btc.js';
import { cosmosAdapter } from './cosmos.js';
import { evmAdapter } from './evm.js';
import type { ChainFamilyAdapter, ChainFamilyMeta } from './interface.js';
import { suiAdapter } from './sui.js';
import { tonAdapter } from './ton.js';
import { tronAdapter } from './tron.js';

export const ALL_FAMILY_ADAPTERS: ChainFamilyAdapter[] = [
  evmAdapter,
  cosmosAdapter,
  suiAdapter,
  aptosAdapter,
  tonAdapter,
  tronAdapter,
  btcAdapter,
];

export const ADAPTER_BY_FAMILY: Record<ChainFamily, ChainFamilyAdapter> = {
  evm: evmAdapter,
  cosmos: cosmosAdapter,
  sui: suiAdapter,
  aptos: aptosAdapter,
  ton: tonAdapter,
  tron: tronAdapter,
  btc: btcAdapter,
};

const CHAIN_TO_FAMILY: Record<string, ChainFamily> = {
  cosmoshub: 'cosmos',
  osmosis: 'cosmos',
  noble: 'cosmos',
  celestia: 'cosmos',
  injective: 'cosmos',
  neutron: 'cosmos',
  sui: 'sui',
  aptos: 'aptos',
  ton: 'ton',
  tron: 'tron',
  btc: 'btc',
};

export function isEvmChain(chain: AnyChainId): chain is EvmChainId {
  return chain in EVM_CHAINS;
}

export function getFamilyForChain(chain: AnyChainId): ChainFamily {
  if (isEvmChain(chain)) return 'evm';
  return CHAIN_TO_FAMILY[chain] ?? 'evm';
}

export function getAdapterForFamily(family: ChainFamily): ChainFamilyAdapter {
  const adapter = ADAPTER_BY_FAMILY[family];
  if (!adapter) throw new Error(`Unsupported chain family: ${family}`);
  return adapter;
}

export function getAdapterForChain(chain: AnyChainId): ChainFamilyAdapter {
  return getAdapterForFamily(getFamilyForChain(chain));
}

export function listAllFamilyMetas(): ChainFamilyMeta[] {
  return ALL_FAMILY_ADAPTERS.map((a) => a.meta);
}

/**
 * Automatically detects the blockchain family from an address format.
 * When an address is 0x + 64 hex chars (shared by Sui & Aptos), `preferredFamily` disambiguates.
 */
export function detectAddressFamily(
  rawAddress: string,
  preferredFamily?: ChainFamily
): ChainFamily | null {
  const addr = rawAddress.trim();
  if (!addr) return null;

  // Disambiguate 0x + 64 hex (Sui vs Aptos) using explicit preferredFamily first
  if (/^0x[0-9a-fA-F]{64}$/.test(addr)) {
    if (preferredFamily === 'aptos') return 'aptos';
    if (preferredFamily === 'sui') return 'sui';
    return 'sui';
  }

  // If preferred family explicitly matches, honor it first
  if (preferredFamily && ADAPTER_BY_FAMILY[preferredFamily]?.matchesAddress(addr)) {
    return preferredFamily;
  }

  // Check unambiguous formats in order
  if (evmAdapter.matchesAddress(addr)) return 'evm';
  if (cosmosAdapter.matchesAddress(addr)) return 'cosmos';
  if (tronAdapter.matchesAddress(addr)) return 'tron';
  if (tonAdapter.matchesAddress(addr)) return 'ton';
  if (btcAdapter.matchesAddress(addr)) return 'btc';
  if (suiAdapter.matchesAddress(addr)) return 'sui';
  if (aptosAdapter.matchesAddress(addr)) return 'aptos';

  return null;
}
