import path from 'node:path';

export function buildAiPluginManifest(baseUrl: string) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  return {
    schema_version: 'v1',
    name_for_human: 'Turgalium Multi-Chain Sweep & Preservation Agent',
    name_for_model: 'siphon_migrator',
    description_for_human:
      'Scan unified wallets across 30 chains, run capital-preservation route audits, track live Lido/Ethena/Cosmos unlocks, reclaim Solana empty-ATA rent, preview 90/10 Solana yield splits, research Jupiter Prediction Markets, and propose permission-gated sweeps to Solana.',
    description_for_model:
      'Use Turgalium to inspect unified multi-chain wallets across 30 chains, run capital-preservation audits, inspect live Lido/Ethena/Cosmos unlock queues and CCTP claims, scan Solana empty-ATA rent recovery, preview 90% yield + 10% Degen side-pocket splits, research trending Jupiter Prediction Markets (read-only), and submit permission-gated sweep requests. NEVER assume funds move or bets are placed without explicit user approval or an active SiphonAgentVault mandate.',
    auth: {
      type: 'user_http',
      authorization_type: 'bearer',
    },
    api: {
      type: 'openapi',
      url: `${cleanBase}/openapi.json`,
      is_user_authenticated: true,
    },
    logo_url: `${cleanBase}/logos/solana.svg`,
    contact_email: 'security@siphon.local',
    legal_info_url: `${cleanBase}/`,
  };
}

