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
 * @notice Deterministic CREATE2 deployment script for `TurgaliumFlashUnwind` across Monad and all
 *         EVM chains. Pre-seeds EVERY on-chain verified lending fork across all 5 protocol families:
 *           - Aave V3 & forks: Aave V3 (Core/Prime/EtherFi), Neverland, HyperLend, HypurrFi,
 *             SparkLend, Seamless, Lendle, ZeroLend, Kinza, Radiant Base, Tydro/Ink
 *           - Aave V2 & forks: Aave V2 (Ethereum, Polygon, Avalanche)
 *           - Compound V3 (Comet): Ethereum, Base, Arbitrum, Optimism, Polygon
 *           - Compound V2 & forks: Compound V2, Venus (BNB/Eth/Arb/OP/Base), Benqi (Avax),
 *             Moonwell (Base/OP), Mendi (Linea)
 *           - Morpho Blue (0% flash loans + Morpho market unwinding): Ethereum, Base, Arbitrum,
 *             Optimism, Polygon, Unichain, HyperEVM, Worldchain, Monad
 *           - Balancer V2 Vault (0% flash loans): Ethereum, Base, Arbitrum, Optimism, Polygon,
 *             Gnosis, Avalanche
 */
contract DeployTurgaliumFlashUnwind {
    IVmFlashScript private constant vm =
        IVmFlashScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 public constant DEFAULT_SALT = keccak256("TURGALIUM_FLASH_UNWIND_V2_UNIVERSAL");

    address public constant KYBERSWAP_ROUTER_V2 = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address public constant LIFI_DIAMOND = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    address public constant LIFI_DIAMOND_MONAD = 0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37;
    address public constant OPENOCEAN_EXCHANGE = 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64;
    address public constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    function getChainPools(uint256 chainId) public pure returns (address[] memory pools) {
        if (chainId == 143) {
            // Monad — Neverland
            pools = new address[](1);
            pools[0] = 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585;
        } else if (chainId == 1) {
            // Ethereum — Aave V3 Core, Aave V3 Prime/Lido, Aave V3 EtherFi, SparkLend
            pools = new address[](4);
            pools[0] = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
            pools[1] = 0x4e033931ad43597d96D6bcc25c280717730B58B1;
            pools[2] = 0x0AA97c284e98396202b6A04024F5E2c65026F3c0;
            pools[3] = 0xC13e21B648A5Ee794902342038FF3aDAB66BE987;
        } else if (chainId == 8453) {
            // Base — Aave V3, Seamless, Radiant Base
            pools = new address[](3);
            pools[0] = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
            pools[1] = 0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7;
            pools[2] = 0x30798cFe2CCa822321ceed7e6085e633aAbC492F;
        } else if (chainId == 42161 || chainId == 10 || chainId == 137 || chainId == 43114) {
            // Arbitrum, Optimism, Polygon, Avalanche — Aave V3
            pools = new address[](1);
            pools[0] = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        } else if (chainId == 56) {
            // BNB Chain — Aave V3, Kinza Finance
            pools = new address[](2);
            pools[0] = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
            pools[1] = 0xcB0620b181140e57D1C0D8b724cde623cA963c8C;
        } else if (chainId == 100) {
            // Gnosis — Aave V3, SparkLend
            pools = new address[](2);
            pools[0] = 0xb50201558B00496A145fE76f7424749556E326D8;
            pools[1] = 0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0;
        } else if (chainId == 5000) {
            // Mantle — Lendle
            pools = new address[](1);
            pools[0] = 0xCFa5aE7c2CE8Fadc6426C1ff872cA45378Fb7cF3;
        } else if (chainId == 59144) {
            // Linea — Aave V3, ZeroLend
            pools = new address[](2);
            pools[0] = 0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac;
            pools[1] = 0x2f9bB73a8e98793e26Cb2F6C4ad037BDf1C6B269;
        } else if (chainId == 534352) {
            // Scroll — Aave V3
            pools = new address[](1);
            pools[0] = 0x11fCfe756c05AD438e312a7fd934381537D3cFfe;
        } else if (chainId == 324) {
            // zkSync Era — Aave V3, ZeroLend
            pools = new address[](2);
            pools[0] = 0x78e30497a3c7527d953c6B1E3541b021A98Ac43c;
            pools[1] = 0x4d9429246EA989C9CeE203B43F6d1C7D83e3B8F8;
        } else if (chainId == 57073) {
            // Ink — Aave V3 / Tydro
            pools = new address[](1);
            pools[0] = 0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA;
        } else if (chainId == 146) {
            // Sonic — Aave V3
            pools = new address[](1);
            pools[0] = 0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3;
        } else if (chainId == 999) {
            // HyperEVM — HyperLend, HypurrFi
            pools = new address[](2);
            pools[0] = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
            pools[1] = 0xceCcE0EB9DD2Ef7996e01e25DD70e461F918A14b;
        } else if (chainId == 42220) {
            // Celo — Aave V3
            pools = new address[](1);
            pools[0] = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
        } else {
            pools = new address[](0);
        }
    }

    function getExtendedMarkets(uint256 chainId)
        public
        pure
        returns (
            address[] memory aaveV2,
            address[] memory compV3,
            address[] memory compV2,
            address[] memory morpho,
            address[] memory balancer
        )
    {
        if (chainId == 143) {
            // Monad — Morpho Blue (0% flash loans, 24.5M+ WMON liquidity!)
            morpho = new address[](1);
            morpho[0] = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
        } else if (chainId == 1) {
            aaveV2 = new address[](1);
            aaveV2[0] = 0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9;
            compV3 = new address[](3);
            compV3[0] = 0xc3d688B66703497DAA19211EEdff47f25384cdc3;
            compV3[1] = 0xA17581A9E3356d9A858b789D68B4d866e593aE94;
            compV3[2] = 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840;
            compV2 = new address[](2);
            compV2[0] = 0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B; // Compound V2
            compV2[1] = 0x687a01ecF6d3907658f7A7c714749fAC32336D1B; // Venus Ethereum
            morpho = new address[](1);
            morpho[0] = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 8453) {
            compV3 = new address[](4);
            compV3[0] = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
            compV3[1] = 0x46e6b214b524310239732D51387075E0e70970bf;
            compV3[2] = 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf;
            compV3[3] = 0x784efeB622244d2348d4F2522f8860B96fbEcE89;
            compV2 = new address[](2);
            compV2[0] = 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C; // Moonwell Base
            compV2[1] = 0x0C7973F9598AA62f9e03B94E92C967fD5437426C; // Venus Base
            morpho = new address[](1);
            morpho[0] = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 42161) {
            compV3 = new address[](4);
            compV3[0] = 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf;
            compV3[1] = 0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA;
            compV3[2] = 0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486;
            compV3[3] = 0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07;
            compV2 = new address[](1);
            compV2[0] = 0x317c1A5739F39046E20b08ac9BeEa3f10fD43326; // Venus Arbitrum
            morpho = new address[](1);
            morpho[0] = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 10) {
            compV3 = new address[](2);
            compV3[0] = 0x2e44e174f7D53F0212823acC11C01A11d58c5bCB;
            compV3[1] = 0xE36A30D249f7761327fd973001A32010b521b6Fd;
            compV2 = new address[](2);
            compV2[0] = 0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9; // Moonwell Optimism
            compV2[1] = 0x5593FF68bE84C966821eEf5F0a988C285D5B7CeC; // Venus Optimism
            morpho = new address[](1);
            morpho[0] = 0xce95AfbB8EA029495c66020883F87aaE8864AF92;
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 137) {
            aaveV2 = new address[](1);
            aaveV2[0] = 0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf;
            compV3 = new address[](1);
            compV3[0] = 0xF25212E676D1F7F89Cd72fFEe66158f541246445;
            morpho = new address[](1);
            morpho[0] = 0x1bF0c2541F820E775182832f06c0B7Fc27A25f67;
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 43114) {
            aaveV2 = new address[](1);
            aaveV2[0] = 0x4F01AeD16D97E3aB5ab2B501154DC9bb0F1A5A2C;
            compV2 = new address[](1);
            compV2[0] = 0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4; // Benqi
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
        } else if (chainId == 56) {
            compV2 = new address[](1);
            compV2[0] = 0xfD36E2c2a6789Db23113685031d7F16329158384; // Venus BNB
        } else if (chainId == 59144) {
            compV2 = new address[](1);
            compV2[0] = 0x1b4d3b0421dDc1eB216D230Bc01527422Fb93103; // Mendi Linea
        } else if (chainId == 999) {
            morpho = new address[](1);
            morpho[0] = 0x68e37dE8d93d3496ae143F2E900490f6280C57cD; // Morpho Blue HyperEVM
        } else if (chainId == 130) {
            morpho = new address[](1);
            morpho[0] = 0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A; // Morpho Blue Unichain
        } else if (chainId == 480) {
            morpho = new address[](1);
            morpho[0] = 0xE741BC7c34758b4caE05062794E8Ae24978AF432; // Morpho Blue Worldchain
        } else if (chainId == 100) {
            balancer = new address[](1);
            balancer[0] = BALANCER_V2_VAULT;
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
        address deployerAddr = pk != 0 ? vm.addr(pk) : msg.sender;
        address ownerAddr = vm.envOr("TURGALIUM_OWNER", deployerAddr);
        bytes32 salt = vm.envOr("TURGALIUM_FLASH_UNWIND_SALT", DEFAULT_SALT);

        address[] memory pools = getChainPools(block.chainid);
        address[] memory routers = getChainRouters(block.chainid);
        (
            address[] memory aaveV2,
            address[] memory compV3,
            address[] memory compV2,
            address[] memory morpho,
            address[] memory balancer
        ) = getExtendedMarkets(block.chainid);

        if (pk != 0) {
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
        }

        // Deploy with deployer as temporary owner so we can atomically call configureExtendedMarkets,
        // then transfer ownership via 2-step handoff (or keep owner == deployer if identical).
        deployed = new TurgaliumFlashUnwind{ salt: salt }(deployerAddr, pools, routers);

        if (
            aaveV2.length > 0 ||
            compV3.length > 0 ||
            compV2.length > 0 ||
            morpho.length > 0 ||
            balancer.length > 0
        ) {
            deployed.configureExtendedMarkets(aaveV2, compV3, compV2, morpho, balancer);
        }

        if (ownerAddr != deployerAddr) {
            deployed.transferOwnership(ownerAddr);
        }

        vm.stopBroadcast();
    }
}
