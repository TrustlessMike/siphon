// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IAaveV3Pool, IPermit2 } from "../SiphonRouter.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blacklisted[msg.sender] && !blacklisted[to], "BLACKLISTED");
        require(balanceOf[msg.sender] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!blacklisted[from] && !blacklisted[to], "BLACKLISTED");
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "INSUFFICIENT_ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Malicious honeypot ERC-20 that attempts return-bombing & reverts on transfer/transferFrom.
contract MockHoneypotReturnBombToken {
    function transfer(address, uint256) external pure returns (bool) {
        assembly {
            // Return 100 KB of garbage to test return-bomb immunity
            revert(0, 102400)
        }
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        assembly {
            revert(0, 102400)
        }
    }
}

contract MockTokenMessengerV1 {
    uint64 public nextNonce = 1;
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    uint256 public callCount;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce) {
        require(MockERC20(burnToken).transferFrom(msg.sender, address(this), amount), "PULL_FAILED");
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        callCount++;
        nonce = nextNonce++;
    }
}

contract MockTokenMessengerV2 {
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    bytes public lastHookData;
    bool public lastUsedHook;
    uint256 public callCount;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(MockERC20(burnToken).transferFrom(msg.sender, address(this), amount), "PULL_FAILED");
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastHookData = "";
        lastUsedHook = false;
        callCount++;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(MockERC20(burnToken).transferFrom(msg.sender, address(this), amount), "PULL_FAILED");
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastHookData = hookData;
        lastUsedHook = true;
        callCount++;
    }
}

contract MockSwapAggregator {
    MockERC20 public immutable usdc;

    constructor(address _usdc) {
        usdc = MockERC20(_usdc);
    }

    function swapExactToUsdc(address tokenIn, uint256 amountIn, uint256 usdcOut) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "PULL_IN_FAILED");
        require(usdc.transfer(msg.sender, usdcOut), "USDC_OUT_FAILED");
    }

    function swapPartialToUsdc(address tokenIn, uint256 pullAmount, uint256 usdcOut) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), pullAmount), "PULL_IN_FAILED");
        require(usdc.transfer(msg.sender, usdcOut), "USDC_OUT_FAILED");
    }

    function swapEthToUsdc(uint256 usdcOut) external payable {
        require(msg.value > 0, "NO_ETH");
        require(usdc.transfer(msg.sender, usdcOut), "USDC_OUT_FAILED");
    }
}

contract MockAaveV3Pool {
    mapping(address => address) public aTokens;

    function setReserve(address asset, address aToken) external {
        aTokens[asset] = aToken;
    }

    function getReserveData(address asset) external view returns (IAaveV3Pool.ReserveData memory data) {
        data.aTokenAddress = aTokens[asset];
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        address aToken = aTokens[asset];
        require(aToken != address(0), "NO_RESERVE");
        require(MockERC20(aToken).balanceOf(msg.sender) >= amount, "INSUFFICIENT_ATOKEN");
        // Pull or burn aToken from msg.sender by transferring via internal mock flow
        MockERC20(asset).mint(to, amount);
        return amount;
    }
}

contract MockCompoundV3Comet {
    mapping(address => mapping(address => uint256)) public balances;

    function creditUser(address user, address asset, uint256 amount) external {
        balances[user][asset] += amount;
    }

    function withdrawFrom(address src, address to, address asset, uint256 amount) external {
        require(balances[src][asset] >= amount, "INSUFFICIENT_COMET");
        balances[src][asset] -= amount;
        MockERC20(asset).mint(to, amount);
    }

    function withdraw(address asset, uint256 amount) external {
        require(balances[msg.sender][asset] >= amount, "INSUFFICIENT_COMET");
        balances[msg.sender][asset] -= amount;
        MockERC20(asset).mint(msg.sender, amount);
    }
}

contract MockERC4626Vault {
    address public immutable asset;
    mapping(address => uint256) public shares;

    constructor(address _asset) {
        asset = _asset;
    }

    function mintShares(address owner, uint256 shareAmount) external {
        shares[owner] += shareAmount;
    }

    function redeem(uint256 shareAmount, address receiver, address owner) external returns (uint256 assets) {
        require(shares[owner] >= shareAmount, "INSUFFICIENT_SHARES");
        shares[owner] -= shareAmount;
        assets = shareAmount;
        MockERC20(asset).mint(receiver, assets);
    }
}

contract MockPermit2 {
    bytes32 public lastWitness;
    string public lastWitnessTypeString;

    function permitWitnessTransferFrom(
        IPermit2.PermitBatchTransferFrom calldata permit,
        IPermit2.SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "PERMIT_EXPIRED");
        require(signature.length == 65, "BAD_SIG_LEN");
        require(permit.permitted.length == transferDetails.length, "LEN_MISMATCH");
        lastWitness = witness;
        lastWitnessTypeString = witnessTypeString;
        for (uint256 i = 0; i < permit.permitted.length; i++) {
            require(transferDetails[i].requestedAmount <= permit.permitted[i].amount, "OVER_PERMITTED");
            require(
                MockERC20(permit.permitted[i].token).transferFrom(
                    owner,
                    transferDetails[i].to,
                    transferDetails[i].requestedAmount
                ),
                "PERMIT2_TRANSFER_FAILED"
            );
        }
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("NO_ETH_ACCEPTED");
    }
}
