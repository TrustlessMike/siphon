// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SiphonRouter
 * @notice Single-signature EVM-to-Solana migrator router.
 *
 * Security-hardened execution flow:
 *   1. Uses hardened SafeERC20Lite (code.length > 0, safe 32-byte bool check, OZ-style forceApprove)
 *   2. Enforces strictly disjoint allowlists: allowedDefiProtocols vs allowedSwapAggregators
 *   3. Validates Aave v3 aToken against Pool.getReserveData(underlyingAsset) and tracks exact per-call received deltas
 *   4. Binds swapsHash in Permit2 witness, enforces owner-allowlisted feeRecipient & relayers, refunds residual tokens
 *   5. Bridges consolidated net native USDC via Circle CCTP V1 or V2 to the user's 32-byte Solana USDC ATA PDA
 *      (NEVER pass a raw Solana wallet owner pubkey — Circle Solana TokenMessengerMinter requires the canonical USDC ATA!)
 *   6. Executes isolated zero-liquidity token burns LAST with capped gas & 32-byte bounded return copy (return-bomb safe)
 *   7. Two-step ownership transfer, hard-bounded protocol fee (500 - 1000 bps), and safe ETH/ERC-20 rescue
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
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}

interface IERC4626Vault {
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

contract SiphonRouter {
    using SafeERC20Lite for address;

    /// @notice Canonical burn sink for verifiable zero-liquidity token disposal.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Canonical Uniswap Permit2 contract deployed identically across supported EVM chains.
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    /// @notice Gas cap for isolated zero-liquidity burn calls to prevent 63/64ths gas griefing.
    uint256 public constant BURN_GAS_STIPEND = 100_000;

    /// @notice Circle CCTP V2 standard finality threshold (2000 = finalized, 1000 = fast transfer).
    uint32 public constant CCTP_V2_STANDARD_FINALITY = 2000;

    bytes32 public constant SIPHON_WITNESS_TYPEHASH = keccak256(
        "SiphonSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)"
    );
    string public constant SIPHON_WITNESS_TYPESTRING =
        "SiphonSweepWitness witness)SiphonSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)TokenPermissions(address token,uint256 amount)";

    struct SiphonSweepWitness {
        /// @dev Canonical 32-byte Solana USDC Associated Token Account (ATA) PDA — NEVER a raw wallet pubkey.
        bytes32 solanaRecipient;
        uint256 minNetUsdcOut;
        uint256 maxGasReimbursementUsdc;
        uint16 feeBps;
        address feeRecipient;
        /// @dev keccak256(abi.encode(swaps)) binding exact swap calldata to the user's Permit2 signature.
        bytes32 swapsHash;
    }

    /// @notice Circle CCTP destination domain ID for Solana Mainnet.
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;

    /// @notice Protocol fee bounds: 5.00% (500 bps) minimum, 10.00% (1000 bps) maximum. Default: 700 bps (7.0%).
    uint16 public constant MIN_FEE_BPS = 500;
    uint16 public constant MAX_FEE_BPS = 1000;

    address public immutable usdc;
    address public immutable cctpMessenger;
    /// @notice Circle CCTP version deployed on this chain: 1 (4-arg TokenMessenger) or 2 (7-arg TokenMessengerV2).
    uint8 public immutable cctpVersion;

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint16 public feeBps;
    uint256 private _reentrancyGuard = 1;

    /// @notice Disjoint allowlist for DEX swap aggregators (callable via swapCalldata). Never contains DeFi protocols or tokens.
    mapping(address => bool) public allowedSwapAggregators;

    /// @notice Disjoint allowlist for typed DeFi exit protocols (Aave v3 Pool, Compound v3 Comet, ERC-4626 Vaults).
    mapping(address => bool) public allowedDefiProtocols;

    /// @notice Owner-configured protocol treasury allowlist (prevents witness.feeRecipient fee-bypass hijacking).
    mapping(address => bool) public allowedFeeRecipients;

    /// @notice Owner-configured sponsor relayer allowlist (prevents MEV frontrunning of gasReimbursementUsdc).
    mapping(address => bool) public allowedRelayers;

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
        uint256 minNetUsdcOut;
        uint256 deadline;
        DefiExitStep[] defiExits;
        SwapStep[] swaps;
        BurnStep[] burns;
    }

    event SiphonMigrated(
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 grossUsdc,
        uint256 feeUsdc,
        uint256 bridgedUsdc,
        uint64 cctpNonce,
        uint256 burnedCount,
        uint256 skippedBurns
    );

