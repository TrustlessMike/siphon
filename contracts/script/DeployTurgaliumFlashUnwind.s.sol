// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TurgaliumFlashUnwind } from "../TurgaliumFlashUnwind.sol";

interface IVmFlashScript {
    function startBroadcast() external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external pure returns (address);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, bytes32 defaultValue) external view returns (bytes32);
}

/**
 * @title DeployTurgaliumFlashUnwind
 * @notice Deterministic CREATE2 deployment script for `TurgaliumFlashUnwind` across Monad (Neverland)
 *         and all Aave V3 / fork EVM chains. Pre-seeds each chain's canonical audited Aave V3 Pool(s)
 *         and canonical DEX aggregators (KyberSwap MetaAggregationRouterV2, LI.FI Diamond, OpenOcean).
 *
 * Usage (dry-run):
 *   forge script contracts/script/DeployTurgaliumFlashUnwind.s.sol:DeployTurgaliumFlashUnwind \
 *     --rpc-url https://rpc.monad.xyz -vvv
 */
contract DeployTurgaliumFlashUnwind {
    IVmFlashScript private constant vm =
        IVmFlashScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 public constant DEFAULT_SALT = keccak256("TURGALIUM_FLASH_UNWIND_V1");

    // Canonical multi-chain DEX aggregator routers (same addresses across EVM chains)
    address public constant KYBERSWAP_ROUTER_V2 = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address public constant LIFI_DIAMOND = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    address public constant LIFI_DIAMOND_MONAD = 0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37;
    address public constant OPENOCEAN_EXCHANGE = 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64;

    function getChainPools(uint256 chainId) public pure returns (address[] memory pools) {
        if (chainId == 143) {
            // Monad Mainnet — Neverland Pool
            pools = new address[](1);
            pools[0] = 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585;
        } else if (chainId == 1) {
            // Ethereum — Aave V3 + SparkLend
            pools = new address[](2);
            pools[0] = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
            pools[1] = 0xC13e21B648A5Ee794902342038FF3aDAB66BE987;
        } else if (chainId == 8453) {
            // Base — Aave V3 + Seamless
            pools = new address[](2);
            pools[0] = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
            pools[1] = 0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7;
        } else if (chainId == 42161 || chainId == 10 || chainId == 137 || chainId == 43114) {
            // Arbitrum, Optimism, Polygon, Avalanche — canonical Aave V3 Pool
            pools = new address[](1);
            pools[0] = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        } else if (chainId == 534352) {
            // Scroll — Aave V3
            pools = new address[](1);
            pools[0] = 0x11fCfe756c05AD438e312a7fd934381537D3cFfe;
        } else if (chainId == 324) {
            // zkSync Era — Aave V3
            pools = new address[](1);
            pools[0] = 0x78e30497a3c7527d953c6B1E3541b021A98Ac43c;
        } else if (chainId == 57073) {
            // Ink — Aave V3
            pools = new address[](1);
            pools[0] = 0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA;
        } else if (chainId == 56) {
            // BNB Chain — Aave V3
            pools = new address[](1);
            pools[0] = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
        } else if (chainId == 100) {
            // Gnosis — Aave V3 + SparkLend
            pools = new address[](2);
            pools[0] = 0xb50201558B00496A145fE76f7424749556E326D8;
            pools[1] = 0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0;
        } else if (chainId == 5000) {
            // Mantle — Lendle (Aave V3 fork)
            pools = new address[](1);
            pools[0] = 0xCFa5aE7c2CE8Fadc6426C1ff872cA45378Fb7cF3;
        } else if (chainId == 59144) {
            // Linea — Aave V3
            pools = new address[](1);
            pools[0] = 0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac;
        } else if (chainId == 146) {
            // Sonic — Aave V3
            pools = new address[](1);
            pools[0] = 0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3;
        } else if (chainId == 999) {
            // HyperEVM — HyperLend (Aave V3 fork)
            pools = new address[](1);
            pools[0] = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
        } else if (chainId == 42220) {
            // Celo — Aave V3
            pools = new address[](1);
            pools[0] = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
        } else {
            pools = new address[](0);
        }
    }

    function getChainRouters(uint256 chainId) public pure returns (address[] memory routers) {
        if (chainId == 143) {
            routers = new address[](3);
            routers[0] = KYBERSWAP_ROUTER_V2;
            routers[1] = LIFI_DIAMOND_MONAD;
            routers[2] = OPENOCEAN_EXCHANGE;
        } else {
            routers = new address[](3);
            routers[0] = KYBERSWAP_ROUTER_V2;
            routers[1] = LIFI_DIAMOND;
            routers[2] = OPENOCEAN_EXCHANGE;
        }
    }

    function run() external returns (TurgaliumFlashUnwind deployed) {
        uint256 pk = vm.envOr("TURGALIUM_DEPLOYER_PRIVATE_KEY", uint256(0));
        address defaultOwner = pk != 0 ? vm.addr(pk) : address(0x1111111111111111111111111111111111111111);
        address ownerAddr = vm.envOr("TURGALIUM_OWNER", defaultOwner);
        bytes32 salt = vm.envOr("TURGALIUM_FLASH_UNWIND_SALT", DEFAULT_SALT);

        address[] memory pools = getChainPools(block.chainid);
        address[] memory routers = getChainRouters(block.chainid);

        if (pk != 0) {
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
        }

        deployed = new TurgaliumFlashUnwind{ salt: salt }(ownerAddr, pools, routers);

        vm.stopBroadcast();
    }
}
