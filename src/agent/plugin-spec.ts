import path from 'node:path';

export function buildAiPluginManifest(baseUrl: string) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  return {
    schema_version: 'v1',
    name_for_human: 'Siphon Multi-Chain Sweep & Dust Agent',
    name_for_model: 'siphon_migrator',
    description_for_human:
      'Scan unified wallets across 25 chains (EVM, Cosmos, Sui, Aptos, TON, Tron, Bitcoin), plan batch dust conversion, verify pre-sign cryptographic proofs, and propose permission-gated sweeps to Solana.',
    description_for_model:
      'Use Siphon to inspect single or unified multi-chain wallets, calculate profitable batch dust conversions, simulate pre-sign cryptographic proofs, inspect SiphonAgentVault policy mandates, and submit permission-gated sweep requests. NEVER assume funds move without explicit user approval or an active SiphonAgentVault mandate.',
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
      title: 'Siphon Multi-Chain Migrator & Permissioned Agent API',
      version: '1.0.0',
      description:
        'ChatGPT Action & AI Agent API for unifying multi-chain wallets across 25 chains, converting dust in batches, verifying pre-sign proofs, and submitting human-permissioned sweep requests to Solana.',
    },
    servers: [{ url: cleanBase, description: 'Siphon Local / Hosted Server' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Scoped Siphon AI Plugin token generated in the Agents & AI tab.',
        },
      },
    },
    paths: {
      '/api/scan/unified': {
        post: {
          operationId: 'scanUnifiedWallets',
          'x-openai-isConsequential': false,
          summary: 'Scan & unify one or more wallets across 25 chains (EVM, Cosmos, Sui, Aptos, TON, Tron, Bitcoin)',
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
      'You are Siphon Assistant. Always scan wallets first via scanUnifiedWallets, check profitable batch dust via planDustConversion, and submit any value-moving sweep via requestSweepPermission (with authentic scanned assetIds) so the user explicitly approves in Siphon or stays strictly within their owner-created SiphonAgentVault mandate.',
  };
}