    event DeadTokenBurned(address indexed user, address indexed token, uint256 amount);
    event DeadTokenSkipped(address indexed user, address indexed token, string reason);
    event SwapAggregatorUpdated(address indexed aggregator, bool allowed);
    event DefiProtocolUpdated(address indexed protocol, bool allowed);
    event FeeRecipientAllowlistUpdated(address indexed recipient, bool allowed);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeUpdated(address indexed feeRecipient, uint16 feeBps);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error ExpiredDeadline();
    error InvalidAddress();
    error InvalidSolanaRecipient();
    error InvalidCctpVersion(uint8 version);
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
        if (_usdc == address(0) || _cctpMessenger == address(0) || _feeRecipient == address(0)) {
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
            if (allowedDefiProtocols[aggregator]) revert DisjointAllowlistViolation(aggregator);
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

    function setFeeParams(address _feeRecipient, uint16 _feeBps) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        if (_feeBps < MIN_FEE_BPS || _feeBps > MAX_FEE_BPS) revert FeeOutOfBounds(_feeBps);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        allowedFeeRecipients[_feeRecipient] = true;
        emit FeeUpdated(_feeRecipient, _feeBps);
        emit FeeRecipientAllowlistUpdated(_feeRecipient, true);
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

    function _bridgeUsdcViaCctp(uint256 amount, bytes32 solanaUsdcAta) private returns (uint64 cctpNonce) {
        usdc.forceApprove(cctpMessenger, amount);
        if (cctpVersion == 2) {
            ITokenMessengerCCTPV2(cctpMessenger).depositForBurn(
                amount,
                SOLANA_CCTP_DOMAIN,
                solanaUsdcAta,
                usdc,
                bytes32(0),
                0,
                CCTP_V2_STANDARD_FINALITY
            );
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

        {
            // Track exact per-token received deltas from DeFi exits so pullFromUser=false can NEVER touch residual router balances.
            uint256 maxCredits = params.defiExits.length;
            address[] memory creditedTokens = new address[](maxCredits);
            uint256[] memory creditedAmounts = new uint256[](maxCredits);
            uint256 creditCount = 0;

            // 1. Withdraw user capital from strictly allowlisted DeFi protocols
            for (uint256 i = 0; i < params.defiExits.length; i++) {
                DefiExitStep calldata exitStep = params.defiExits[i];
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
                        ? IERC20(exitStep.receiptToken).balanceOf(msg.sender)
                        : exitStep.amount;
                    if (pullAmount == 0) continue;

                    uint256 aBalBefore = IERC20(exitStep.receiptToken).balanceOf(address(this));
                    exitStep.receiptToken.safeTransferFrom(msg.sender, address(this), pullAmount);
                    uint256 aReceived = IERC20(exitStep.receiptToken).balanceOf(address(this)) - aBalBefore;

                    IAaveV3Pool(exitStep.protocol).withdraw(
                        exitStep.underlyingAsset,
                        aReceived,
                        address(this)
                    );
                } else if (exitStep.kind == DefiKind.COMPOUND_V3_WITHDRAW) {
                    ICompoundV3Comet(exitStep.protocol).withdrawFrom(
                        msg.sender,
                        address(this),
                        exitStep.underlyingAsset,
                        exitStep.amount
                    );
                } else if (exitStep.kind == DefiKind.ERC4626_REDEEM) {
                    IERC4626Vault(exitStep.protocol).redeem(
                        exitStep.amount,
                        address(this),
                        msg.sender
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
            for (uint256 i = 0; i < params.swaps.length; i++) {
                SwapStep calldata s = params.swaps[i];
                if (s.amountIn == 0) continue;

                if (s.tokenIn == usdc) {
                    if (s.pullFromUser) {
                        usdc.safeTransferFrom(msg.sender, address(this), s.amountIn);
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
                    s.tokenIn.safeTransferFrom(msg.sender, address(this), s.amountIn);
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

                if (creditIdx != type(uint256).max) {
                    uint256 tokenAfterSwap = IERC20(s.tokenIn).balanceOf(address(this));
                    uint256 spent = tokenBeforeSwap > tokenAfterSwap ? (tokenBeforeSwap - tokenAfterSwap) : 0;
                    creditedAmounts[creditIdx] = spent >= creditedAmounts[creditIdx]
                        ? 0
                        : creditedAmounts[creditIdx] - spent;
                }
            }

            // Refund any unswapped non-USDC tokens withdrawn from user's DeFi positions back to msg.sender
            for (uint256 i = 0; i < creditCount; i++) {
                if (creditedAmounts[i] > 0) {
                    creditedTokens[i].safeTransfer(msg.sender, creditedAmounts[i]);
                }
            }
        }

        // 3. Compute exact USDC delta, enforce slippage floor, route protocol fee, and bridge 1:1 via Circle CCTP FIRST
        uint256 usdcAfter = IERC20(usdc).balanceOf(address(this));
        if (usdcAfter <= usdcBefore) revert ZeroUsdcOutput();
        uint256 grossUsdc = usdcAfter - usdcBefore;

        uint256 feeUsdc = (grossUsdc * feeBps) / 10_000;
        bridgedUsdc = grossUsdc - feeUsdc;
        if (bridgedUsdc < params.minNetUsdcOut) {
            revert SlippageExceeded(bridgedUsdc, params.minNetUsdcOut);
        }

        if (feeUsdc > 0 && feeRecipient != address(0)) {
            usdc.safeTransfer(feeRecipient, feeUsdc);
        }

        cctpNonce = _bridgeUsdcViaCctp(bridgedUsdc, params.solanaRecipient);

        // 4. Execute isolated zero-liquidity burns LAST (after CCTP settlement) with capped gas & 32-byte bounded return copy
        uint256 burnedCount = 0;
        uint256 skippedBurns = 0;
        for (uint256 i = 0; i < params.burns.length; i++) {
            BurnStep calldata b = params.burns[i];
            if (b.amount == 0) continue;
            if (_safeBurnTransferFrom(b.token, msg.sender, b.amount)) {
                burnedCount++;
                emit DeadTokenBurned(msg.sender, b.token, b.amount);
            } else {
                skippedBurns++;
                emit DeadTokenSkipped(msg.sender, b.token, "HONEYPOT_OR_REVERT");
            }
        }

        emit SiphonMigrated(
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

    function _pullPermit2AndSnapshot(
        address user,
        IPermit2.PermitBatchTransferFrom calldata permit,
        SiphonSweepWitness calldata witness,
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
                SIPHON_WITNESS_TYPEHASH,
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
            SIPHON_WITNESS_TYPESTRING,
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
        SiphonSweepWitness calldata witness,
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

        uint256 feeUsdc = (grossUsdc * witness.feeBps) / 10_000;
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

        emit SiphonMigrated(
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
