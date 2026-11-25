import type { AnyChainId, ChainFamily, EvmChainId } from '../scanner/types.js';
import { detectAddress, detectAddressFamilyStrict } from '../scanner/address.js';
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

export function isEvmChain(chain: AnyChainId | string): chain is EvmChainId {
  return typeof chain === 'string' && Object.prototype.hasOwnProperty.call(EVM_CHAINS, chain);
}

export function getFamilyForChain(chain: AnyChainId | string): ChainFamily | null {
  if (isEvmChain(chain)) return 'evm';
  if (typeof chain === 'string' && Object.prototype.hasOwnProperty.call(CHAIN_TO_FAMILY, chain)) {
    return CHAIN_TO_FAMILY[chain];
  }
  return null;
}

export function getAdapterForFamily(family: ChainFamily): ChainFamilyAdapter {
  const adapter = Object.prototype.hasOwnProperty.call(ADAPTER_BY_FAMILY, family)
    ? ADAPTER_BY_FAMILY[family]
    : undefined;
  if (!adapter) throw new Error(`Unsupported chain family: ${family}`);
  return adapter;
}

export function getAdapterForChain(chain: AnyChainId | string): ChainFamilyAdapter {
  const family = getFamilyForChain(chain);
  if (!family) throw new Error(`Unsupported chain: ${String(chain)}`);
  return getAdapterForFamily(family);
}

export function listAllFamilyMetas(): ChainFamilyMeta[] {
  return ALL_FAMILY_ADAPTERS.map((a) => a.meta);
}

/**
 * Automatically detects the blockchain family from an address using cryptographic
 * checksum validation across all 7 families (EVM EIP-55 + ENS, Cosmos Bech32,
 * Sui/Aptos Move hex, TON CRC16-XMODEM/raw, Tron Base58Check/41-hex, Bitcoin Base58Check/Bech32/Bech32m).
 * When an address is 0x + 64 hex (shared by Sui & Aptos), `preferredFamily` disambiguates.
 */
export function detectAddressFamily(
  rawAddress: string,
  preferredFamily?: ChainFamily
): ChainFamily | null {
  return detectAddressFamilyStrict(rawAddress, preferredFamily);
}

export { detectAddress };