export function buildOpenApiSpec(baseUrl: string) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  return {
    openapi: '3.1.0',
    info: {
      title: 'Turgalium Multi-Chain Migrator & Preservation Agent API',
      version: '2.0.0',
      description:
        'ChatGPT Action & AI Agent API (v2) for Turgalium — unifying multi-chain wallets across 30 chains, running capital-preservation route audits, reading live on-chain Lido/Ethena/Cosmos unlock queues, scanning Solana empty-ATA rent, previewing 90/10 Solana yield splits, researching Jupiter Prediction Markets (read-only), and submitting human-permissioned sweep requests to Solana.',
    },
    servers: [{ url: cleanBase, description: 'Turgalium Local / Hosted Server' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Scoped Turgalium AI Plugin token generated in the Agents & AI tab.',
        },
      },
    },
    paths: {
      '/api/scan/unified': {
        post: {
          operationId: 'scanUnifiedWallets',
          'x-openai-isConsequential': false,
          summary: 'Scan & unify one or more wallets across 30 chains (19 EVMs, Cosmos, Sui, Aptos, TON, Tron, Bitcoin)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['wallets'],
                  properties: {
                    wallets: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 20,
                      items: {
                        type: 'object',
                        properties: {
                          address: { type: 'string', maxLength: 160, description: 'Wallet address (0x…, cosmos1…, bc1…, EQ…, T…)' },
                          label: { type: 'string', maxLength: 64, description: 'Optional human label (e.g. Rabby Main, Keplr)' },
                          family: {
                            type: 'string',
                            enum: ['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc'],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Unified ScanReport with per-wallet and per-chain breakdown' } },
        },
      },
      '/api/dust/plan': {
        post: {
          operationId: 'planDustConversion',
          'x-openai-isConsequential': false,
          summary: 'Plan profitable batch dust conversion and compute exact per-(wallet, chain) batch-rescue savings',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['scanId'],
                  properties: {
                    scanId: { type: 'string', maxLength: 128 },
                    maxDustThresholdUsd: { type: 'number', minimum: 1, maximum: 250, default: 25 },
                    protocolFeeBps: { type: 'integer', minimum: 500, maximum: 1000, default: 700 },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'DustConversionPlan with convertibleAssetIds and batch rescue gain' } },
        },
      },
      '/api/optimize/preservation': {
        post: {
          operationId: 'siphon_preservation_audit',
          'x-openai-isConsequential': false,
          summary:
            'Run Capital-Preservation Route Auction for a cached scanId or walletAddress: exact dollars saved, best route per chain, and Ethereum L1 gas-timing advice',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    scanId: { type: 'string', minLength: 1, maxLength: 128 },
                    walletAddress: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 160,
                      description: 'Previously scanned wallet address',
                    },
                    outputAsset: { type: 'string', enum: ['USDC', 'SOL'], default: 'USDC' },
                    protocolFeeBps: { type: 'integer', minimum: 0, maximum: 1000 },
                    maxBaseFeeGwei: { type: 'number', exclusiveMinimum: 0, maximum: 500, default: 15 },
                    hasSolanaUsdcAta: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'PreservationPlanReport with exact dollars saved, per-chain route auction winners, L1 gas-timing advice, and unlock schedule',
            },
          },
        },
      },
      '/api/optimize/unlock-schedule': {
        post: {
          operationId: 'siphon_list_unlock_schedule',
          'x-openai-isConsequential': false,
          summary:
            'List live pending Lido stETH withdrawal NFTs, Ethena sUSDe cooldowns, Cosmos unbonding delegations, scan-indexed DeFi locks, and attested CCTP claims sorted soonest-first',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    scanId: { type: 'string', minLength: 1, maxLength: 128 },
                    evmAddress: {
                      type: 'string',
                      minLength: 42,
                      maxLength: 42,
                      description: 'Ethereum 0x address for live Lido & Ethena cooldown queries',
                    },
                    cosmosAddresses: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 10,
                      items: { type: 'string', minLength: 39, maxLength: 90 },
                      description: 'Valid Bech32 Cosmos addresses (cosmos1…, osmo1…, celestia1…, inj1…)',
                    },
                    includeLiveOnChain: { type: 'boolean', default: true },
                    attestedCctpLegs: {
                      type: 'array',
                      maxItems: 25,
                      items: {
                        type: 'object',
                        required: ['chain', 'amountUsdc', 'attestationStatus'],
                        properties: {
                          chain: { type: 'string', minLength: 2, maxLength: 32 },
                          amountUsdc: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000 },
                          txHash: { type: 'string', maxLength: 128 },
                          attestationStatus: { type: 'string', enum: ['pending_confirmations', 'complete'] },
                          estimatedReadyAt: { type: 'number', minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Deduplicated, soonest-first unlockSchedule across Lido, Ethena, Cosmos, DeFi locks, and CCTP claims',
            },
          },
        },
      },
      '/api/solana/rent-scan': {
        post: {
          operationId: 'siphon_solana_rent_scan',
          'x-openai-isConsequential': false,
          summary:
            'Scan a Solana wallet for zero-balance empty SPL/Token-2022 Associated Token Accounts eligible for free SOL rent recovery (0.00203928 SOL per empty account)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ownerAddress'],
                  properties: {
                    ownerAddress: {
                      type: 'string',
                      minLength: 32,
                      maxLength: 64,
                      description: 'Valid non-zero Solana base58 public key',
                    },
                    solPriceUsd: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
                    maxAccountsPerTx: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'SolanaRentScanResult with reclaimable empty ATA count, reclaimableSol, and reclaimableUsd',
            },
          },
        },
      },
      '/api/solana/yield-park': {
        post: {
          operationId: 'siphon_solana_yield_preview',
          'x-openai-isConsequential': false,
          summary:
            'Preview the 90% Preserved Yield (JupSOL, Jupiter Lend jlUSDC, or Kamino USDC) + 10% Degen Side-Pocket split with exact micro-USDC accounting and projected APY (read-only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['totalUsdcAmount'],
                  properties: {
                    ownerAddress: {
                      type: 'string',
                      minLength: 32,
                      maxLength: 64,
                      description: 'Optional Solana base58 public key',
                    },
                    totalUsdcAmount: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000 },
                    preservePct: { type: 'number', minimum: 50, maximum: 100, default: 90 },
                    strategy: {
                      type: 'string',
                      enum: ['jupsol', 'jupiter_lend_usdc', 'kamino_usdc'],
                      default: 'jupiter_lend_usdc',
                    },
                    fetchLiveQuote: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'SolanaYieldParkPlan read-only split & APY projection without autonomous execution',
            },
          },
        },
      },
      '/api/degen/markets': {
        get: {
          operationId: 'siphon_degen_markets',
          'x-openai-isConsequential': false,
          summary:
            'List live trending Jupiter Prediction Markets & implied odds for AI-assisted market research (strictly read-only; never places bets autonomously)',
          parameters: [
            {
              name: 'category',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: ['all', 'crypto', 'sports', 'politics', 'esports', 'culture', 'economics', 'tech'],
                default: 'all',
              },
            },
            {
              name: 'filter',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: ['trending', 'live', 'new', 'upcoming'],
                default: 'trending',
              },
            },
            {
              name: 'query',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 120 },
              description: 'Optional keyword search query',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
            },
          ],
          responses: {
            '200': {
              description: 'Read-only feed of trending Jupiter Prediction Markets with normalized YES/NO odds & multipliers',
            },
          },
        },
      },
      '/api/agents/mandates': {
        get: {
          operationId: 'listAgentMandates',
          'x-openai-isConsequential': false,
          summary: 'List policy-bounded SiphonAgentVault mandates and remaining daily caps',
          responses: { '200': { description: 'Object { mandates: AgentMandateRecord[] }' } },
        },
      },
      '/api/agents/approvals': {
        get: {
          operationId: 'listPermissionApprovals',
          'x-openai-isConsequential': false,
          summary: 'List pending, approved, and rejected AI / smart-contract agent permission requests',
          responses: { '200': { description: 'Object { approvals: PermissionRequestRecord[] }' } },
        },
        post: {
          operationId: 'requestSweepPermission',
          'x-openai-isConsequential': true,
          summary:
            'Propose a dust conversion, DeFi withdrawal, or Solana sweep — enforces explicit human permission or active SiphonAgentVault mandate caps',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['actionType', 'summary', 'sourceWallets', 'chains', 'solanaDestination', 'grossUsd', 'estimatedNetUsdc'],
                  properties: {
                    client: { type: 'string', enum: ['chatgpt_action', 'claude_mcp', 'smart_contract_agent'] },
                    mandateId: { type: 'string', maxLength: 64 },
                    actionType: {
                      type: 'string',
                      enum: ['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq'],
                    },
                    summary: { type: 'string', maxLength: 240 },
                    sourceWallets: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 160 } },
                    chains: { type: 'array', maxItems: 25, items: { type: 'string', maxLength: 32 } },
                    solanaDestination: { type: 'string', minLength: 32, maxLength: 64 },
                    grossUsd: { type: 'number', exclusiveMinimum: 0, maximum: 10_000_000 },
                    estimatedNetUsdc: { type: 'number', minimum: -1_000_000, maximum: 10_000_000 },
                    protocolFeeBps: { type: 'integer', minimum: 500, maximum: 1000, default: 700 },
                    assetIds: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 160 } },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'PermissionRequestRecord with status pending_approval or auto_approved_by_mandate and SHA-256 requestDigestSha256',
            },
          },
        },
      },
    },
  };
}

