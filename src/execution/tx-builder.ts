import { encodeCctpDepositForBurn, solanaAddressToBytes32 } from '../bridge/cctp.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS, SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
import {
  checkErc20Allowance,
  simulateBurnTransferOnchain,
  SOLANA_USDC_MINT,
} from '../scanner/discovery.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';

const RELAY_SOLANA_CHAIN_ID = 792703809;
const LIFI_SOLANA_CHAIN_ID = 1151111081099710;
const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ExecutableEvmTx {
  stepId: string;
  label: string;
  description: string;
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  from: string;
  to: string;
  data: string;
  value: string; // hex wei string e.g. '0x0'
  gas?: string;
}

export interface PreparedExecution {
  assetId: string;
  action: ScannedAsset['action'];
  provider: 'relay' | 'lifi' | 'circle_cctp' | 'aave_v3' | 'compound_v3' | 'erc4626' | 'erc20_burn';
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  estimatedOutput: string;
  estimatedSeconds: number;
  estimatedGasUsd?: number;
  estimatedFeeUsd?: number;
  requestId?: string;
  transactions: ExecutableEvmTx[];
  notes: string[];
}

function toHexWei(val: string | number | bigint | undefined): string {
  if (val === undefined || val === null || val === '') return '0x0';
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  try {
    return '0x' + BigInt(val).toString(16);
  } catch {
    return '0x0';
  }
}

