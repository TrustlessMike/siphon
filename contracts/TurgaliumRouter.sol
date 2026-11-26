// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TurgaliumRouter
 * @notice Single-signature EVM-to-Solana migrator router.
 *
 * Security-hardened execution flow:
 *   1. Uses hardened SafeERC20Lite (code.length > 0, safe 32-byte bool check, OZ-style forceApprove)
 *   2. Enforces strictly disjoint allowlists: allowedDefiProtocols vs allowedSwapAggregators
 *   3. Validates Aave v3 aToken against Pool.getReserveData(underlyingAsset) and tracks exact per-call received deltas
 *   4. Binds swapsHash in Permit2 witness, enforces owner-allowlisted feeRecipient & relayers, refunds residual tokens
 *   5. Bridges consolidated net native USDC via Circle CCTP V1 or V2 (Standard, Fast Transfer, or Forwarding Hooks)
 *      to the user's 32-byte Solana USDC ATA PDA (NEVER pass a raw Solana wallet owner pubkey!)
 *   6. Executes isolated zero-liquidity token burns LAST with capped gas & 32-byte bounded return copy (return-bomb safe)
 *   7. Two-step ownership transfer, hard-bounded tiered preservation protocol fee (0 - 1000 bps + optional USDC cap),
 *      on-chain TurgaliumAgentVault mandate enforcement (`sweepWithMandate`), and safe ETH/ERC-20 rescue
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITokenMessengerCCTP {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

interface ITokenMessengerCCTPV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface ITurgaliumAgentVault {
    struct AgentMandate {
        address owner;
        address agentKey;
        address authorizedRouter;
        bytes32 lockedSolanaRecipient;
        uint256 maxPerTxUsd6;
        uint256 dailyCapUsd6;
        uint256 spentTodayUsd6;
        uint64 dayWindowStart;
        uint64 expiresAt;
        uint16 maxFeeBps;
        uint16 minNetOutBps;
        uint8 allowedActionsMask;
        bool active;
    }

    function getMandate(bytes32 mandateId) external view returns (AgentMandate memory);

    function authorizeAgentAction(
        bytes32 mandateId,
        address agentCaller,
        uint8 actionBit,
        bytes32 solanaRecipient,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        uint16 feeBps,
        bytes32 intentDigest
    ) external;
}

interface IAaveV3Pool {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ICompoundV3Comet {
    function baseToken() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}

interface IERC4626Vault {
    function asset() external view returns (address);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

library SafeERC20Lite {
    error SafeTransferFailed(address token);
    error SafeTransferFromFailed(address token);
    error SafeApproveFailed(address token);

    function _callSuccess(address token, bool ok, bytes memory data) private view returns (bool) {
        if (!ok) return false;
        if (data.length == 0) {
            return token.code.length > 0;
        }
        if (data.length < 32) return false;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(data, 32))
        }
        return word == 1;
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!_callSuccess(token, ok, data)) {
            revert SafeTransferFailed(token);
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!_callSuccess(token, ok, data)) {
            revert SafeTransferFromFailed(token);
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        return _callSuccess(token, ok, data);
    }

    /// @dev OpenZeppelin-style forceApprove: attempts direct approve first, falls back to 0 -> amount for USDT-style tokens.
    function forceApprove(address token, address spender, uint256 amount) internal {
        if (_tryApprove(token, spender, amount)) {
            return;
        }
        if (!_tryApprove(token, spender, 0) || (amount > 0 && !_tryApprove(token, spender, amount))) {
            revert SafeApproveFailed(token);
        }
    }
}

contract TurgaliumRouter {
    using SafeERC20Lite for address;

    /// @notice Canonical burn sink for verifiable zero-liquidity token disposal.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Canonical Uniswap Permit2 contract deployed identically across supported EVM chains.
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    /// @notice Gas cap for isolated zero-liquidity burn calls to prevent 63/64ths gas griefing.
    uint256 public constant BURN_GAS_STIPEND = 100_000;

    /// @notice Circle CCTP V2 finality thresholds (1000 = Fast Transfer, 2000 = Standard Finality).
    uint32 public constant CCTP_V2_FAST_FINALITY = 1000;
    uint32 public constant CCTP_V2_STANDARD_FINALITY = 2000;

    /// @notice Hard upper bound on Circle CCTP V2 fast-transfer fee as a share of bridged principal (5.00% = 500 bps).
    uint16 public constant MAX_CCTP_FEE_BPS = 500;

    /// @notice TurgaliumAgentVault action bitmap flags (must mirror TurgaliumAgentVault.sol).
    uint8 public constant ACTION_DUST_CONVERT = 1 << 0;
    uint8 public constant ACTION_DEFI_WITHDRAW = 1 << 1;
    uint8 public constant ACTION_BRIDGE_SOLANA = 1 << 2;
    uint8 public constant ACTION_BURN_ZERO_LIQ = 1 << 3;

    bytes32 public constant TURGALIUM_WITNESS_TYPEHASH = keccak256(
        "TurgaliumSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)"
    );
    string public constant TURGALIUM_WITNESS_TYPESTRING =
        "TurgaliumSweepWitness witness)TokenPermissions(address token,uint256 amount)TurgaliumSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)";

    struct TurgaliumSweepWitness {
        /// @dev Canonical 32-byte Solana USDC Associated Token Account (ATA) PDA — NEVER a raw wallet pubkey.
        bytes32 solanaRecipient;
        uint256 minNetUsdcOut;
        uint256 maxGasReimbursementUsdc;
        uint16 feeBps;
        address feeRecipient;
        /// @dev keccak256(abi.encode(swaps)) binding exact swap calldata to the user's Permit2 signature.
        bytes32 swapsHash;
    }

    struct CctpV2Options {
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold; // 0 defaults to CCTP_V2_STANDARD_FINALITY (2000); 1000 = Fast Transfer
        bytes hookData;              // Non-empty invokes TokenMessengerV2.depositForBurnWithHook
    }

    /// @notice Circle CCTP destination domain ID for Solana Mainnet.
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;

    /// @notice Protocol fee bounds: 0.00% (0 bps) minimum for whale/preservation tiers, 10.00% (1000 bps) hard ceiling.
    uint16 public constant MIN_FEE_BPS = 0;
    uint16 public constant MAX_FEE_BPS = 1000;

    address public immutable usdc;
    address public immutable cctpMessenger;
    /// @notice Circle CCTP version deployed on this chain: 1 (4-arg TokenMessenger) or 2 (7/8-arg TokenMessengerV2).
    uint8 public immutable cctpVersion;

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint16 public feeBps;
    /// @notice Optional protocol fee cap in USDC base units (0 = uncapped beyond feeBps; e.g. 25e6 = $25 whale cap).
    uint256 public maxFeeUsdcCap;
    /// @notice Monotonic counter folded into mandate intentDigest so identical sweeps produce unique audit digests.
    uint256 public mandateExecutionNonce;
    uint256 private _reentrancyGuard = 1;

    /// @notice Disjoint allowlist for DEX swap aggregators (callable via swapCalldata). Never contains DeFi protocols or tokens.
    mapping(address => bool) public allowedSwapAggregators;

    /// @notice Disjoint allowlist for typed DeFi exit protocols (Aave v3 Pool, Compound v3 Comet, ERC-4626 Vaults).
    mapping(address => bool) public allowedDefiProtocols;

    /// @notice Owner-configured protocol treasury allowlist (prevents witness.feeRecipient fee-bypass hijacking).
    mapping(address => bool) public allowedFeeRecipients;

    /// @notice Owner-configured sponsor relayer allowlist (prevents MEV frontrunning of gasReimbursementUsdc).
    mapping(address => bool) public allowedRelayers;

    /// @notice Owner-configured TurgaliumAgentVault allowlist permitted for `sweepWithMandate`.
    mapping(address => bool) public allowedAgentVaults;

    enum DefiKind {
        AAVE_V3_WITHDRAW,
        COMPOUND_V3_WITHDRAW,
        ERC4626_REDEEM
    }

    struct DefiExitStep {
        DefiKind kind;
        address protocol;        // Aave v3 Pool, Compound v3 Comet, or ERC-4626 Vault
        address receiptToken;    // For AAVE_V3_WITHDRAW: validated against Pool.getReserveData(underlyingAsset).aTokenAddress
        address underlyingAsset; // Underlying ERC-20 asset returned by protocol
        uint256 amount;
    }

    struct SwapStep {
        address tokenIn;
        uint256 amountIn;
        bool pullFromUser;       // True for wallet ERC-20s; false strictly consumes current-tx DefiExitStep credited delta
        address aggregator;
        bytes swapCalldata;
    }

    struct BurnStep {
        address token;
        uint256 amount;
    }

    struct SweepParams {
        /// @dev Canonical 32-byte Solana USDC Associated Token Account (ATA) PDA — NEVER a raw wallet pubkey.
        bytes32 solanaRecipient;
        /// @dev Explicit amount of pre-existing wallet USDC to pull directly from capitalOwner (no SwapStep required).
        uint256 directUsdcAmount;
        uint256 minNetUsdcOut;
        /// @dev Optional user-side fee ceiling in USDC base units (0 = no extra cap check; reverts if charged fee exceeds it).
        uint256 maxFeeUsdcCap;
        uint256 deadline;
        CctpV2Options cctp;
        DefiExitStep[] defiExits;
        SwapStep[] swaps;
        BurnStep[] burns;
    }

    event TurgaliumMigrated(
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 grossUsdc,
        uint256 feeUsdc,
        uint256 bridgedUsdc,
        uint64 cctpNonce,
        uint256 burnedCount,
        uint256 skippedBurns
    );

    event MandateSweepExecuted(
        bytes32 indexed mandateId,
        address indexed agentVault,
        address indexed capitalOwner,
        address agentCaller,
        uint256 grossUsdc,
        uint256 bridgedUsdc
    );

    event DeadTokenBurned(address indexed user, address indexed token, uint256 amount);
    event DeadTokenSkipped(address indexed user, address indexed token, string reason);
    event SwapAggregatorUpdated(address indexed aggregator, bool allowed);
    event DefiProtocolUpdated(address indexed protocol, bool allowed);
    event FeeRecipientAllowlistUpdated(address indexed recipient, bool allowed);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event AgentVaultUpdated(address indexed vault, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeUpdated(address indexed feeRecipient, uint16 feeBps);
    event MaxFeeUsdcCapUpdated(uint256 previousCap, uint256 newCap);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error ExpiredDeadline();
    error InvalidAddress();
    error InvalidSolanaRecipient();
    error InvalidCctpVersion(uint8 version);
    error CctpV2Required();
    error CctpMaxFeeTooHigh(uint256 requestedMaxFee, uint256 maxAllowedFee);
    error TargetNotAllowed(address target);
    error DisjointAllowlistViolation(address target);
    error UnauthorizedFeeRecipient(address recipient);
    error InvalidSwapsHash();
    error InsufficientCreditedBalance(address token, uint256 requested, uint256 available);
    error AggregatorSwapFailed(address aggregator);
    error SlippageExceeded(uint256 actualUsdc, uint256 minExpected);
    error ZeroUsdcOutput();
    error ZeroMinNetOutput();
    error RelayerBreakEvenNotMet(uint256 relayerRevenueUsdc, uint256 requiredCoverageUsdc);
    error Unauthorized();
    error FeeOutOfBounds(uint16 feeBps);
    error FeeCapExceeded(uint256 feeUsdc, uint256 maxAllowedCap);
    error MandateActionNotPermitted(uint8 requiredBit);
    error AgentArbitrarySwapsForbidden();
    error AgentNonUsdcDefiExitForbidden(address underlyingAsset);
    error AgentBurnsForbidden();
    error AgentCctpOverrideForbidden();
    error InvalidBurnToken(address token);
    error InsufficientSuppliedBalance();
    error NativeTransferFailed(address to);
    error Reentrancy();

    modifier nonReentrant() {
        if (_reentrancyGuard != 1) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address _usdc,
        address _cctpMessenger,
        uint8 _cctpVersion,
        address _feeRecipient,
        uint16 _feeBps
    ) {
        if (
            _usdc == address(0) ||
            _usdc.code.length == 0 ||
            _cctpMessenger == address(0) ||
            _cctpMessenger.code.length == 0 ||
            _feeRecipient == address(0)
        ) {
            revert InvalidAddress();
        }
        if (_cctpVersion != 1 && _cctpVersion != 2) revert InvalidCctpVersion(_cctpVersion);
        if (_feeBps < MIN_FEE_BPS || _feeBps > MAX_FEE_BPS) revert FeeOutOfBounds(_feeBps);
        usdc = _usdc;
        cctpMessenger = _cctpMessenger;
        cctpVersion = _cctpVersion;
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        allowedFeeRecipients[_feeRecipient] = true;
        allowedRelayers[msg.sender] = true;
        emit FeeRecipientAllowlistUpdated(_feeRecipient, true);
        emit RelayerUpdated(msg.sender, true);
    }

    receive() external payable {}

    function setAllowedSwapAggregator(address aggregator, bool allowed) external onlyOwner {
        if (aggregator == address(0)) revert InvalidAddress();
        if (allowed) {
            if (
                aggregator == usdc ||
                aggregator == address(PERMIT2) ||
                aggregator == cctpMessenger ||
                aggregator == address(this) ||
                aggregator.code.length == 0
            ) {
                revert InvalidAddress();
            }
            if (allowedDefiProtocols[aggregator] || allowedAgentVaults[aggregator]) {
                revert DisjointAllowlistViolation(aggregator);
            }
        }
        allowedSwapAggregators[aggregator] = allowed;
        emit SwapAggregatorUpdated(aggregator, allowed);
    }

    function setAllowedDefiProtocol(address protocol, bool allowed) external onlyOwner {
        if (protocol == address(0)) revert InvalidAddress();
        if (allowed) {
            if (
                protocol == usdc ||
                protocol == address(PERMIT2) ||
                protocol == cctpMessenger ||
                protocol == address(this) ||
                protocol.code.length == 0
            ) {
                revert InvalidAddress();
            }
            if (allowedSwapAggregators[protocol]) revert DisjointAllowlistViolation(protocol);
        }
        allowedDefiProtocols[protocol] = allowed;
        emit DefiProtocolUpdated(protocol, allowed);
    }

    function setAllowedFeeRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        allowedFeeRecipients[recipient] = allowed;
        emit FeeRecipientAllowlistUpdated(recipient, allowed);
    }

    function setAllowedRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert InvalidAddress();
        allowedRelayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setAllowedAgentVault(address vault, bool allowed) external onlyOwner {
        if (vault == address(0)) revert InvalidAddress();
        if (allowed) {
            if (vault.code.length == 0) revert InvalidAddress();
            if (allowedSwapAggregators[vault]) revert DisjointAllowlistViolation(vault);
        }
        allowedAgentVaults[vault] = allowed;
        emit AgentVaultUpdated(vault, allowed);
    }

    function setFeeParams(address _feeRecipient, uint16 _feeBps) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        if (_feeBps < MIN_FEE_BPS || _feeBps > MAX_FEE_BPS) revert FeeOutOfBounds(_feeBps);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        allowedFeeRecipients[_feeRecipient] = true;
        emit FeeUpdated(_feeRecipient, _feeBps);
        emit FeeRecipientAllowlistUpdated(_feeRecipient, true);
    }

    /// @notice Configures an optional hard protocol fee cap in USDC base units (0 = uncapped beyond feeBps).
    function setMaxFeeUsdcCap(uint256 _maxFeeUsdcCap) external onlyOwner {
        uint256 prev = maxFeeUsdcCap;
        maxFeeUsdcCap = _maxFeeUsdcCap;
        emit MaxFeeUsdcCapUpdated(prev, _maxFeeUsdcCap);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        token.safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed(to);
        emit NativeRescued(to, amount);
    }

    function _computeProtocolFee(
        uint256 grossUsdc,
        uint16 appliedFeeBps,
        uint256 userMaxFeeCap
    ) private view returns (uint256 feeUsdc, uint16 effectiveFeeBps) {
        uint256 uncappedFee = (grossUsdc * appliedFeeBps) / 10_000;
        feeUsdc = uncappedFee;
        if (maxFeeUsdcCap > 0 && feeUsdc > maxFeeUsdcCap) {
            feeUsdc = maxFeeUsdcCap;
        }
        if (userMaxFeeCap > 0 && feeUsdc > userMaxFeeCap) {
            revert FeeCapExceeded(feeUsdc, userMaxFeeCap);
        }
        if (feeUsdc < uncappedFee && grossUsdc > 0) {
            uint256 ceilBps = (feeUsdc * 10_000 + grossUsdc - 1) / grossUsdc;
            effectiveFeeBps = ceilBps > MAX_FEE_BPS ? MAX_FEE_BPS : uint16(ceilBps);
        } else {
            effectiveFeeBps = appliedFeeBps;
        }
    }

    function _creditToken(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 count,
        address token,
        uint256 delta
    ) private pure returns (uint256) {
        if (delta == 0 || token == address(0)) return count;
        for (uint256 i = 0; i < count; i++) {
            if (tokens[i] == token) {
                amounts[i] += delta;
                return count;
            }
        }
        tokens[count] = token;
        amounts[count] = delta;
        return count + 1;
    }

    function _consumeCredit(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 count,
        address token,
        uint256 requested
    ) private pure returns (uint256 availableIdx, uint256 swapAmount) {
        for (uint256 i = 0; i < count; i++) {
            if (tokens[i] == token) {
                uint256 avail = amounts[i];
                swapAmount = requested < avail ? requested : avail;
                return (i, swapAmount);
            }
        }
        return (type(uint256).max, 0);
    }

    /// @dev Executes an isolated zero-liquidity burn with bounded gas and max 32-byte return copy (immune to return-bombs & non-canonical bools).
    function _safeBurnTransferFrom(address token, address from, uint256 amount) private returns (bool succeeded) {
        if (token == address(0) || token.code.length == 0) return false;
        bytes memory payload = abi.encodeWithSelector(IERC20.transferFrom.selector, from, DEAD_ADDRESS, amount);
        uint256 gasCap = BURN_GAS_STIPEND;
        assembly ("memory-safe") {
            mstore(0x00, 0)
            let ok := call(gasCap, token, 0, add(payload, 32), mload(payload), 0x00, 32)
            let rdsize := returndatasize()
            if ok {
                if or(iszero(rdsize), and(iszero(lt(rdsize, 32)), eq(mload(0x00), 1))) {
                    succeeded := 1
                }
            }
        }
    }

    function _validateCctpAndComputeMinReceived(
        uint256 amount,
        CctpV2Options memory opts
    ) private view returns (uint256 minSolanaReceived) {
        if (cctpVersion == 2) {
            uint256 maxAllowedCctpFee = (amount * MAX_CCTP_FEE_BPS) / 10_000;
            if (opts.maxFee >= amount || opts.maxFee > maxAllowedCctpFee) {
                revert CctpMaxFeeTooHigh(opts.maxFee, maxAllowedCctpFee);
            }
            minSolanaReceived = amount - opts.maxFee;
        } else {
            if (opts.hookData.length > 0 || opts.maxFee > 0) revert CctpV2Required();
            minSolanaReceived = amount;
        }
    }

    function _bridgeUsdcViaCctp(
        uint256 amount,
        bytes32 solanaUsdcAta,
        CctpV2Options memory opts
    ) private returns (uint64 cctpNonce) {
        _validateCctpAndComputeMinReceived(amount, opts);
        usdc.forceApprove(cctpMessenger, amount);
        if (cctpVersion == 2) {
            uint32 finality = opts.minFinalityThreshold == 0
                ? CCTP_V2_STANDARD_FINALITY
                : opts.minFinalityThreshold;
            if (opts.hookData.length > 0) {
                ITokenMessengerCCTPV2(cctpMessenger).depositForBurnWithHook(
                    amount,
                    SOLANA_CCTP_DOMAIN,
                    solanaUsdcAta,
                    usdc,
                    opts.destinationCaller,
                    opts.maxFee,
                    finality,
                    opts.hookData
                );
            } else {
                ITokenMessengerCCTPV2(cctpMessenger).depositForBurn(
                    amount,
                    SOLANA_CCTP_DOMAIN,
                    solanaUsdcAta,
                    usdc,
                    opts.destinationCaller,
                    opts.maxFee,
                    finality
                );
            }
            cctpNonce = 0;
        } else {
            cctpNonce = ITokenMessengerCCTP(cctpMessenger).depositForBurn(
                amount,
                SOLANA_CCTP_DOMAIN,
                solanaUsdcAta,
                usdc
            );
        }
        usdc.forceApprove(cctpMessenger, 0);
    }

    function _bridgeUsdcViaCctp(uint256 amount, bytes32 solanaUsdcAta) private returns (uint64 cctpNonce) {
        CctpV2Options memory defaults;
        return _bridgeUsdcViaCctp(amount, solanaUsdcAta, defaults);
    }

    function _executeExitsAndSwaps(
        address capitalOwner,
        DefiExitStep[] calldata defiExits,
        SwapStep[] calldata swaps
    ) private {
        // Track exact per-token received deltas from DeFi exits so pullFromUser=false can NEVER touch residual router balances.
        uint256 maxCredits = defiExits.length;
        address[] memory creditedTokens = new address[](maxCredits);
        uint256[] memory creditedAmounts = new uint256[](maxCredits);
        uint256 creditCount = 0;

        // 1. Withdraw user capital from strictly allowlisted DeFi protocols
        for (uint256 i = 0; i < defiExits.length; i++) {
            DefiExitStep calldata exitStep = defiExits[i];
            if (!allowedDefiProtocols[exitStep.protocol]) revert TargetNotAllowed(exitStep.protocol);
            if (exitStep.amount == 0) continue;
            if (exitStep.underlyingAsset == address(0)) revert InvalidAddress();

            uint256 underBefore = IERC20(exitStep.underlyingAsset).balanceOf(address(this));

            if (exitStep.kind == DefiKind.AAVE_V3_WITHDRAW) {
                address expectedAToken = IAaveV3Pool(exitStep.protocol)
                    .getReserveData(exitStep.underlyingAsset)
                    .aTokenAddress;
                if (expectedAToken == address(0) || exitStep.receiptToken != expectedAToken) {
                    revert InvalidAddress();
                }
                uint256 pullAmount = exitStep.amount == type(uint256).max
                    ? IERC20(exitStep.receiptToken).balanceOf(capitalOwner)
                    : exitStep.amount;
                if (pullAmount == 0) continue;

                uint256 aBalBefore = IERC20(exitStep.receiptToken).balanceOf(address(this));
                exitStep.receiptToken.safeTransferFrom(capitalOwner, address(this), pullAmount);
                uint256 aReceived = IERC20(exitStep.receiptToken).balanceOf(address(this)) - aBalBefore;

                IAaveV3Pool(exitStep.protocol).withdraw(
                    exitStep.underlyingAsset,
                    aReceived,
                    address(this)
                );
            } else if (exitStep.kind == DefiKind.COMPOUND_V3_WITHDRAW) {
                uint256 withdrawAmt = exitStep.amount;
                if (exitStep.underlyingAsset == ICompoundV3Comet(exitStep.protocol).baseToken()) {
                    uint256 supplied = ICompoundV3Comet(exitStep.protocol).balanceOf(capitalOwner);
                    if (supplied == 0) revert InsufficientSuppliedBalance();
                    if (withdrawAmt > supplied) withdrawAmt = supplied;
                }
                ICompoundV3Comet(exitStep.protocol).withdrawFrom(
                    capitalOwner,
                    address(this),
                    exitStep.underlyingAsset,
                    withdrawAmt
                );
            } else if (exitStep.kind == DefiKind.ERC4626_REDEEM) {
                if (IERC4626Vault(exitStep.protocol).asset() != exitStep.underlyingAsset) {
                    revert InvalidAddress();
                }
                IERC4626Vault(exitStep.protocol).redeem(
                    exitStep.amount,
                    address(this),
                    capitalOwner
                );
            }

            uint256 underAfter = IERC20(exitStep.underlyingAsset).balanceOf(address(this));
            if (underAfter > underBefore && exitStep.underlyingAsset != usdc) {
                creditCount = _creditToken(
                    creditedTokens,
                    creditedAmounts,
                    creditCount,
                    exitStep.underlyingAsset,
                    underAfter - underBefore
                );
            }
        }

        // 2. Pull liquid ERC-20 dust (or consume exact DeFi exit credit) & swap via allowlisted swap aggregators
        for (uint256 i = 0; i < swaps.length; i++) {
            SwapStep calldata s = swaps[i];
            if (s.amountIn == 0) continue;

            if (s.tokenIn == usdc) {
                if (s.pullFromUser) {
                    usdc.safeTransferFrom(capitalOwner, address(this), s.amountIn);
                }
                continue;
            }

            if (!allowedSwapAggregators[s.aggregator] || s.aggregator.code.length == 0) {
                revert TargetNotAllowed(s.aggregator);
            }

            uint256 swapAmount;
            uint256 creditIdx = type(uint256).max;
            if (s.pullFromUser) {
                uint256 balBefore = IERC20(s.tokenIn).balanceOf(address(this));
                s.tokenIn.safeTransferFrom(capitalOwner, address(this), s.amountIn);
                swapAmount = IERC20(s.tokenIn).balanceOf(address(this)) - balBefore;
            } else {
                (creditIdx, swapAmount) = _consumeCredit(
                    creditedTokens,
                    creditedAmounts,
                    creditCount,
                    s.tokenIn,
                    s.amountIn
                );
                if (swapAmount == 0) {
                    revert InsufficientCreditedBalance(s.tokenIn, s.amountIn, 0);
                }
            }

            if (swapAmount == 0) continue;

            uint256 tokenBeforeSwap = IERC20(s.tokenIn).balanceOf(address(this));
            s.tokenIn.forceApprove(s.aggregator, swapAmount);
            (bool ok, ) = s.aggregator.call(s.swapCalldata);
            if (!ok) revert AggregatorSwapFailed(s.aggregator);
            s.tokenIn.forceApprove(s.aggregator, 0);

            uint256 tokenAfterSwap = IERC20(s.tokenIn).balanceOf(address(this));
            uint256 spent = tokenBeforeSwap > tokenAfterSwap ? (tokenBeforeSwap - tokenAfterSwap) : 0;
            if (creditIdx != type(uint256).max) {
                creditedAmounts[creditIdx] = spent >= creditedAmounts[creditIdx]
                    ? 0
                    : creditedAmounts[creditIdx] - spent;
            } else if (swapAmount > spent) {
                s.tokenIn.safeTransfer(capitalOwner, swapAmount - spent);
            }
        }

        // Refund any unswapped non-USDC tokens withdrawn from user's DeFi positions back to capitalOwner
        for (uint256 i = 0; i < creditCount; i++) {
            if (creditedAmounts[i] > 0) {
                creditedTokens[i].safeTransfer(capitalOwner, creditedAmounts[i]);
            }
        }
    }

    function _executeTrailingBurns(
        address capitalOwner,
        BurnStep[] calldata burns
    ) private returns (uint256 burnedCount, uint256 skippedBurns) {
        for (uint256 i = 0; i < burns.length; i++) {
            BurnStep calldata b = burns[i];
            if (b.token == usdc) revert InvalidBurnToken(b.token);
            if (b.amount == 0) continue;
            if (_safeBurnTransferFrom(b.token, capitalOwner, b.amount)) {
                burnedCount++;
                emit DeadTokenBurned(capitalOwner, b.token, b.amount);
            } else {
                skippedBurns++;
                emit DeadTokenSkipped(capitalOwner, b.token, "HONEYPOT_OR_REVERT");
            }
        }
    }

    /**
     * @notice Executes an atomic multi-protocol withdraw + dust swap + Circle CCTP bridge + isolated trailing burns.
     * @dev `params.solanaRecipient` MUST be the user's 32-byte canonical Solana USDC Associated Token Account (ATA) PDA.
     */
    function sweepAndBridgeToSolana(SweepParams calldata params)
        external
        nonReentrant
        returns (uint256 bridgedUsdc, uint64 cctpNonce)
    {
        if (block.timestamp > params.deadline) revert ExpiredDeadline();
        if (params.solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();
        if (params.minNetUsdcOut == 0) revert ZeroMinNetOutput();

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        if (params.directUsdcAmount > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), params.directUsdcAmount);
        }

        _executeExitsAndSwaps(msg.sender, params.defiExits, params.swaps);

        // 3. Compute exact USDC delta, enforce slippage floor AFTER CCTP maxFee, route protocol fee, and bridge 1:1 via Circle CCTP FIRST
        uint256 usdcAfter = IERC20(usdc).balanceOf(address(this));
        if (usdcAfter <= usdcBefore) revert ZeroUsdcOutput();
        uint256 grossUsdc = usdcAfter - usdcBefore;

        (uint256 feeUsdc, ) = _computeProtocolFee(grossUsdc, feeBps, params.maxFeeUsdcCap);
        bridgedUsdc = grossUsdc - feeUsdc;
        uint256 minSolanaReceived = _validateCctpAndComputeMinReceived(bridgedUsdc, params.cctp);
        if (minSolanaReceived < params.minNetUsdcOut) {
            revert SlippageExceeded(minSolanaReceived, params.minNetUsdcOut);
        }

        if (feeUsdc > 0 && feeRecipient != address(0)) {
            usdc.safeTransfer(feeRecipient, feeUsdc);
        }

        cctpNonce = _bridgeUsdcViaCctp(bridgedUsdc, params.solanaRecipient, params.cctp);

        // 4. Execute isolated zero-liquidity burns LAST (after CCTP settlement) with capped gas & 32-byte bounded return copy
        (uint256 burnedCount, uint256 skippedBurns) = _executeTrailingBurns(msg.sender, params.burns);

        emit TurgaliumMigrated(
            msg.sender,
            params.solanaRecipient,
            grossUsdc,
            feeUsdc,
            bridgedUsdc,
            cctpNonce,
            burnedCount,
            skippedBurns
        );
    }

    /**
     * @notice Executes a policy-bounded autonomous agent sweep gated by on-chain `TurgaliumAgentVault.authorizeAgentAction`.
     * @dev Measures actual on-chain post-exit/post-swap USDC deltas before invoking `TurgaliumAgentVault.authorizeAgentAction`,
     *      guaranteeing locked Solana recipient, per-tx USD cap, rolling 24h cap, maxFeeBps, minNetOutBps, and action mask.
     *      When executed by an autonomous agent key (`msg.sender != m.owner`), strictly forbids arbitrary swapCalldata,
     *      non-USDC DeFi exits, arbitrary burns, and CCTP destinationCaller/hookData overrides.
     */
    function sweepWithMandate(
        address agentVault,
        bytes32 mandateId,
        uint8 actionBit,
        SweepParams calldata params
    ) external nonReentrant returns (uint256 bridgedUsdc, uint64 cctpNonce) {
        if (block.timestamp > params.deadline) revert ExpiredDeadline();
        if (params.solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();
        if (params.minNetUsdcOut == 0) revert ZeroMinNetOutput();
        if (agentVault == address(0) || !allowedAgentVaults[agentVault]) {
            revert TargetNotAllowed(agentVault);
        }

        ITurgaliumAgentVault.AgentMandate memory m = ITurgaliumAgentVault(agentVault).getMandate(mandateId);
        if (m.owner == address(0)) revert Unauthorized();
        if (msg.sender != m.agentKey && msg.sender != m.owner) revert Unauthorized();

        bool isAutonomousAgent = (msg.sender != m.owner);
        if (isAutonomousAgent) {
            if (params.swaps.length > 0) revert AgentArbitrarySwapsForbidden();
            if (params.burns.length > 0) revert AgentBurnsForbidden();
            if (params.cctp.destinationCaller != bytes32(0) || params.cctp.hookData.length != 0) {
                revert AgentCctpOverrideForbidden();
            }
            for (uint256 i = 0; i < params.defiExits.length; i++) {
                if (params.defiExits[i].underlyingAsset != usdc) {
                    revert AgentNonUsdcDefiExitForbidden(params.defiExits[i].underlyingAsset);
                }
            }
        }

        // Ensure mandate bitmap permits every step class present in params (not only the single reported actionBit)
        if ((m.allowedActionsMask & ACTION_BRIDGE_SOLANA) == 0) {
            revert MandateActionNotPermitted(ACTION_BRIDGE_SOLANA);
        }
        if (params.defiExits.length > 0 && (m.allowedActionsMask & ACTION_DEFI_WITHDRAW) == 0) {
            revert MandateActionNotPermitted(ACTION_DEFI_WITHDRAW);
        }
        if (params.swaps.length > 0 && (m.allowedActionsMask & ACTION_DUST_CONVERT) == 0) {
            revert MandateActionNotPermitted(ACTION_DUST_CONVERT);
        }
        if (params.burns.length > 0 && (m.allowedActionsMask & ACTION_BURN_ZERO_LIQ) == 0) {
            revert MandateActionNotPermitted(ACTION_BURN_ZERO_LIQ);
        }

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        if (params.directUsdcAmount > 0) {
            usdc.safeTransferFrom(m.owner, address(this), params.directUsdcAmount);
        }

        _executeExitsAndSwaps(m.owner, params.defiExits, params.swaps);

        uint256 usdcAfter = IERC20(usdc).balanceOf(address(this));
        if (usdcAfter <= usdcBefore) revert ZeroUsdcOutput();
        uint256 grossUsdc = usdcAfter - usdcBefore;

        (uint256 feeUsdc, ) = _computeProtocolFee(grossUsdc, feeBps, params.maxFeeUsdcCap);
        bridgedUsdc = grossUsdc - feeUsdc;
        uint256 minSolanaReceived = _validateCctpAndComputeMinReceived(bridgedUsdc, params.cctp);
        if (minSolanaReceived < params.minNetUsdcOut) {
            revert SlippageExceeded(minSolanaReceived, params.minNetUsdcOut);
        }

        uint256 totalDeductions = grossUsdc - minSolanaReceived;
        uint16 totalEffectiveFeeBps = uint16((totalDeductions * 10_000 + grossUsdc - 1) / grossUsdc);

        // Enforce on-chain TurgaliumAgentVault policy caps & locked Solana recipient BEFORE moving fees or bridging
        uint256 execNonce = ++mandateExecutionNonce;
        bytes32 intentDigest = keccak256(
            abi.encode(
                mandateId,
                m.owner,
                msg.sender,
                params.solanaRecipient,
                grossUsdc,
                minSolanaReceived,
                execNonce,
                block.chainid
            )
        );
        ITurgaliumAgentVault(agentVault).authorizeAgentAction(
            mandateId,
            msg.sender,
            actionBit,
            params.solanaRecipient,
            grossUsdc,
            minSolanaReceived,
            totalEffectiveFeeBps,
            intentDigest
        );

        if (feeUsdc > 0 && feeRecipient != address(0)) {
            usdc.safeTransfer(feeRecipient, feeUsdc);
        }

        cctpNonce = _bridgeUsdcViaCctp(bridgedUsdc, params.solanaRecipient, params.cctp);

        (uint256 burnedCount, uint256 skippedBurns) = _executeTrailingBurns(m.owner, params.burns);

        emit MandateSweepExecuted(mandateId, agentVault, m.owner, msg.sender, grossUsdc, bridgedUsdc);
        emit TurgaliumMigrated(
            m.owner,
            params.solanaRecipient,
            grossUsdc,
            feeUsdc,
            bridgedUsdc,
            cctpNonce,
            burnedCount,
            skippedBurns
        );
    }

    function _pullPermit2AndSnapshot(
        address user,
        IPermit2.PermitBatchTransferFrom calldata permit,
        TurgaliumSweepWitness calldata witness,
        bytes calldata permitSignature
    )
        private
        returns (
            address[] memory uniqueTokens,
            uint256[] memory creditedAmounts,
            uint256 uniqueCount
        )
    {
        uint256 len = permit.permitted.length;
        IPermit2.SignatureTransferDetails[] memory details = new IPermit2.SignatureTransferDetails[](len);
        uniqueTokens = new address[](len);
        uint256[] memory preBalances = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            address tok = permit.permitted[i].token;
            details[i] = IPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted[i].amount
            });
            if (tok != usdc) {
                bool seen = false;
                for (uint256 j = 0; j < uniqueCount; j++) {
                    if (uniqueTokens[j] == tok) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) {
                    uniqueTokens[uniqueCount] = tok;
                    preBalances[uniqueCount] = IERC20(tok).balanceOf(address(this));
                    uniqueCount++;
                }
            }
        }

        bytes32 witnessHash = keccak256(
            abi.encode(
                TURGALIUM_WITNESS_TYPEHASH,
                witness.solanaRecipient,
                witness.minNetUsdcOut,
                witness.maxGasReimbursementUsdc,
                witness.feeBps,
                witness.feeRecipient,
                witness.swapsHash
            )
        );
        PERMIT2.permitWitnessTransferFrom(
            permit,
            details,
            user,
            witnessHash,
            TURGALIUM_WITNESS_TYPESTRING,
            permitSignature
        );

        creditedAmounts = new uint256[](uniqueCount);
        for (uint256 i = 0; i < uniqueCount; i++) {
            uint256 postBal = IERC20(uniqueTokens[i]).balanceOf(address(this));
            creditedAmounts[i] = postBal > preBalances[i] ? (postBal - preBalances[i]) : 0;
        }
    }

    function _executePermit2SwapsAndRefund(
        address user,
        SwapStep[] calldata swaps,
        address[] memory uniqueTokens,
        uint256[] memory creditedAmounts,
        uint256 uniqueCount
    ) private {
        for (uint256 i = 0; i < swaps.length; i++) {
            SwapStep calldata s = swaps[i];
            if (s.amountIn == 0 || s.tokenIn == usdc) continue;
            if (!allowedSwapAggregators[s.aggregator] || s.aggregator.code.length == 0) {
                revert TargetNotAllowed(s.aggregator);
            }

            (uint256 creditIdx, uint256 swapAmount) = _consumeCredit(
                uniqueTokens,
                creditedAmounts,
                uniqueCount,
                s.tokenIn,
                s.amountIn
            );
            if (swapAmount == 0) continue;

            uint256 tokenBeforeSwap = IERC20(s.tokenIn).balanceOf(address(this));
            s.tokenIn.forceApprove(s.aggregator, swapAmount);
            (bool ok, ) = s.aggregator.call(s.swapCalldata);
            if (!ok) revert AggregatorSwapFailed(s.aggregator);
            s.tokenIn.forceApprove(s.aggregator, 0);

            uint256 tokenAfterSwap = IERC20(s.tokenIn).balanceOf(address(this));
            uint256 spent = tokenBeforeSwap > tokenAfterSwap ? (tokenBeforeSwap - tokenAfterSwap) : 0;
            creditedAmounts[creditIdx] = spent >= creditedAmounts[creditIdx]
                ? 0
                : creditedAmounts[creditIdx] - spent;
        }

        // Refund any unswapped non-USDC permitted tokens back to `user` (prevents stranding/theft)
        for (uint256 i = 0; i < uniqueCount; i++) {
            if (creditedAmounts[i] > 0) {
                uniqueTokens[i].safeTransfer(user, creditedAmounts[i]);
            }
        }
    }

    /**
     * @notice Witness-bound gasless 1-signature sweep via Uniswap Permit2 permitWitnessTransferFrom.
     *         The user's SINGLE off-chain EIP-712 signature cryptographically locks solanaRecipient (USDC ATA PDA),
     *         minNetUsdcOut, maxGasReimbursementUsdc, feeBps, feeRecipient, AND swapsHash.
     */
    function sweepWithPermit2Batch(
        address user,
        IPermit2.PermitBatchTransferFrom calldata permit,
        TurgaliumSweepWitness calldata witness,
        bytes calldata permitSignature,
        uint256 gasReimbursementUsdc,
        SwapStep[] calldata swaps
    ) external nonReentrant returns (uint256 bridgedUsdc, uint64 cctpNonce) {
        if (user == address(0) || witness.feeRecipient == address(0)) revert InvalidAddress();
        if (witness.solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();
        if (witness.minNetUsdcOut == 0) revert ZeroMinNetOutput();
        if (block.timestamp > permit.deadline) revert ExpiredDeadline();
        if (!allowedFeeRecipients[witness.feeRecipient]) {
            revert UnauthorizedFeeRecipient(witness.feeRecipient);
        }
        if (witness.feeBps < feeBps || witness.feeBps < MIN_FEE_BPS || witness.feeBps > MAX_FEE_BPS) {
            revert FeeOutOfBounds(witness.feeBps);
        }
        if (gasReimbursementUsdc > 0 && !allowedRelayers[msg.sender]) {
            revert Unauthorized();
        }
        if (gasReimbursementUsdc > witness.maxGasReimbursementUsdc) {
            revert SlippageExceeded(0, witness.minNetUsdcOut);
        }
        if (keccak256(abi.encode(swaps)) != witness.swapsHash) {
            revert InvalidSwapsHash();
        }

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        {
            // 1. Snapshot exact pre-balances per permitted token & pull via witness-bound Permit2 signature
            (
                address[] memory uniqueTokens,
                uint256[] memory creditedAmounts,
                uint256 uniqueCount
            ) = _pullPermit2AndSnapshot(user, permit, witness, permitSignature);

            // 2. Swap strictly the current call's credited token deltas & refund any residual non-USDC tokens
            _executePermit2SwapsAndRefund(user, swaps, uniqueTokens, creditedAmounts, uniqueCount);
        }

        // 3. Account exact USDC delta, enforce break-even & slippage floor, reimburse gas, route fee, & bridge
        uint256 usdcAfter = IERC20(usdc).balanceOf(address(this));
        if (usdcAfter <= usdcBefore) revert ZeroUsdcOutput();
        uint256 grossUsdc = usdcAfter - usdcBefore;

        (uint256 feeUsdc, ) = _computeProtocolFee(grossUsdc, witness.feeBps, 0);
        // Onchain Relayer Break-Even Protection: require protocolFee + gasReimbursement >= ceil(1.5x sponsored gas)
        if (gasReimbursementUsdc > 0) {
            uint256 relayerRevenue = feeUsdc + gasReimbursementUsdc;
            uint256 requiredCoverage = (gasReimbursementUsdc * 3 + 1) / 2;
            if (relayerRevenue < requiredCoverage) {
                revert RelayerBreakEvenNotMet(relayerRevenue, requiredCoverage);
            }
        }
        uint256 deductions = feeUsdc + gasReimbursementUsdc;
        if (grossUsdc <= deductions) revert SlippageExceeded(0, witness.minNetUsdcOut);

        bridgedUsdc = grossUsdc - deductions;
        if (bridgedUsdc < witness.minNetUsdcOut) revert SlippageExceeded(bridgedUsdc, witness.minNetUsdcOut);

        if (gasReimbursementUsdc > 0) {
            usdc.safeTransfer(msg.sender, gasReimbursementUsdc);
        }
        if (feeUsdc > 0) {
            usdc.safeTransfer(witness.feeRecipient, feeUsdc);
        }

        cctpNonce = _bridgeUsdcViaCctp(bridgedUsdc, witness.solanaRecipient);

        emit TurgaliumMigrated(
            user,
            witness.solanaRecipient,
            grossUsdc,
            feeUsdc,
            bridgedUsdc,
            cctpNonce,
            0,
            0
        );
    }
}