/**
 * Ergonomic alias for `buildOpenApiSpec` used by ChatGPT Plugin v2 callers and tests.
 */
export const buildChatGptOpenApiSpec = buildOpenApiSpec;

export function buildPluginSetupGuide(params: { baseUrl: string; rootDir: string }) {
  const cleanBase = params.baseUrl.replace(/\/$/, '');
  const mcpEntrypoint = path.join(params.rootDir, 'dist', 'src', 'mcp', 'server.js');
  return {
    claudeDesktopConfig: {
      mcpServers: {
        siphon: {
          command: 'node',
          args: [mcpEntrypoint],
          env: {
            SIPHON_API_URL: cleanBase,
            SIPHON_API_TOKEN: '<paste-scoped-claude-mcp-bearer-token>',
          },
        },
      },
    },
    claudeCodeCommand: `claude mcp add --transport http --header "Authorization: Bearer <SIPHON_API_TOKEN>" siphon ${cleanBase}/mcp`,
    mcpHttpEndpoint: `${cleanBase}/mcp`,
    chatgptPluginManifestUrl: `${cleanBase}/.well-known/ai-plugin.json`,
    chatgptOpenApiUrl: `${cleanBase}/openapi.json`,
    chatgptCustomGptInstructions:
      'You are Turgalium Assistant. Scan wallets via scanUnifiedWallets, audit exact capital savings via siphon_preservation_audit, inspect live Lido/Ethena/Cosmos unlocks via siphon_list_unlock_schedule, check free Solana rent recovery via siphon_solana_rent_scan, preview 90/10 yield splits via siphon_solana_yield_preview, and research Jupiter Prediction Markets read-only via siphon_degen_markets. Always submit value-moving sweeps via requestSweepPermission (with authentic scanned assetIds) and NEVER place bets or move funds autonomously without explicit user approval or an active owner-created SiphonAgentVault mandate.',
  };
}