function pad32Hex(val: string): string {
  return val.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

function encodeErc20Approve(spender: string, amount: bigint): string {
  return `0x095ea7b3${pad32Hex(spender)}${amount.toString(16).padStart(64, '0')}`;
}

function encodeErc20Transfer(to: string, amount: bigint): string {
  return `0xa9059cbb${pad32Hex(to)}${amount.toString(16).padStart(64, '0')}`;
}

/**
 * Builds REAL directly signable DeFi withdrawal calldata for Aave v3, Compound v3, or ERC-4626 vaults.
 */
async function buildDefiWithdrawExecution(
  asset: ScannedAsset,
  userAddress: string
): Promise<PreparedExecution> {
  const cfg = EVM_CHAINS[asset.chain];
  const rawBal = BigInt(asset.rawBalance);
  const proto = (asset.protocol ?? '').toLowerCase();

  if (proto.includes('aave') && cfg.aaveV3Pool) {
    // Aave v3 Pool.withdraw(address asset, uint256 amount, address to) -> 0x69328dec
    const underlying = asset.underlyingSymbol === 'USDC' ? cfg.usdcAddress : asset.address;
    // Use type(uint256).max so accrued interest is withdrawn cleanly with zero dust left behind
    const maxUint256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const data = `0x69328dec${pad32Hex(underlying)}${maxUint256}${pad32Hex(userAddress)}`;
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'aave_v3',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${asset.uiBalance} ${asset.underlyingSymbol ?? 'USDC'} withdrawn to wallet`,
      estimatedSeconds: 12,
      transactions: [
        {
          stepId: 'aave_withdraw',
          label: `Withdraw ${asset.symbol} from Aave v3`,
          description: `Calls Aave v3 Pool.withdraw(${asset.underlyingSymbol ?? 'asset'}, MAX, your wallet)`,
          chain: asset.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: cfg.aaveV3Pool,
          data,
          value: '0x0',
        },
      ],
      notes: [
        'After Aave withdrawal confirms, re-scan or click Bridge USDC to send the withdrawn balance to Solana.',
      ],
    };
  }

  if (proto.includes('compound') && cfg.compoundV3Comet) {
    // Compound v3 Comet.withdraw(address asset, uint256 amount) -> 0xf3fef3a3
    const data = `0xf3fef3a3${pad32Hex(cfg.usdcAddress)}${rawBal.toString(16).padStart(64, '0')}`;
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'compound_v3',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${asset.uiBalance} USDC withdrawn to wallet`,
      estimatedSeconds: 12,
      transactions: [
        {
          stepId: 'compound_withdraw',
          label: `Withdraw ${asset.symbol} from Compound v3`,
          description: `Calls Compound v3 Comet.withdraw(USDC, ${asset.uiBalance})`,
          chain: asset.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: cfg.compoundV3Comet,
          data,
          value: '0x0',
        },
      ],
      notes: [
        'After Compound withdrawal confirms, bridge the unlocked USDC directly to Solana via Relay or Circle CCTP.',
      ],
    };
  }

  if (proto.includes('erc-4626') || proto.includes('spark')) {
    // ERC-4626 redeem(uint256 shares, address receiver, address owner) -> 0xba087652
    const data = `0xba087652${rawBal.toString(16).padStart(64, '0')}${pad32Hex(userAddress)}${pad32Hex(userAddress)}`;
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'erc4626',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${asset.uiBalance} ${asset.symbol} redeemed to ${asset.underlyingSymbol ?? 'underlying'}`,
      estimatedSeconds: 15,
      transactions: [
        {
          stepId: 'erc4626_redeem',
          label: `Redeem ${asset.symbol} Vault Shares`,
          description: `Calls ERC-4626 redeem(${asset.uiBalance} shares) directly on ${asset.address}`,
          chain: asset.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: asset.address,
          data,
          value: '0x0',
        },
      ],
      notes: ['Underlying tokens return to your wallet for direct Solana bridging.'],
    };
  }

  // Lido stETH / wstETH are liquid ERC-20s that can swap & bridge directly to Solana via Relay/LI.FI!
  return buildBridgeExecution(asset, userAddress, userAddress, 'USDC', 'auto');
}

/**
 * Builds REAL live Relay quote & signable transactions for ANY EVM token/native -> Solana USDC or SOL.
 */
async function tryRelayBridgeQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
}): Promise<PreparedExecution | null> {
  const { asset, userAddress, solanaDestination, outputAsset } = params;
  const cfg = EVM_CHAINS[asset.chain];
  const originCurrency = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const destinationCurrency = outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch('https://api.relay.link/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userAddress,
        originChainId: cfg.chainId,
        destinationChainId: RELAY_SOLANA_CHAIN_ID,
        originCurrency,
        destinationCurrency,
        recipient: solanaDestination,
        amount: asset.rawBalance,
        tradeType: 'EXACT_INPUT',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      requestId?: string;
      details?: {
        timeEstimate?: number;
        currencyOut?: { amountFormatted?: string; currency?: { symbol?: string } };
      };
      fees?: {
        gas?: { amountUsd?: string };
        relayer?: { amountUsd?: string };
      };
      steps?: Array<{
        id: string;
        action?: string;
        description?: string;
        kind: string;
        requestId?: string;
        items?: Array<{
          status?: string;
          data?: {
            from?: string;
            to?: string;
            data?: string;
            value?: string;
            gas?: string;
            chainId?: number;
          };
        }>;
      }>;
    };

    const txs: ExecutableEvmTx[] = [];
    let reqId = json.requestId;
    for (const step of json.steps ?? []) {
      if (step.requestId) reqId = step.requestId;
      if (step.kind !== 'transaction') continue;
      for (const item of step.items ?? []) {
        if (!item.data?.to || !item.data?.data) continue;
        txs.push({
          stepId: step.id,
          label: step.action || `Execute ${step.id}`,
          description: step.description || `${step.id} ${asset.symbol} on ${cfg.name}`,
          chain: asset.chain,
          chainId: item.data.chainId ?? cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: item.data.from ?? userAddress,
          to: item.data.to,
          data: item.data.data,
          value: toHexWei(item.data.value),
          gas: item.data.gas ? toHexWei(item.data.gas) : undefined,
        });
      }
    }

    if (!txs.length) return null;

    const outFormatted = json.details?.currencyOut?.amountFormatted ?? '0';
    const outSym = json.details?.currencyOut?.currency?.symbol ?? outputAsset;

    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'relay',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${Number(outFormatted).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outSym}`,
      estimatedSeconds: Math.max(2, Number(json.details?.timeEstimate ?? 10)),
      estimatedGasUsd: Number(json.fees?.gas?.amountUsd ?? 0),
      estimatedFeeUsd: Number(json.fees?.relayer?.amountUsd ?? 0),
      requestId: reqId,
      transactions: txs,
      notes: [
        `Live Relay cross-chain route: swaps & fills directly into ${solanaDestination.slice(0, 6)}…${solanaDestination.slice(-4)} on Solana with zero manual claim.`,
      ],
    };
  } catch {
    return null;
  }
}

