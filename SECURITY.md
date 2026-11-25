# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Siphon (smart contracts, transaction builders, bridge routing, MCP/API authorization, or frontend wallet handling), please **do not** open a public GitHub issue with exploit details.

Instead, report it privately via GitHub Security Advisories on this repository (`Security` → `Advisories` → `Report a vulnerability`).

Please include:
- Affected file(s) and line numbers or contract function(s)
- Reproduction steps or proof-of-concept test case
- Impact assessment and suggested remediation (if known)

## Security Architecture & Status

- **Solidity Contracts (`contracts/`):** Written for Solidity `^0.8.24` with split swap/DeFi allowlists, Permit2 witness binding, EIP-7702 slippage guards, and reentrancy protection. Treat as **unaudited** for large mainnet deployments until an external third-party audit is completed.
- **Localhost API & MCP:** Bound to `127.0.0.1` by default with loopback `Host`/`Origin` validation, `Content-Type` CSRF protection, scoped Bearer token authentication for AI plugins, and owner-only mandate creation.
- **No Private Keys in Repo:** Siphon never stores user seed phrases or private keys; all wallet signing occurs client-side in the user's wallet extension/hardware signer.
