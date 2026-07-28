# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- MCP server (`moloch-agent-mcp` bin / `src/mcp-server.ts`) exposing 39
  tools over stdio, wrapping the existing `src/tx.ts` transaction builders,
  `src/chain.ts` reads, and `src/service.ts` hosted-service calls for use by
  external agent orchestrators — a structured alternative to spawning the
  CLI and parsing stdout. See the README's "MCP server" section for the
  tool list and `docs/MCP_SERVER_SCOPE.md` for the naming convention and
  the handful of CLI commands intentionally not exposed as tools.
- CLI `dao-record` command and MCP `moloch_submit_dao_record` tool: posts to
  an arbitrary Poster table via a proposal (`dao-meta`/`moloch_update_dao_meta`
  are now thin wrappers over this for the `daoProfile` table specifically).
- CLI `decode-proposal` command and MCP `moloch_decode_proposal` tool:
  decodes `submitProposal`/multisend calldata into named actions, from
  either `--data` directly or `--dao`/`--proposal` (fetching `proposalData`
  from the indexer).
- CLI `dao-history` command and MCP `moloch_read_dao_history` tool:
  composes the indexed DAO profile with its proposal history in one call.
- A preflight before `process` broadcasts (processableNow, not already
  processed, and — when `--proposal-data` is supplied — that it matches
  what's indexed), and CLI `estimate-baal-gas` / MCP `moloch_estimate_baal_gas`
  plus an opt-in `--estimate-baal-gas` flag on proposal-submitting CLI
  commands, simulating the built multisend through the DAO's Safe module.
  MCP equivalent: `moloch_preflight_process`.
- `autoFetchProposalOffering` on every MCP write tool that accepts
  `proposalOfferingRaw`: reads the DAO's current `proposalOffering` from
  chain instead of defaulting to `0`, matching the CLI's existing
  auto-fetch behavior.
- `src/networks.ts`: a per-chain registry for contract addresses, Poster
  tags, and RPC/explorer/Safe-API URLs. An unsupported `CHAIN_ID` now fails
  immediately at startup (CLI and MCP server alike), including under
  `--build-only`, instead of silently building a transaction against the
  wrong deployment.

### Changed

- Renamed the MCP tool `moloch_proposals` to `moloch_service_list_proposals`,
  for naming consistency with the other direct `ServiceClient` passthrough
  tools (`moloch_service_*`).
