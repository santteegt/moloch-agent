# MCP server scope

This document explains what `src/mcp-server.ts` covers relative to
`moloch-agent`'s CLI (`src/cli.ts`) — the tool-naming convention it follows,
and, most importantly, which CLI commands are deliberately **not** exposed
as MCP tools and why. See the README's "MCP server" section for the current
full list of available tools.

## Naming convention

Tool names follow `moloch[_service]_{verb}_{resource}`, per the MCP
best-practices guidance to prefix by service and lead with an action verb
(e.g. `github_create_issue`, not `github_issue`):

- **`moloch_service_*`** prefix — the tool body is a direct
  `service.<method>(...)` call (a thin HTTP passthrough to the hosted
  moloch-service: Graph reads, IPFS pinning). No `chainId`/calldata
  involved.
- **`moloch_*`** prefix — everything else: `tx.ts` builders (return
  `{summary, tx}`, build-only, never signed) and `chain.ts` functions
  (direct contract reads, or reads that blend indexed + chain data and may
  use `service` as an internal implementation detail rather than as the
  tool's primary action).
- **Verb**: `submit`/`post`/`update` for proposal-creating writes (e.g.
  `moloch_submit_tribute`, `moloch_update_dao_meta`), a domain verb where
  one already exists and reads better (`moloch_summon`, `moloch_ragequit`,
  `moloch_cancel`, `moloch_sponsor`, `moloch_vote`, `moloch_process`, `moloch_wrap_eth`),
  `read` for a single direct-or-blended chain read, `list` for an
  array-returning read, and `get`/`list` (singular/plural) within
  `moloch_service_*` for the same reason.

A few tools intentionally don't fit that pattern in an obvious way:
`moloch_process_ready` (verb `process`, object "the ready [proposal]") and
`moloch_service_pin_json` (verb `pin`, a one-off action rather than a
get/list/read/submit) — both still lead with a verb, just not one of the
repeated ones above.

## Deliberately excluded

A handful of `cli.ts` commands are not exposed as tools. This is a record
of which ones and why, so a missing tool reads as a documented decision
rather than an oversight:

- **`account` / `signer`** — `signerAccount(config)` only returns a useful
  result when `PRIVATE_KEY` is set on the process. Exposing it as a tool
  would encourage (or require) setting `PRIVATE_KEY` on this MCP server,
  which directly contradicts the server's reason for existing: it must
  never receive private keys, the same boundary the CLI's hosted-service
  split already enforces (see README "Boundaries").

- **`links` / `admin-url` / `daohaus-url`** — `linksFor()` is a pure helper
  defined locally in `cli.ts`, not exported from `tx.ts`/`chain.ts`/
  `service.ts`. Porting it here would mean either duplicating the logic
  (against the "reuse tx.ts/chain.ts, don't reimplement" constraint this
  server was built under) or importing `cli.ts` directly — which isn't
  safe, because `cli.ts` calls `main().catch(...)` unconditionally at
  module load. Importing it as a library would execute the whole CLI (and
  potentially `process.exit`) as a side effect of loading the MCP server.
  This is blocked on extracting `linksFor` out of `cli.ts` into a shared
  module, which is itself a change to `cli.ts` and therefore out of scope
  for this server.

- **`workspace-create`** — `createWorkspace()` has the same `cli.ts`-local,
  unsafe-to-import problem as `links`, and on top of that it's real
  business logic (the `dao-workspace/v1` vs `proposal-workspace/v1`
  envelope shape, default thread lists, `slugify`, ...), not a thin
  passthrough — unlike `pin-json`, which is included as
  `moloch_service_pin_json` because it's a direct, stateless
  `service.pinJson(...)` call. Every write tool in this server already
  accepts an optional `link`/`workspaceURI` field, so a caller can build
  and pin its own workspace document (with its own tooling, or with
  `moloch_service_pin_json`) and pass the resulting URI straight in —
  which is also a better fit for this server's model of the calling agent
  composing individual operations itself, rather than a tool silently
  pinning structured content on the caller's behalf.

- **`help` / `-h`** — CLI-only text stub. MCP's `tools/list` response plus
  each tool's `description` already serves the equivalent discovery
  purpose for an MCP client.

- **`vote` with `--reason`** (the CLI's `voteWithOptionalReason`, which
  posts a memory record and then votes in one invocation) — not exposed as
  a distinct combo tool. Now that `moloch_post_memory` and `moloch_vote`
  both exist as separate tools, the calling agent can compose them itself
  in two calls, which is exactly the "agent composes individual operations
  instead of a hidden multi-step function" model this server was built
  for in the first place.

- **Single-member lookup** (`moloch-skills`' standalone `moloch.mjs`
  script has a `graph-member --member 0x...` command; this repo has
  neither a CLI nor an MCP equivalent) — unlike the exclusions above, this
  isn't a design choice, it's a gap in `service.ts`'s `ServiceClient`
  contract: `members()` only accepts `{ dao, first, skip }`, with no
  address filter and no total count, so a single-member lookup would mean
  an unbounded client-side scan through every member. `moloch_read_dao_history`
  (composing `service.dao()` + `service.proposals()`) is included, by
  contrast, because that combination needs no new server-side filter — it's
  just two existing GETs made in parallel. Revisit this once the hosted
  moloch-service grows a `?member=0x...` filter on its `/members` endpoint.
