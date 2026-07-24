# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- MCP server (`moloch-agent-mcp` bin / `src/mcp-server.ts`) exposing 34
  tools over stdio, wrapping the existing `src/tx.ts` transaction builders,
  `src/chain.ts` reads, and `src/service.ts` hosted-service calls for use by
  external agent orchestrators — a structured alternative to spawning the
  CLI and parsing stdout. See the README's "MCP server" section for the
  tool list and `docs/MCP_SERVER_SCOPE.md` for the naming convention and
  the handful of CLI commands intentionally not exposed as tools.

### Changed

- Renamed the MCP tool `moloch_proposals` to `moloch_service_list_proposals`,
  for naming consistency with the other direct `ServiceClient` passthrough
  tools (`moloch_service_*`).
