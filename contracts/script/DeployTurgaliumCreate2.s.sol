// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TurgaliumDelegateRegistry } from "../TurgaliumDelegateRegistry.sol";
import { TurgaliumRouter } from "../TurgaliumRouter.sol";
import { TurgaliumSweepDelegate } from "../TurgaliumSweepDelegate.sol";
import { TurgaliumAgentVault } from "../TurgaliumAgentVault.sol";

/// @notice Minimal Foundry cheatcode interface (repository uses zero external Foundry libs).
interface IVmScript {
    function startBroadcast() external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external pure returns (address);
    function getCode(string calldata artifactPath) external view returns (bytes memory);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, bytes32 defaultValue) external view returns (bytes32);
}

/**
 * @title TurgaliumCreate2Factory
 * @notice Minimal, EIP-170-safe deterministic CREATE2 factory deployed once per chain via
 *         Foundry's canonical keyless deployer (0x4e59b44847b379578588920cA78FbF26c0B4956C).
 *
 *         Because `TurgaliumRouter` and `TurgaliumAgentVault` bind their initial `owner`/`vaultAdmin`
 *         to `msg.sender`, deploying them through this factory lets the factory atomically wire
 *         allowlists and hand governance over to the configured `owner` (EOA or Safe multisig) via
 *         two-step ownership transfer — avoiding bricking governance on the keyless CREATE2 proxy.
 */
contract TurgaliumCreate2Factory {
    address public immutable deployer;

    error Unauthorized();
    error InvalidAddress();
    error Create2DeploymentFailed(bytes32 salt);

    event ContractDeployed(bytes32 indexed salt, address indexed deployed);

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert Unauthorized();
        _;
    }

    constructor(address _deployer) {
        if (_deployer == address(0)) revert InvalidAddress();
        deployer = _deployer;
    }

    /// @notice Predicts the EIP-1014 CREATE2 address for a child deployed by this factory.
    function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }

    /// @notice Idempotently deploys arbitrary creation bytecode via CREATE2.
    function deploy(bytes32 salt, bytes memory initCode) external onlyDeployer returns (address deployed) {
        address predicted = computeAddress(salt, keccak256(initCode));
        if (predicted.code.length > 0) {
            return predicted;
        }
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 32), mload(initCode), salt)
        }
        if (deployed == address(0) || deployed != predicted) {
            revert Create2DeploymentFailed(salt);
        }
        emit ContractDeployed(salt, deployed);
    }

    /// @notice Atomically wires cross-contract allowlists and initiates two-step ownership handoff.
    function wireAndHandOff(
        address registryAddr,
        address routerAddr,
        address delegateAddr,
        address agentVaultAddr,
        address feeRecipient,
        address relayer,
        address targetOwner,
        uint256 maxFeeUsdcCap
    ) external onlyDeployer {
        if (
            registryAddr == address(0) ||
            routerAddr == address(0) ||
            delegateAddr == address(0) ||
            agentVaultAddr == address(0) ||
            feeRecipient == address(0) ||
            targetOwner == address(0)
        ) {
            revert InvalidAddress();
        }

        TurgaliumDelegateRegistry registry = TurgaliumDelegateRegistry(registryAddr);
        if (registry.owner() == address(this)) {
            registry.setAllowedFeeRecipient(feeRecipient, true);
            registry.setAllowedDelegateImplementation(delegateAddr, true);
            registry.setAllowedAgentVault(agentVaultAddr, true);
            if (relayer != address(0)) {
                registry.setAllowedRelayer(relayer, true);
            }
            registry.transferOwnership(targetOwner);
        }

        TurgaliumRouter router = TurgaliumRouter(payable(routerAddr));
        if (router.owner() == address(this)) {
            router.setAllowedAgentVault(agentVaultAddr, true);
            if (relayer != address(0)) {
                router.setAllowedRelayer(relayer, true);
            }
            if (maxFeeUsdcCap > 0) {
                router.setMaxFeeUsdcCap(maxFeeUsdcCap);
            }
            router.transferOwnership(targetOwner);
        }

        TurgaliumAgentVault vault = TurgaliumAgentVault(agentVaultAddr);
        if (vault.vaultAdmin() == address(this)) {
            vault.setAuthorizedRouter(delegateAddr, true);
            vault.transferVaultAdmin(targetOwner);
        }
    }
}

