// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { TurgaliumRouter, IERC20, IAaveV3Pool } from "../TurgaliumRouter.sol";
import { TurgaliumAgentVault } from "../TurgaliumAgentVault.sol";

interface IAaveV3SupplyPool is IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

/**
 * @title TurgaliumMainnetForkTest
 * @notice Verifies TurgaliumRouter + TurgaliumAgentVault against live forked Ethereum Mainnet bytecode & state:
 *         - Circle TokenMessengerV2 (`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`)
 *         - Native Ethereum USDC    (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`)
 *         - Uniswap Permit2         (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)
 *         - Aave v3 Pool            (`0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`)
 *         - Aave v3 aEthUSDC        (`0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c`)
 *
 * Skips cleanly when `MAINNET_RPC_URL` is unset (offline CI); runs full forked execution when provided.
 */
contract TurgaliumMainnetForkTest is TestBase {
    address internal constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant MAINNET_CCTP_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address internal constant MAINNET_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant MAINNET_AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant MAINNET_AETH_USDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;

    // Canonical Solana USDC ATA PDA (non-zero 32-byte off-curve PDA)
    bytes32 internal constant SOLANA_USDC_ATA =
        0x4c9e8b5f2a1d3e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7;

    bool internal forkActive;
    TurgaliumRouter internal router;
    TurgaliumAgentVault internal agentVault;

    address internal user = address(0x51F01);
    address internal agent = address(0x51F02);
    address internal treasury = address(0x51F03);

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            forkActive = false;
            return;
        }
        vm.createSelectFork(rpcUrl);
        forkActive = true;

        router = new TurgaliumRouter(MAINNET_USDC, MAINNET_CCTP_V2, 2, treasury, 25);
        router.setAllowedDefiProtocol(MAINNET_AAVE_V3_POOL, true);
        router.setMaxFeeUsdcCap(15e6); // $15 whale fee cap

        agentVault = new TurgaliumAgentVault(address(router));
        router.setAllowedAgentVault(address(agentVault), true);
    }

    function _fundMainnetUsdc(address to, uint256 amount) internal {
        // Aave v3 aEthUSDC holds deep liquid mainnet USDC reserves at every block
        vm.prank(MAINNET_AETH_USDC);
        require(IERC20(MAINNET_USDC).transfer(to, amount), "MAINNET_USDC_FUND_FAILED");
    }

    function testFork_VerifyCanonicalMainnetBytecodeAndAaveReserve() public {
        if (!forkActive) {
            vm.skip(true);
            return;
        }
        assertGt(MAINNET_CCTP_V2.code.length, 0, "Circle TokenMessengerV2 missing bytecode");
        assertGt(MAINNET_USDC.code.length, 0, "Mainnet USDC missing bytecode");
        assertGt(MAINNET_PERMIT2.code.length, 0, "Uniswap Permit2 missing bytecode");
        assertGt(MAINNET_AAVE_V3_POOL.code.length, 0, "Aave v3 Pool missing bytecode");

        address onchainAToken = IAaveV3Pool(MAINNET_AAVE_V3_POOL).getReserveData(MAINNET_USDC).aTokenAddress;
        assertEq(onchainAToken, MAINNET_AETH_USDC, "Aave v3 aEthUSDC reserve mismatch");
    }

    function testFork_DirectUsdcSweepAndWhaleCapIntoLiveCctpV2() public {
        if (!forkActive) {
            vm.skip(true);
            return;
        }

        // Whale $20,000 USDC sweep at 25 bps -> uncapped would be $50, capped on-chain at $15!
        uint256 sweepAmount = 20_000e6;
        _fundMainnetUsdc(user, sweepAmount);

        vm.startPrank(user);
        require(IERC20(MAINNET_USDC).approve(address(router), sweepAmount), "APPROVE_FAILED");

        TurgaliumRouter.SweepParams memory params = TurgaliumRouter.SweepParams({
            solanaRecipient: SOLANA_USDC_ATA,
            directUsdcAmount: sweepAmount,
            minNetUsdcOut: 19_985e6,
            maxFeeUsdcCap: 15e6,
            deadline: block.timestamp + 600,
            cctp: TurgaliumRouter.CctpV2Options({
                destinationCaller: bytes32(0),
                maxFee: 0,
                minFinalityThreshold: 2000, // Standard finality
                hookData: ""
            }),
            defiExits: new TurgaliumRouter.DefiExitStep[](0),
            swaps: new TurgaliumRouter.SwapStep[](0),
            burns: new TurgaliumRouter.BurnStep[](0)
        });

        (uint256 bridgedUsdc, ) = router.sweepAndBridgeToSolana(params);
        vm.stopPrank();

        assertEq(IERC20(MAINNET_USDC).balanceOf(treasury), 15e6, "Whale $15 fee cap must apply on mainnet");
        assertEq(bridgedUsdc, 19_985e6, "Bridged amount mismatch");
        assertEq(IERC20(MAINNET_USDC).balanceOf(address(router)), 0, "Zero residual USDC on router");
        assertEq(IERC20(MAINNET_USDC).balanceOf(user), 0, "User USDC swept cleanly");
    }

    function testFork_AaveV3WithdrawAndMandateSweepIntoLiveCctpV2FastTransfer() public {
        if (!forkActive) {
            vm.skip(true);
            return;
        }

        // 1. Supply 5,000 real mainnet USDC into real Aave v3 Pool to mint real aEthUSDC
        uint256 supplyAmount = 5_000e6;
        _fundMainnetUsdc(user, supplyAmount);

        vm.startPrank(user);
        require(IERC20(MAINNET_USDC).approve(MAINNET_AAVE_V3_POOL, supplyAmount), "AAVE_APPROVE_FAILED");
        IAaveV3SupplyPool(MAINNET_AAVE_V3_POOL).supply(MAINNET_USDC, supplyAmount, user, 0);

        uint256 aBal = IERC20(MAINNET_AETH_USDC).balanceOf(user);
        assertGe(aBal, supplyAmount - 10, "aEthUSDC mint too low");

        // 2. Grant TurgaliumAgentVault mandate for autonomous agent DeFi unwind + Solana bridge
        bytes32 mandateId = agentVault.grantMandate(
            agent,
            SOLANA_USDC_ATA,
            10_000e6,
            25_000e6,
            7 days,
            50,   // max 0.50% fee
            9900, // >= 99% net preservation
            agentVault.ACTION_DEFI_WITHDRAW() | agentVault.ACTION_BRIDGE_SOLANA()
        );

        // Approve TurgaliumRouter to pull user's aEthUSDC
        require(IERC20(MAINNET_AETH_USDC).approve(address(router), aBal), "AUSDC_APPROVE_FAILED");
        vm.stopPrank();

        // 3. Autonomous agent executes Aave v3 withdraw -> Circle CCTP V2 Fast Transfer (minFinalityThreshold = 1000)
        TurgaliumRouter.DefiExitStep[] memory exits = new TurgaliumRouter.DefiExitStep[](1);
        exits[0] = TurgaliumRouter.DefiExitStep({
            kind: TurgaliumRouter.DefiKind.AAVE_V3_WITHDRAW,
            protocol: MAINNET_AAVE_V3_POOL,
            receiptToken: MAINNET_AETH_USDC,
            underlyingAsset: MAINNET_USDC,
            amount: 4_000e6
        });

        TurgaliumRouter.SweepParams memory params = TurgaliumRouter.SweepParams({
            solanaRecipient: SOLANA_USDC_ATA,
            directUsdcAmount: 0,
            minNetUsdcOut: 3_980e6,
            maxFeeUsdcCap: 15e6,
            deadline: block.timestamp + 600,
            cctp: TurgaliumRouter.CctpV2Options({
                destinationCaller: bytes32(0),
                maxFee: 5e6, // 0.125% fast fee ceiling (total 25 bps protocol + 12.5 bps CCTP = 38 bps <= 50 bps mandate cap)
                minFinalityThreshold: 1000, // CCTP V2 Fast Transfer
                hookData: ""
            }),
            defiExits: exits,
            swaps: new TurgaliumRouter.SwapStep[](0),
            burns: new TurgaliumRouter.BurnStep[](0)
        });

        uint8 actionDefi = agentVault.ACTION_DEFI_WITHDRAW();
        vm.prank(agent);
        (uint256 bridgedUsdc, ) = router.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionDefi,
            params
        );

        // 4,000 USDC @ 25 bps = 10 USDC fee -> 3,990 USDC burned via live Circle TokenMessengerV2 Fast Transfer!
        assertEq(IERC20(MAINNET_USDC).balanceOf(treasury), 10e6, "Treasury received 25 bps fee");
        assertEq(bridgedUsdc, 3_990e6, "Bridged USDC mismatch");
        assertEq(IERC20(MAINNET_USDC).balanceOf(address(router)), 0, "Zero residual USDC on router");
        assertEq(IERC20(MAINNET_AETH_USDC).balanceOf(address(router)), 0, "Zero residual aEthUSDC on router");
    }
}
