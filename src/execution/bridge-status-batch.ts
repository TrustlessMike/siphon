import { fetchCctpAttestationForTx } from '../bridge/cctp.js';
import { checkLiveExecutionStatus } from './tx-builder.js';
import type { AnyChainId, EvmChainId } from '../scanner/types.js';

export const MAX_BRIDGE_STATUS_BATCH = 12;

const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TRACKABLE_HASH_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,96}|[0-9a-fA-F]{64})$/;

export interface BridgeStatusBatchEntry {
  id?: string;
  chain: AnyChainId;
  chainName?: string;
  txHash: string;
  provider?: string;
  requestId?: string;
  solanaDestination?: string;
  status?: string;
}

export interface BridgeStatusBatchResultItem {
  id: string;
  chain: AnyChainId;
  txHash: string;
  status: 'confirming' | 'relaying' | 'attested' | 'landed' | 'failed';
  attestationStatus?: string;
  requiresSolanaClaim: boolean;
  solanaTxHash?: string;
  statusText: string;
  changed: boolean;
}

export interface BridgeStatusBatchResponse {
  checkedAt: string;
  count: number;
  anyLanded: boolean;
  results: BridgeStatusBatchResultItem[];
}

export interface BridgeStatusBatchDeps {
  fetchCctpAttestation?: typeof fetchCctpAttestationForTx;
  checkExecutionStatus?: typeof checkLiveExecutionStatus;
}

function isCctpProvider(provider?: string): boolean {
  const p = String(provider || '').toLowerCase();
  return p.includes('cctp') || p.includes('circle');
}

function normalizeInitialStatus(raw?: string): 'confirming' | 'relaying' | 'attested' | 'landed' | 'failed' {
  const s = String(raw || '').toLowerCase();
  if (s === 'landed' || s === 'attested' || s === 'failed' || s === 'confirming') return s;
  return 'relaying';
}

/**
 * Polls up to 12 in-flight cross-chain bridges in parallel on the backend, consolidating
 * Circle Iris CCTP V2 attestation checks + Relay/LI.FI/Mayan/RPC receipt checks into 1 HTTP round-trip.
 */
export async function pollBridgeStatusesBatch(
  entries: BridgeStatusBatchEntry[],
  deps: BridgeStatusBatchDeps = {}
): Promise<BridgeStatusBatchResponse> {
  if (!Array.isArray(entries)) {
    throw new Error('bridges array is required.');
  }
  if (entries.length > MAX_BRIDGE_STATUS_BATCH) {
    throw new Error(`Maximum ${MAX_BRIDGE_STATUS_BATCH} bridges per status-batch request.`);
  }

  const cctpFn = deps.fetchCctpAttestation ?? fetchCctpAttestationForTx;
  const statusFn = deps.checkExecutionStatus ?? checkLiveExecutionStatus;

  const settled = await Promise.all(
    entries.map(async (rawEntry, idx): Promise<BridgeStatusBatchResultItem> => {
      const chain = String(rawEntry?.chain || '').trim() as AnyChainId;
      const txHash = String(rawEntry?.txHash || '').trim();
      const id = String(rawEntry?.id || `${chain}:${txHash || idx}`).slice(0, 128);
      const prevStatus = normalizeInitialStatus(rawEntry?.status);

      if (!chain || !txHash || !TRACKABLE_HASH_RE.test(txHash)) {
        return {
          id,
          chain,
          txHash,
          status: prevStatus,
          requiresSolanaClaim: false,
          statusText: 'Invalid chain or transaction hash',
          changed: false,
        };
      }

      if (prevStatus === 'landed' || prevStatus === 'failed') {
        return {
          id,
          chain,
          txHash,
          status: prevStatus,
          requiresSolanaClaim: false,
          statusText: prevStatus === 'landed' ? 'Settled on Solana' : 'Transfer failed or refunded',
          changed: false,
        };
      }

      let nextStatus: 'confirming' | 'relaying' | 'attested' | 'landed' | 'failed' = prevStatus;
      let attestationStatus: string | undefined;
      let requiresSolanaClaim = false;
      let solanaTxHash: string | undefined;
      let statusText = '';

      const isEvmHash = EVM_HASH_RE.test(txHash);
      if (isCctpProvider(rawEntry.provider) && isEvmHash) {
        try {
          const att = await cctpFn({
            chain: chain as EvmChainId,
            txHash,
            solanaDestination:
              typeof rawEntry.solanaDestination === 'string' && rawEntry.solanaDestination.trim()
                ? rawEntry.solanaDestination.trim()
                : undefined,
          });
          const attLow = String(att?.attestationStatus || '').toLowerCase();
          if (attLow) attestationStatus = attLow;
          if (attLow === 'complete') {
            nextStatus = 'attested';
            requiresSolanaClaim = true;
            statusText = String(att?.nextStep || 'CCTP V2 attested — ready to claim on Solana').slice(0, 180);
          } else if (att?.nextStep) {
            statusText = String(att.nextStep).slice(0, 180);
          }
        } catch {
          // non-fatal CCTP poll failure
        }
      }

      if (nextStatus !== 'attested') {
        try {
          const st = await statusFn({
            chain,
            txHash,
            requestId:
              typeof rawEntry.requestId === 'string' && rawEntry.requestId.trim()
                ? rawEntry.requestId.trim()
                : undefined,
            provider:
              typeof rawEntry.provider === 'string' && rawEntry.provider.trim()
                ? rawEntry.provider.trim()
                : undefined,
          });
          const bridgeSt = String(st?.bridgeStatus || '').toLowerCase();
          const solHash =
            typeof st?.solanaTxHash === 'string' && TRACKABLE_HASH_RE.test(st.solanaTxHash.trim())
              ? st.solanaTxHash.trim()
              : undefined;
          if (
            solHash ||
            bridgeSt === 'completed' ||
            bridgeSt === 'success' ||
            bridgeSt === 'landed' ||
            bridgeSt === 'settled'
          ) {
            nextStatus = 'landed';
            if (solHash) solanaTxHash = solHash;
            statusText = String(st?.details || 'Settled on Solana').slice(0, 180);
          } else if (
            st?.evmFailed ||
            bridgeSt === 'failed' ||
            bridgeSt === 'refunded' ||
            bridgeSt === 'reverted'
          ) {
            nextStatus = 'failed';
            statusText = String(st?.details || 'Transfer failed or refunded').slice(0, 180);
          } else if (st?.evmConfirmed && nextStatus === 'confirming') {
            nextStatus = 'relaying';
            statusText = String(
              st?.details || `Confirmed on ${rawEntry.chainName || chain} · relaying to Solana…`
            ).slice(0, 180);
          } else if (st?.details && !statusText) {
            statusText = String(st.details).slice(0, 180);
          }
        } catch {
          // non-fatal status poll failure
        }
      }

      return {
        id,
        chain,
        txHash,
        status: nextStatus,
        ...(attestationStatus ? { attestationStatus } : {}),
        requiresSolanaClaim,
        ...(solanaTxHash ? { solanaTxHash } : {}),
        statusText: statusText || `Relaying from ${rawEntry.chainName || chain} to Solana…`,
        changed: nextStatus !== prevStatus || Boolean(statusText),
      };
    })
  );

  return {
    checkedAt: new Date().toISOString(),
    count: settled.length,
    anyLanded: settled.some((r) => r.status === 'landed'),
    results: settled,
  };
}