/**
 * @title DeployTurgaliumCreate2
 * @notice Deterministic Foundry CREATE2 deployment script for the complete Turgalium v1.0.0 suite:
 *           1. TurgaliumDelegateRegistry
 *           2. TurgaliumRouter (0 bps default open-source fee)
 *           3. TurgaliumSweepDelegate (EIP-7702 delegate target)
 *           4. TurgaliumAgentVault (mandate-bounded agent vault)
 *
 * Usage (dry-run simulation — does NOT broadcast):
 *   forge script contracts/script/DeployTurgaliumCreate2.s.sol:DeployTurgaliumCreate2 \
 *     --rpc-url "$BASE_RPC_URL" -vvv
 *
 * Environment variables (all optional except RPC / key when broadcasting):
 *   DEPLOYER_PRIVATE_KEY      — Optional broadcaster private key (when omitted, use --private-key / --account)
 *   TURGALIUM_CREATE2_SALT    — Base bytes32 CREATE2 salt (default: keccak256("turgalium.v1.0.0.create2"))
 *   TURGALIUM_OWNER           — Final owner/admin (EOA or Safe multisig; default: deployer)
 *   TURGALIUM_FEE_RECIPIENT   — Fee recipient address (required non-zero by constructors; default: owner)
 *   TURGALIUM_RELAYER         — Optional sponsored gasless relayer EOA to pre-allowlist (default: address(0))
 *   TURGALIUM_FEE_BPS         — Protocol fee in bps (default: 0 — zero-fee MIT open-source default; max 1000)
 *   TURGALIUM_MAX_FEE_USDC_CAP — Optional hard USDC fee cap in 6-dec base units (default: 0)
 *   TURGALIUM_USDC            — Override canonical USDC address for current chainId
 *   TURGALIUM_CCTP_MESSENGER  — Override Circle CCTP TokenMessenger address (default: canonical CCTP V2)
 *   TURGALIUM_CCTP_VERSION    — Override CCTP version (1 or 2; default: 2)
 */
