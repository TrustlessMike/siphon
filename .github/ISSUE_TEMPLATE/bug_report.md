---
name: Bug report
about: Report a reproducible bug in the scanner, route auction, contracts, UI, or MCP server
title: "[Bug]: "
labels: ["bug"]
assignees: []
---

> **Security Notice:** If this issue involves a fund-loss vulnerability, smart contract exploit, or authentication bypass, **do not** open a public issue. Report it privately via [GitHub Security Advisories](../../security/advisories/new) as described in [SECURITY.md](../../blob/main/SECURITY.md). Never paste private keys, seed phrases, or bearer tokens.

## Description
A clear and concise description of what went wrong.

## Affected Area
- [ ] Multi-chain scanner / wallet discovery
- [ ] DeFi protocol extractor / unlock-queue reader
- [ ] Route auction / Circle CCTP V2 / bridge execution
- [ ] Solana tools (Rent Reclaim, SPL Dust, Yield Park, Prediction Markets)
- [ ] Solidity contracts (`contracts/`)
- [ ] Claude MCP / ChatGPT Actions / SDK
- [ ] Self-hosting / Docker / Fly.io / Vercel
- [ ] Frontend UI / wallet connection

## Affected Chain(s) & Wallet(s)
- Chain(s): (e.g., Ethereum, Base, Arbitrum, HyperEVM, Cosmos, Solana)
- Wallet / Signer: (e.g., Rabby, MetaMask, Phantom, Safe Multisig, Keplr)

## Steps to Reproduce
1. ...
2. ...
3. ...

## Expected Behavior
What you expected to happen.

## Actual Behavior & Logs
Include sanitized console output, HTTP status codes, or transaction hashes (redact API keys and session tokens).

## Environment
- Turgalium version / commit SHA:
- Deployment mode: (local `npm run start` / Docker / Fly.io / Vercel / `npx turgalium-mcp`)
- Node.js version:
- Browser & OS (if UI issue):