/**
 * Fallback #1: Live LI.FI executable quote (supports cross-chain EVM -> Solana via Relay/Mayan/deBridge/CCTP).
 */
async function tryLifiBridgeQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
}): Promise<PreparedExecution | null> {
  const { asset, userAddress, solanaDestination, outputAsset } = params;
  const cfg = EVM_CHAINS[asset.chain];
  const fromToken = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const toToken = outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;

  try {
    const url = new URL('https://li.quest/v1/quote');
    url.searchParams.set('fromChain', String(cfg.chainId));
    url.searchParams.set('toChain', String(LIFI_SOLANA_CHAIN_ID));
    url.searchParams.set('fromToken', fromToken);
    url.searchParams.set('toToken', toToken);
    url.searchParams.set('fromAmount', asset.rawBalance);
    url.searchParams.set('fromAddress', userAddress);
    url.searchParams.set('toAddress', solanaDestination);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      id?: string;
      toolDetails?: { name?: string };
      estimate?: {
        toAmount?: string;
        executionDuration?: number;
        approvalAddress?: string;
      };
      action?: { toToken?: { decimals?: number; symbol?: string } };
      transactionRequest?: {
        from?: string;
        to?: string;
        data?: string;
        value?: string;
        gasLimit?: string;
        chainId?: number;
      };
    };

    const txReq = json.transactionRequest;
    if (!txReq?.to || !txReq?.data) return null;

    const txs: ExecutableEvmTx[] = [];
    const approvalAddr = json.estimate?.approvalAddress;
    if (asset.address !== 'native' && approvalAddr) {
      const rawAmount = BigInt(asset.rawBalance);
      const allowance = await checkErc20Allowance({
        chain: asset.chain,
        tokenAddress: asset.address,
        owner: userAddress,
        spender: approvalAddr,
      });
      if (allowance < rawAmount) {
        txs.push({
          stepId: 'approve',
          label: `Approve ${asset.symbol} for ${json.toolDetails?.name ?? 'LI.FI'}`,
          description: `ERC-20 allowance for ${approvalAddr}`,
          chain: asset.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: asset.address,
          data: encodeErc20Approve(approvalAddr, rawAmount),
          value: '0x0',
        });
      }
    }

    txs.push({
      stepId: 'bridge',
      label: `Swap & Bridge ${asset.symbol} → Solana ${outputAsset}`,
      description: `Via LI.FI (${json.toolDetails?.name ?? 'aggregator'})`,
      chain: asset.chain,
      chainId: txReq.chainId ?? cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: txReq.from ?? userAddress,
      to: txReq.to,
      data: txReq.data,
      value: toHexWei(txReq.value),
      gas: txReq.gasLimit ? toHexWei(txReq.gasLimit) : undefined,
    });

    const outDecimals = json.action?.toToken?.decimals ?? (outputAsset === 'SOL' ? 9 : 6);
    const outRaw = BigInt(json.estimate?.toAmount ?? '0');
    const outUi = Number(outRaw) / 10 ** outDecimals;

    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'lifi',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${outUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputAsset}`,
      estimatedSeconds: Math.max(5, Number(json.estimate?.executionDuration ?? 30)),
      requestId: json.id,
      transactions: txs,
      notes: [`Live LI.FI quote via ${json.toolDetails?.name ?? 'multi-bridge router'}.`],
    };
  } catch {
    return null;
  }
}

/**
 * Fallback #2 / Explicit Mode: Direct Native Circle CCTP TokenMessenger.depositForBurn for USDC.
 */
async function buildDirectCctpUsdcExecution(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
}): Promise<PreparedExecution> {
  const { asset, userAddress, solanaDestination } = params;
  const cfg = EVM_CHAINS[asset.chain];
  const rawAmount = BigInt(asset.rawBalance);
  const mintRecipientBytes32 = solanaAddressToBytes32(solanaDestination);
  const txs: ExecutableEvmTx[] = [];

  const allowance = await checkErc20Allowance({
    chain: asset.chain,
    tokenAddress: cfg.usdcAddress,
    owner: userAddress,
    spender: cfg.cctpTokenMessenger,
  });

  if (allowance < rawAmount) {
    txs.push({
      stepId: 'approve_cctp',
      label: `Approve USDC for Circle CCTP`,
      description: `Grants Circle TokenMessenger (${cfg.cctpTokenMessenger}) exact spend for ${asset.uiBalance} USDC`,
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: userAddress,
      to: cfg.usdcAddress,
      data: encodeErc20Approve(cfg.cctpTokenMessenger, rawAmount),
      value: '0x0',
    });
  }

  const calldata = encodeCctpDepositForBurn({
    rawUsdcAmount: rawAmount,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    solanaMintRecipientBytes32: mintRecipientBytes32,
    usdcAddress: cfg.usdcAddress,
  });

  txs.push({
    stepId: 'cctp_deposit_for_burn',
    label: `Circle CCTP depositForBurn (${asset.uiBalance.toFixed(2)} USDC → Solana)`,
    description: `Native 1:1 burn on ${cfg.name} (Domain ${cfg.cctpDomain} → Domain 5 Solana)`,
    chain: asset.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: cfg.cctpTokenMessenger,
    data: calldata,
    value: '0x0',
  });

  return {
    assetId: asset.id,
    action: asset.action,
    provider: 'circle_cctp',
    chain: asset.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    estimatedOutput: `${asset.uiBalance.toFixed(2)} USDC (1:1 Native CCTP)`,
    estimatedSeconds: cfg.cctpAttestationSec,
    transactions: txs,
    notes: [
      `Direct Circle CCTP burn-and-mint targeting Solana bytes32 ${mintRecipientBytes32}.`,
    ],
  };
}

async function buildBridgeExecution(
  asset: ScannedAsset,
  userAddress: string,
  solanaDestination: string,
  outputAsset: 'USDC' | 'SOL',
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp'
): Promise<PreparedExecution> {
  const cfg = EVM_CHAINS[asset.chain];
  const isNativeUsdc =
    asset.address.toLowerCase() === cfg.usdcAddress.toLowerCase();

  if (bridgePreference === 'cctp' && isNativeUsdc) {
    return buildDirectCctpUsdcExecution({ asset, userAddress, solanaDestination });
  }

  if (bridgePreference !== 'lifi') {
    const relay = await tryRelayBridgeQuote({ asset, userAddress, solanaDestination, outputAsset });
    if (relay) return relay;
  }

  const lifi = await tryLifiBridgeQuote({ asset, userAddress, solanaDestination, outputAsset });
  if (lifi) return lifi;

  if (isNativeUsdc) {
    return buildDirectCctpUsdcExecution({ asset, userAddress, solanaDestination });
  }

  throw new Error(
    `No live bridge route found for ${asset.symbol} on ${cfg.name} (amount may be below bridge minimum or illiquid).`
  );
}

/**
 * Prepares REAL executable mainnet transaction(s) for any scanned asset:
 *   - DeFi Position -> Aave v3 / Compound v3 / ERC-4626 withdraw (or direct Lido bridge)
 *   - Liquid Dust / USDC -> Live Relay -> LI.FI -> Circle CCTP bridge directly to Solana
 *   - Zero-Liquidity Dead Token -> Live eth_call honeypot check + ERC20.transfer(0x...dEaD)
 */
export async function prepareRealExecution(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
}): Promise<PreparedExecution> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset = 'USDC',
    bridgePreference = 'auto',
  } = params;

  const cfg = EVM_CHAINS[asset.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${asset.chain}`);

  // Validate Solana destination up front
  solanaAddressToBytes32(solanaDestination);

  if (asset.action === 'SKIP_HONEYPOT') {
    throw new Error(`${asset.symbol} is flagged as a reverting honeypot and cannot be executed.`);
  }

  if (asset.action === 'BURN_ZERO_LIQUIDITY') {
    const rawAmount = BigInt(asset.rawBalance);
    const check = await simulateBurnTransferOnchain({
      chain: asset.chain,
      walletAddress: userAddress,
      tokenAddress: asset.address,
      rawAmount,
    });
    if (!check.safeToBurn) {
      throw new Error(`Aborted burn: ${check.reason}`);
    }
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'erc20_burn',
      chain: asset.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `Burn ${asset.uiBalance.toLocaleString()} ${asset.symbol} → 0x000…dEaD`,
      estimatedSeconds: 10,
      transactions: [
        {
          stepId: 'erc20_burn',
          label: `Burn ${asset.symbol} to 0x000…dEaD`,
          description: check.reason,
          chain: asset.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: asset.address,
          data: encodeErc20Transfer(DEAD_BURN_ADDRESS, rawAmount),
          value: '0x0',
        },
      ],
      notes: [check.reason],
    };
  }

  if (
    asset.action === 'WITHDRAW_AND_BRIDGE' &&
    asset.protocol &&
    !asset.protocol.toLowerCase().includes('lido')
  ) {
    return buildDefiWithdrawExecution(asset, userAddress);
  }

  return buildBridgeExecution(asset, userAddress, solanaDestination, outputAsset, bridgePreference);
}