contract DeployTurgaliumCreate2 {
    bool public constant IS_SCRIPT = true;

    IVmScript internal constant vm =
        IVmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Foundry's canonical deterministic CREATE2 deployer across EVM chains.
    address public constant DETERMINISTIC_CREATE2_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Canonical Circle CCTP V2 TokenMessengerV2 CREATE2 address uniform across EVM mainnets.
    address public constant CCTP_V2_TOKEN_MESSENGER =
        0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;

    /// @notice Default base CREATE2 salt for deterministic Turgalium v1.0.0 deployments.
    bytes32 public constant DEFAULT_BASE_SALT = keccak256("turgalium.v1.0.0.create2");

    /// @notice Open-source MIT default protocol fee: 0 bps (0.00%).
    uint16 public constant DEFAULT_FEE_BPS = 0;

    struct DeployConfig {
        bytes32 baseSalt;
        address deployer;
        address owner;
        address feeRecipient;
        address relayer;
        address usdc;
        address cctpMessenger;
        uint8 cctpVersion;
        uint16 feeBps;
        uint256 maxFeeUsdcCap;
    }

    struct DeploymentResult {
        address factory;
        address registry;
        address router;
        address sweepDelegate;
        address agentVault;
    }

    event TurgaliumSuiteDeployed(
        uint256 indexed chainId,
        bytes32 indexed baseSalt,
        address factory,
        address registry,
        address router,
        address sweepDelegate,
        address agentVault,
        address owner,
        uint16 feeBps
    );

    error UnsupportedChainWithoutOverrides(uint256 chainId);
    error InvalidDeployConfig(string reason);
    error SanityAssertionFailed(string check);

    /// @notice Returns canonical native USDC & Circle CCTP V2 TokenMessenger addresses for all 12 supported CCTP V2 EVM chains.
    function getDefaultCctpConfig(uint256 chainId)
        public
        pure
        returns (address usdc, address cctpMessenger, uint8 cctpVersion)
    {
        cctpMessenger = CCTP_V2_TOKEN_MESSENGER;
        cctpVersion = 2;

        if (chainId == 1) {
            // Ethereum Mainnet (CCTP Domain 0)
            usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        } else if (chainId == 10) {
            // Optimism (CCTP Domain 2)
            usdc = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
        } else if (chainId == 130) {
            // Unichain (CCTP Domain 10)
            usdc = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;
        } else if (chainId == 137) {
            // Polygon PoS (CCTP Domain 7)
            usdc = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
        } else if (chainId == 146) {
            // Sonic (CCTP Domain 13)
            usdc = 0x29219dd400f2Bf60E5a23d13Be72B486D4038894;
        } else if (chainId == 480) {
            // World Chain (CCTP Domain 14)
            usdc = 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1;
        } else if (chainId == 999) {
            // HyperEVM (CCTP Domain 19)
            usdc = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
        } else if (chainId == 8453) {
            // Base (CCTP Domain 6)
            usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        } else if (chainId == 42161) {
            // Arbitrum One (CCTP Domain 3)
            usdc = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
        } else if (chainId == 43114) {
            // Avalanche C-Chain (CCTP Domain 1)
            usdc = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
        } else if (chainId == 57073) {
            // Ink (CCTP Domain 21)
            usdc = 0x2D270e6886d130D724215A266106e6832161EAEd;
        } else if (chainId == 59144) {
            // Linea (CCTP Domain 11)
            usdc = 0x176211869cA2b568f2A7D4EE941E073a821EE1ff;
        } else {
            usdc = address(0);
            cctpMessenger = address(0);
            cctpVersion = 0;
        }
    }

    function deriveSalt(bytes32 baseSalt, string memory label) public pure returns (bytes32) {
        return keccak256(abi.encode(baseSalt, label));
    }

    function computeCreate2Address(address creator, bytes32 salt, bytes32 initCodeHash)
        public
        pure
        returns (address)
    {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), creator, salt, initCodeHash))
                )
            )
        );
    }

    function _initCode(string memory artifactPath, bytes memory encodedArgs)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(vm.getCode(artifactPath), encodedArgs);
    }

    /// @notice Pre-computes all deterministic CREATE2 addresses for a given deployment configuration.
    function predictAddresses(DeployConfig memory cfg)
        public
        view
        returns (DeploymentResult memory predicted)
    {
        bytes32 factorySalt = deriveSalt(cfg.baseSalt, "TurgaliumCreate2Factory");
        bytes memory factoryInitCode = _initCode(
            "DeployTurgaliumCreate2.s.sol:TurgaliumCreate2Factory",
            abi.encode(cfg.deployer)
        );
        predicted.factory = computeCreate2Address(
            DETERMINISTIC_CREATE2_DEPLOYER,
            factorySalt,
            keccak256(factoryInitCode)
        );

        bytes32 registrySalt = deriveSalt(cfg.baseSalt, "TurgaliumDelegateRegistry");
        bytes memory registryInitCode = _initCode(
            "TurgaliumDelegateRegistry.sol:TurgaliumDelegateRegistry",
            abi.encode(predicted.factory)
        );
        predicted.registry = computeCreate2Address(
            predicted.factory,
            registrySalt,
            keccak256(registryInitCode)
        );

        bytes32 routerSalt = deriveSalt(cfg.baseSalt, "TurgaliumRouter");
        bytes memory routerInitCode = _initCode(
            "TurgaliumRouter.sol:TurgaliumRouter",
            abi.encode(cfg.usdc, cfg.cctpMessenger, cfg.cctpVersion, cfg.feeRecipient, cfg.feeBps)
        );
        predicted.router = computeCreate2Address(
            predicted.factory,
            routerSalt,
            keccak256(routerInitCode)
        );

        bytes32 delegateSalt = deriveSalt(cfg.baseSalt, "TurgaliumSweepDelegate");
        bytes memory delegateInitCode = _initCode(
            "TurgaliumSweepDelegate.sol:TurgaliumSweepDelegate",
            abi.encode(
                cfg.usdc,
                cfg.cctpMessenger,
                cfg.feeRecipient,
                cfg.cctpVersion,
                predicted.registry,
                cfg.maxFeeUsdcCap
            )
        );
        predicted.sweepDelegate = computeCreate2Address(
            predicted.factory,
            delegateSalt,
            keccak256(delegateInitCode)
        );

        bytes32 vaultSalt = deriveSalt(cfg.baseSalt, "TurgaliumAgentVault");
        bytes memory vaultInitCode = _initCode(
            "TurgaliumAgentVault.sol:TurgaliumAgentVault",
            abi.encode(predicted.router)
        );
        predicted.agentVault = computeCreate2Address(
            predicted.factory,
            vaultSalt,
            keccak256(vaultInitCode)
        );
    }

    function loadConfigFromEnv(address deployer) public view returns (DeployConfig memory cfg) {
        (address defaultUsdc, address defaultMessenger, uint8 defaultVersion) =
            getDefaultCctpConfig(block.chainid);

        cfg.baseSalt = vm.envOr("TURGALIUM_CREATE2_SALT", DEFAULT_BASE_SALT);
        cfg.deployer = deployer;
        cfg.owner = vm.envOr("TURGALIUM_OWNER", deployer);
        cfg.feeRecipient = vm.envOr("TURGALIUM_FEE_RECIPIENT", cfg.owner);
        cfg.relayer = vm.envOr("TURGALIUM_RELAYER", address(0));
        cfg.usdc = vm.envOr("TURGALIUM_USDC", defaultUsdc);
        cfg.cctpMessenger = vm.envOr("TURGALIUM_CCTP_MESSENGER", defaultMessenger);

        uint256 rawVersion = vm.envOr("TURGALIUM_CCTP_VERSION", uint256(defaultVersion));
        if (rawVersion != 1 && rawVersion != 2) {
            revert InvalidDeployConfig("TURGALIUM_CCTP_VERSION must be 1 or 2");
        }
        cfg.cctpVersion = uint8(rawVersion);

        uint256 rawFeeBps = vm.envOr("TURGALIUM_FEE_BPS", uint256(DEFAULT_FEE_BPS));
        if (rawFeeBps > 1000) {
            revert InvalidDeployConfig("TURGALIUM_FEE_BPS exceeds hard 1000 bps ceiling");
        }
        cfg.feeBps = uint16(rawFeeBps);
        cfg.maxFeeUsdcCap = vm.envOr("TURGALIUM_MAX_FEE_USDC_CAP", uint256(0));

        if (cfg.usdc == address(0) || cfg.cctpMessenger == address(0)) {
            revert UnsupportedChainWithoutOverrides(block.chainid);
        }
        if (cfg.owner == address(0) || cfg.feeRecipient == address(0)) {
            revert InvalidDeployConfig("owner and feeRecipient must be non-zero");
        }
    }

    /// @notice Main Foundry script entrypoint (`forge script ...`).
    function run() external returns (DeploymentResult memory deployed) {
        uint256 deployerPk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerPk != 0 ? vm.addr(deployerPk) : msg.sender;
        DeployConfig memory cfg = loadConfigFromEnv(deployer);

        if (deployerPk != 0) {
            vm.startBroadcast(deployerPk);
        } else {
            vm.startBroadcast();
        }

        deployed = _deploySuite(cfg);

        // Complete two-step ownership acceptance automatically when deployer == target owner.
        // When `owner` is a Safe multisig (`owner != deployer`), pendingOwner/pendingVaultAdmin
        // remains set to `owner` for Safe batch acceptance.
        if (cfg.owner == cfg.deployer) {
            TurgaliumDelegateRegistry reg = TurgaliumDelegateRegistry(deployed.registry);
            if (reg.pendingOwner() == cfg.owner) {
                reg.acceptOwnership();
            }
            TurgaliumRouter rtr = TurgaliumRouter(payable(deployed.router));
            if (rtr.pendingOwner() == cfg.owner) {
                rtr.acceptOwnership();
            }
            TurgaliumAgentVault vlt = TurgaliumAgentVault(deployed.agentVault);
            if (vlt.pendingVaultAdmin() == cfg.owner) {
                vlt.acceptVaultAdmin();
            }
        }

        vm.stopBroadcast();

        verifyDeployment(cfg, deployed);

        emit TurgaliumSuiteDeployed(
            block.chainid,
            cfg.baseSalt,
            deployed.factory,
            deployed.registry,
            deployed.router,
            deployed.sweepDelegate,
            deployed.agentVault,
            cfg.owner,
            cfg.feeBps
        );
    }

    function _deploySuite(DeployConfig memory cfg)
        internal
        returns (DeploymentResult memory deployed)
    {
        if (cfg.usdc.code.length == 0) revert InvalidDeployConfig("USDC address has no bytecode");
        if (cfg.cctpMessenger.code.length == 0) {
            revert InvalidDeployConfig("CCTP TokenMessenger address has no bytecode");
        }

        bytes32 factorySalt = deriveSalt(cfg.baseSalt, "TurgaliumCreate2Factory");
        bytes memory factoryInitCode = _initCode(
            "DeployTurgaliumCreate2.s.sol:TurgaliumCreate2Factory",
            abi.encode(cfg.deployer)
        );
        address predictedFactory = computeCreate2Address(
            DETERMINISTIC_CREATE2_DEPLOYER,
            factorySalt,
            keccak256(factoryInitCode)
        );

        TurgaliumCreate2Factory factory;
        if (predictedFactory.code.length > 0) {
            factory = TurgaliumCreate2Factory(predictedFactory);
        } else {
            factory = new TurgaliumCreate2Factory{ salt: factorySalt }(cfg.deployer);
        }
        deployed.factory = address(factory);

        // 1. TurgaliumDelegateRegistry (initially owned by factory for atomic allowlist wiring)
        deployed.registry = factory.deploy(
            deriveSalt(cfg.baseSalt, "TurgaliumDelegateRegistry"),
            _initCode(
                "TurgaliumDelegateRegistry.sol:TurgaliumDelegateRegistry",
                abi.encode(deployed.factory)
            )
        );

        // 2. TurgaliumRouter (0 bps default open-source fee)
        deployed.router = factory.deploy(
            deriveSalt(cfg.baseSalt, "TurgaliumRouter"),
            _initCode(
                "TurgaliumRouter.sol:TurgaliumRouter",
                abi.encode(
                    cfg.usdc,
                    cfg.cctpMessenger,
                    cfg.cctpVersion,
                    cfg.feeRecipient,
                    cfg.feeBps
                )
            )
        );

        // 3. TurgaliumSweepDelegate (EIP-7702 delegation target pinned to immutable USDC/CCTP/registry)
        deployed.sweepDelegate = factory.deploy(
            deriveSalt(cfg.baseSalt, "TurgaliumSweepDelegate"),
            _initCode(
                "TurgaliumSweepDelegate.sol:TurgaliumSweepDelegate",
                abi.encode(
                    cfg.usdc,
                    cfg.cctpMessenger,
                    cfg.feeRecipient,
                    cfg.cctpVersion,
                    deployed.registry,
                    cfg.maxFeeUsdcCap
                )
            )
        );

        // 4. TurgaliumAgentVault (policy-bounded agent mandate vault linked to router & delegate)
        deployed.agentVault = factory.deploy(
            deriveSalt(cfg.baseSalt, "TurgaliumAgentVault"),
            _initCode(
                "TurgaliumAgentVault.sol:TurgaliumAgentVault",
                abi.encode(deployed.router)
            )
        );

        // 5. Wire cross-contract allowlists and initiate two-step ownership handoff to cfg.owner
        factory.wireAndHandOff(
            deployed.registry,
            deployed.router,
            deployed.sweepDelegate,
            deployed.agentVault,
            cfg.feeRecipient,
            cfg.relayer,
            cfg.owner,
            cfg.maxFeeUsdcCap
        );
    }

    /// @notice Post-deploy sanity assertions validating immutables, allowlists, 0-bps fee config, and governance handoff.
    function verifyDeployment(DeployConfig memory cfg, DeploymentResult memory d) public view {
        if (d.factory == address(0) || d.factory.code.length == 0) {
            revert SanityAssertionFailed("factory missing bytecode");
        }
        if (d.registry == address(0) || d.registry.code.length == 0) {
            revert SanityAssertionFailed("registry missing bytecode");
        }
        if (d.router == address(0) || d.router.code.length == 0) {
            revert SanityAssertionFailed("router missing bytecode");
        }
        if (d.sweepDelegate == address(0) || d.sweepDelegate.code.length == 0) {
            revert SanityAssertionFailed("sweepDelegate missing bytecode");
        }
        if (d.agentVault == address(0) || d.agentVault.code.length == 0) {
            revert SanityAssertionFailed("agentVault missing bytecode");
        }

        // Verify deterministic CREATE2 addresses match predictions
        DeploymentResult memory expected = predictAddresses(cfg);
        if (d.factory != expected.factory) revert SanityAssertionFailed("factory CREATE2 mismatch");
        if (d.registry != expected.registry) revert SanityAssertionFailed("registry CREATE2 mismatch");
        if (d.router != expected.router) revert SanityAssertionFailed("router CREATE2 mismatch");
        if (d.sweepDelegate != expected.sweepDelegate) {
            revert SanityAssertionFailed("sweepDelegate CREATE2 mismatch");
        }
        if (d.agentVault != expected.agentVault) {
            revert SanityAssertionFailed("agentVault CREATE2 mismatch");
        }

        // Verify TurgaliumDelegateRegistry state
        TurgaliumDelegateRegistry registry = TurgaliumDelegateRegistry(d.registry);
        if (registry.paused()) revert SanityAssertionFailed("registry unexpectedly paused");
        if (!registry.isAllowedFeeRecipient(cfg.feeRecipient)) {
            revert SanityAssertionFailed("feeRecipient not allowlisted in registry");
        }
        if (!registry.isAllowedDelegateImplementation(d.sweepDelegate)) {
            revert SanityAssertionFailed("sweepDelegate not allowlisted in registry");
        }
        if (!registry.isAllowedAgentVault(d.agentVault)) {
            revert SanityAssertionFailed("agentVault not allowlisted in registry");
        }
        if (cfg.relayer != address(0) && !registry.isAllowedRelayer(cfg.relayer)) {
            revert SanityAssertionFailed("relayer not allowlisted in registry");
        }

        // Verify TurgaliumRouter immutables, fee config (0 bps default), and allowlists
        TurgaliumRouter router = TurgaliumRouter(payable(d.router));
        if (router.usdc() != cfg.usdc) revert SanityAssertionFailed("router usdc mismatch");
        if (router.cctpMessenger() != cfg.cctpMessenger) {
            revert SanityAssertionFailed("router cctpMessenger mismatch");
        }
        if (router.cctpVersion() != cfg.cctpVersion) {
            revert SanityAssertionFailed("router cctpVersion mismatch");
        }
        if (router.feeRecipient() != cfg.feeRecipient) {
            revert SanityAssertionFailed("router feeRecipient mismatch");
        }
        if (router.feeBps() != cfg.feeBps) revert SanityAssertionFailed("router feeBps mismatch");
        if (router.maxFeeUsdcCap() != cfg.maxFeeUsdcCap) {
            revert SanityAssertionFailed("router maxFeeUsdcCap mismatch");
        }
        if (!router.allowedAgentVaults(d.agentVault)) {
            revert SanityAssertionFailed("agentVault not allowlisted in router");
        }
        if (cfg.relayer != address(0) && !router.allowedRelayers(cfg.relayer)) {
            revert SanityAssertionFailed("relayer not allowlisted in router");
        }

        // Verify TurgaliumSweepDelegate immutables
        TurgaliumSweepDelegate delegate = TurgaliumSweepDelegate(payable(d.sweepDelegate));
        if (delegate.usdc() != cfg.usdc) revert SanityAssertionFailed("delegate usdc mismatch");
        if (delegate.cctpMessenger() != cfg.cctpMessenger) {
            revert SanityAssertionFailed("delegate cctpMessenger mismatch");
        }
        if (delegate.cctpVersion() != cfg.cctpVersion) {
            revert SanityAssertionFailed("delegate cctpVersion mismatch");
        }
        if (delegate.policyRegistry() != d.registry) {
            revert SanityAssertionFailed("delegate policyRegistry mismatch");
        }
        if (delegate.protocolFeeRecipient() != cfg.feeRecipient) {
            revert SanityAssertionFailed("delegate protocolFeeRecipient mismatch");
        }
        if (delegate.protocolMaxFeeUsdcCap() != cfg.maxFeeUsdcCap) {
            revert SanityAssertionFailed("delegate protocolMaxFeeUsdcCap mismatch");
        }

        // Verify TurgaliumAgentVault wiring
        TurgaliumAgentVault vault = TurgaliumAgentVault(d.agentVault);
        if (vault.authorizedRouter() != d.router) {
            revert SanityAssertionFailed("vault default authorizedRouter mismatch");
        }
        if (!vault.authorizedRouters(d.router)) {
            revert SanityAssertionFailed("router not authorized on vault");
        }
        if (!vault.authorizedRouters(d.sweepDelegate)) {
            revert SanityAssertionFailed("sweepDelegate not authorized on vault");
        }

        // Verify governance handoff (finalized if owner == deployer, pending if external Safe/multisig)
        if (cfg.owner == cfg.deployer) {
            if (registry.owner() != cfg.owner) revert SanityAssertionFailed("registry owner mismatch");
            if (router.owner() != cfg.owner) revert SanityAssertionFailed("router owner mismatch");
            if (vault.vaultAdmin() != cfg.owner) {
                revert SanityAssertionFailed("vault admin mismatch");
            }
        } else {
            bool regOk = registry.owner() == cfg.owner || registry.pendingOwner() == cfg.owner;
            bool rtrOk = router.owner() == cfg.owner || router.pendingOwner() == cfg.owner;
            bool vltOk =
                vault.vaultAdmin() == cfg.owner || vault.pendingVaultAdmin() == cfg.owner;
            if (!regOk) revert SanityAssertionFailed("registry pendingOwner mismatch");
            if (!rtrOk) revert SanityAssertionFailed("router pendingOwner mismatch");
            if (!vltOk) revert SanityAssertionFailed("vault pendingVaultAdmin mismatch");
        }
    }
}