/**
 * Checks real onchain EVM tx receipt + live Relay cross-chain settlement status (including Solana tx hash!).
 */
export async function checkLiveExecutionStatus(params: {
  chain: EvmChainId;
  txHash?: string;
  requestId?: string;
  provider?: string;
}): Promise<{
  evmConfirmed: boolean;
  evmFailed: boolean;
  blockNumber?: number;
  bridgeStatus: string;
  solanaTxHash?: string;
  details?: string;
}> {
  const cfg = EVM_CHAINS[params.chain];
  let evmConfirmed = false;
  let evmFailed = false;
  let blockNumber: number | undefined;

  if (cfg && params.txHash) {
    try {
      const res = await fetch(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [params.txHash],
        }),
      });
      const json = (await res.json()) as {
        result?: { status?: string; blockNumber?: string } | null;
      };
      if (json.result) {
        evmConfirmed = json.result.status === '0x1';
        evmFailed = json.result.status === '0x0';
        if (json.result.blockNumber) blockNumber = Number(BigInt(json.result.blockNumber));
      }
    } catch {
      // Keep polling
    }
  }

  let bridgeStatus = evmConfirmed ? 'confirmed' : evmFailed ? 'failed' : 'pending';
  let solanaTxHash: string | undefined;
  let details: string | undefined;

  if (params.provider === 'relay' && params.requestId) {
    try {
      const res = await fetch(
        `https://api.relay.link/intents/status/v2?requestId=${encodeURIComponent(params.requestId)}`
      );
      if (res.ok) {
        const st = (await res.json()) as {
          status?: string;
          txHashes?: string[];
          details?: string;
        };
        if (st.status) bridgeStatus = st.status;
        if (st.txHashes && st.txHashes.length > 0) solanaTxHash = st.txHashes[0];
        if (st.details) details = st.details;
      }
    } catch {
      // Keep polling
    }
  }

  return {
    evmConfirmed,
    evmFailed,
    blockNumber,
    bridgeStatus,
    solanaTxHash,
    details,
  };
}
