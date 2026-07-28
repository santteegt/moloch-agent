#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig, type Config } from './config.js';
import { decodeProposal } from './decode.js';
import { getNetwork } from './networks.js';
import { createServiceClient, type ServiceClient } from './service.js';
import {
  buildOldestReadyProcessTx,
  estimateBaalGas,
  preflightProcess,
  processQueue,
  proposalLifecycle,
  readBalances,
  readDaoDirect,
  readDaoHistory,
  readProposalDirect,
  readTreasuryTokens,
  resolveProposalOffering,
} from './chain.js';
import {
  asAddress,
  asHex,
  BAAL_ETH_TOKEN,
  buildApproveTokenTx,
  buildCancelTx,
  buildCustomProposalTx,
  buildDaoMetaTx,
  buildDaoRecordTx,
  buildGovernanceSettingsTx,
  buildMemoryPostTx,
  buildMintLootTx,
  buildMintSharesTx,
  buildPaymentTx,
  buildProcessTx,
  buildRagequitTx,
  buildSignalTx,
  buildSponsorTx,
  buildSummonTx,
  buildTokenSettingsTx,
  buildTributeTx,
  buildUnwrapEthTx,
  buildVoteTx,
  buildWrapEthTx,
  type BuiltTx,
  type CustomProposalAction,
  type GovernanceSettingsParams,
  type SummonParams,
} from './tx.js';

const SERVER_NAME = 'moloch-agent-mcp-server';
const SERVER_VERSION = '0.1.0';

// Tool coverage vs. cli.ts, and the handful of commands deliberately left
// out (and why), is tracked in docs/MCP_SERVER_SCOPE.md rather than
// duplicated here. See CHANGELOG.md for the version history of this server.

const BUILD_ONLY_NOTE = 'Build-only: returns an unsigned {to, value, data, chainId} transaction. This server never signs or broadcasts; the caller is responsible for signing and sending the returned transaction.';
const AUTO_FETCH_OFFERING_NOTE = 'When true and no explicit raw offering is given, reads the DAO\'s current proposalOffering from chain and uses it as the transaction value. Requires RPC_URL. Ignored if the explicit raw offering field is set.';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 0x-prefixed 20-byte hex address.');
const HexDataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/, 'Expected 0x-prefixed hex calldata.');
const RawUintSchema = z.union([z.string(), z.number()])
  .describe('Non-negative integer in raw base units, as a decimal string or a safe integer number.');
const ProposalIdSchema = z.number().int().nonnegative().describe('On-chain Baal proposal id.');

const BuiltTxOutputSchema = {
  summary: z.record(z.string(), z.unknown()).describe('Human-readable description of the built transaction.'),
  tx: z.object({
    chainId: z.number(),
    to: z.string(),
    value: z.string(),
    data: z.string(),
    gas: z.string().optional(),
  }).describe('Unsigned transaction: sign and send this yourself.'),
};

const SummonParamsSchema = z.object({
  daoName: z.string().min(1),
  description: z.string().optional(),
  longDescription: z.string().optional(),
  avatarImg: z.string().optional(),
  bannerImg: z.string().optional(),
  links: z.unknown().optional(),
  goalsURI: z.string().optional(),
  charterURI: z.string().optional(),
  joinRulesURI: z.string().optional(),
  rulesURI: z.string().optional(),
  manifestoURI: z.string().optional(),
  communityMemoryURI: z.string().optional(),
  proposalWorkspaceURI: z.string().optional(),
  sharedStateURI: z.string().optional(),
  memberAddresses: z.array(AddressSchema).min(1),
  memberShares: z.array(RawUintSchema).min(1),
  memberLoot: z.array(RawUintSchema).optional(),
  tokenName: z.string().min(1),
  tokenSymbol: z.string().min(1),
  lootTokenName: z.string().min(1),
  lootTokenSymbol: z.string().min(1),
  votingTransferable: z.boolean().optional(),
  nvTransferable: z.boolean().optional(),
  votingPeriodInSeconds: z.number().int().nonnegative(),
  gracePeriodInSeconds: z.number().int().nonnegative(),
  newOffering: RawUintSchema.optional(),
  quorum: RawUintSchema,
  sponsorThreshold: RawUintSchema,
  minRetention: RawUintSchema,
  shamanAddresses: z.array(AddressSchema).optional(),
  shamanPermissions: z.array(RawUintSchema).optional(),
  safeAddress: AddressSchema.optional(),
  saltNonce: RawUintSchema.optional(),
}).describe('Same shape as the summon.json file passed to `moloch-agent summon --params`. All share/loot/offering/threshold values are raw base units; quorum/minRetention are whole-number percentages.');

export function createServer(config: Config, service: ServiceClient): McpServer {
  // Throws on an unsupported chain ID before any tool is registered.
  getNetwork(config.chainId);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const chainId = config.chainId;

  function toBigInt(value: string | number, field: string): bigint {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
      return BigInt(value);
    }
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error(`${field} must be a non-negative integer string in raw base units.`);
    return BigInt(normalized);
  }

  // Precedence: an explicit raw value always wins; otherwise, when the caller opts
  // in via autoFetchProposalOffering, read the DAO's current proposalOffering from
  // chain; otherwise leave it undefined so the builder defaults to 0.
  async function resolveOffering(
    dao: `0x${string}`,
    proposalOfferingRaw: string | number | undefined,
    autoFetchProposalOffering: boolean | undefined,
  ): Promise<bigint | undefined> {
    if (proposalOfferingRaw != null) return toBigInt(proposalOfferingRaw, 'proposalOfferingRaw');
    if (autoFetchProposalOffering) return resolveProposalOffering(config, dao);
    return undefined;
  }

  // Mirrors cli.ts's parseRagequitTokens (not exported from tx.ts/chain.ts):
  // resolves the ETH/NATIVE sentinel alias and enforces Baal's ascending
  // token-address ordering requirement for ragequit. This is request
  // normalization, not contract-interaction logic, so it's fine to keep a
  // small local copy rather than reaching into cli.ts (which is unsafe to
  // import — see the module comment above / docs/MCP_SERVER_SCOPE.md).
  function normalizeRagequitTokens(tokens: string[]): `0x${string}`[] {
    const resolved = tokens.map((token) => (
      /^(ETH|NATIVE)$/i.test(token) ? (BAAL_ETH_TOKEN as `0x${string}`) : asAddress(token)
    ));
    const sorted = [...resolved].sort((a, b) => (BigInt(a.toLowerCase()) < BigInt(b.toLowerCase()) ? -1 : 1));
    if (resolved.some((token, index) => token.toLowerCase() !== sorted[index].toLowerCase())) {
      throw new Error('Baal ragequit token list must be sorted ascending. Use ETH/NATIVE for the Baal ETH sentinel.');
    }
    return resolved;
  }

  function errorResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }

  async function safeBuiltTx(build: () => BuiltTx | Promise<BuiltTx>) {
    try {
      const built = await build();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(built, null, 2) }],
        structuredContent: built as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function safeRead(read: () => Promise<unknown>) {
    try {
      const value = await read();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value as Record<string, unknown>,
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  // Annotation policy (per the MCP spec's ToolAnnotations, which readOnlyHint
  // makes the primary signal — destructiveHint/idempotentHint are only
  // meaningful once readOnlyHint is false):
  // - readOnlyHint: true for every tool except moloch_service_pin_json. The
  //   "write" tools only build and return calldata; they never sign, send,
  //   or otherwise mutate anything, so they don't modify their environment
  //   any more than a read does. moloch_service_pin_json is the one
  //   exception: it performs a real HTTP write to the hosted pinning
  //   service as soon as it's called.
  // - destructiveHint: false everywhere; nothing here ever destroys state.
  // - idempotentHint: true almost everywhere (repeated calls have no
  //   additional effect, trivially, since nothing has any effect). false
  //   for moloch_summon (random saltNonce when omitted), moloch_post_memory
  //   (stamps createdAt), and moloch_update_dao_meta (stamps updatedAt) — same
  //   input can still produce different calldata across calls, and
  //   moloch_service_pin_json (each call creates a new pin).
  // - openWorldHint: false for pure builders with no I/O at all; true for
  //   anything that reads the chain or the hosted service.
  server.registerTool(
    'moloch_summon',
    {
      title: 'Summon a Moloch v3 DAO',
      description: `Builds the unsigned transaction that summons a new Moloch v3 (Baal) DAO on Base via the DAOhaus v3 advanced-token summoner, including governance config, shamans, and summoner metadata in one call. ${BUILD_ONLY_NOTE}`,
      inputSchema: { params: SummonParamsSchema },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ params }) => safeBuiltTx(() => buildSummonTx({ chainId, params: params as SummonParams })),
  );

  server.registerTool(
    'moloch_wrap_eth',
    {
      title: 'Wrap ETH into WETH',
      description: `Builds an unsigned WETH deposit transaction (native ETH -> WETH). Use this before approve-token/tribute flows that need WETH for token-for-shares proposals, since native ETH tribute is not supported. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        amountWei: RawUintSchema.describe('Amount of native ETH to wrap, in wei.'),
        weth: AddressSchema.optional().describe('WETH contract address. Defaults to Base WETH (0x4200...0006).'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ amountWei, weth }) => safeBuiltTx(() => buildWrapEthTx({
      chainId,
      amount: toBigInt(amountWei, 'amountWei'),
      weth: weth ? asAddress(weth) : getNetwork(chainId).contracts.WETH,
    })),
  );

  server.registerTool(
    'moloch_unwrap_eth',
    {
      title: 'Unwrap WETH into ETH',
      description: `Builds an unsigned WETH withdraw transaction (WETH -> native ETH). ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        amountWei: RawUintSchema.describe('Amount of WETH to unwrap, in wei.'),
        weth: AddressSchema.optional().describe('WETH contract address. Defaults to Base WETH (0x4200...0006).'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ amountWei, weth }) => safeBuiltTx(() => buildUnwrapEthTx({
      chainId,
      amount: toBigInt(amountWei, 'amountWei'),
      weth: weth ? asAddress(weth) : getNetwork(chainId).contracts.WETH,
    })),
  );

  server.registerTool(
    'moloch_approve_token',
    {
      title: 'Approve ERC-20 spending',
      description: `Builds an unsigned ERC-20 approve transaction. The DAOhaus Tribute Minion needs an allowance before a tribute/join-dao/swap proposal can be submitted for that token. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        token: AddressSchema.describe('ERC-20 token contract to approve.'),
        spender: AddressSchema.optional().describe('Spender address. Defaults to the DAOhaus Tribute Minion.'),
        amountRaw: RawUintSchema.describe('Approval amount, in the token\'s raw base units.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ token, spender, amountRaw }) => safeBuiltTx(() => buildApproveTokenTx({
      chainId,
      token: asAddress(token),
      spender: spender ? asAddress(spender) : undefined,
      amount: toBigInt(amountRaw, 'amountRaw'),
    })),
  );

  server.registerTool(
    'moloch_submit_tribute',
    {
      title: 'Submit a tribute (tokens-for-shares) proposal',
      description: `Builds an unsigned submitTributeProposal transaction via the DAOhaus Tribute Minion, requesting DAO voting shares and/or non-voting loot in exchange for ERC-20 tokens (this covers the CLI's tribute/join-dao/swap/token-swap aliases). Native ETH and the zero address are not supported tribute tokens; wrap ETH to WETH first. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema.describe('Target Baal DAO address.'),
        token: AddressSchema.describe('ERC-20 tribute token address (e.g. Base WETH for wrapped-ETH tribute).'),
        amountRaw: RawUintSchema.optional().describe('Tribute amount in the token\'s raw base units. Defaults to 0.'),
        sharesRaw: RawUintSchema.optional().describe('Voting shares requested, in raw 18-decimal base units. Defaults to 0.'),
        lootRaw: RawUintSchema.optional().describe('Non-voting loot requested, in raw 18-decimal base units. Defaults to 0.'),
        title: z.string().optional().describe('Proposal title. Defaults to "Tribute for DAO tokens".'),
        description: z.string().optional().describe('Proposal description.'),
        link: z.string().optional().describe('Proposal content URI (e.g. ipfs://... proposal workspace link).'),
        expiration: z.number().int().nonnegative().optional().describe('Unix timestamp after which the proposal expires. Defaults to no expiration.'),
        baalGasRaw: RawUintSchema.optional().describe('Baal gas stipend override, in raw units.'),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0; read the DAO\'s proposalOffering via moloch_read_dao if the DAO requires one.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, token, amountRaw, sharesRaw, lootRaw, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildTributeTx({
      chainId,
      dao: asAddress(dao),
      token,
      amount: amountRaw == null ? undefined : toBigInt(amountRaw, 'amountRaw'),
      shares: sharesRaw == null ? undefined : toBigInt(sharesRaw, 'sharesRaw'),
      loot: lootRaw == null ? undefined : toBigInt(lootRaw, 'lootRaw'),
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_sponsor',
    {
      title: 'Sponsor a proposal',
      description: `Builds an unsigned sponsorProposal transaction, moving a submitted proposal into voting. Caller must hold at least the DAO's sponsorThreshold in shares. ${BUILD_ONLY_NOTE}`,
      inputSchema: { dao: AddressSchema, proposal: ProposalIdSchema },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, proposal }) => safeBuiltTx(() => buildSponsorTx({ chainId, dao: asAddress(dao), proposal })),
  );

  server.registerTool(
    'moloch_vote',
    {
      title: 'Vote on a proposal',
      description: `Builds an unsigned submitVote transaction. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        proposal: ProposalIdSchema,
        approved: z.boolean().describe('true for a yes vote, false for a no vote.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, proposal, approved }) => safeBuiltTx(() => buildVoteTx({ chainId, dao: asAddress(dao), proposal, approved })),
  );

  server.registerTool(
    'moloch_process',
    {
      title: 'Process a proposal',
      description: `Builds an unsigned processProposal transaction. Requires the exact indexed proposalData for the proposal (see moloch_proposals); processing is mechanical settlement after voting and grace period are complete. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        proposal: ProposalIdSchema,
        proposalData: HexDataSchema.describe('Exact indexed proposalData bytes for this proposal, from moloch_proposals.'),
        gasLimitRaw: RawUintSchema.optional().describe('Gas limit override, in raw units.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, proposal, proposalData, gasLimitRaw }) => safeBuiltTx(() => buildProcessTx({
      chainId,
      dao: asAddress(dao),
      proposal,
      proposalData: asHex(proposalData),
      gasLimit: gasLimitRaw == null ? undefined : toBigInt(gasLimitRaw, 'gasLimitRaw'),
    })),
  );

  server.registerTool(
    'moloch_process_ready',
    {
      title: 'Process the oldest ready proposal',
      description: `Reads the DAO's indexed proposal queue, derives which proposals are processable now via direct chain state (not indexed "passed"), and builds an unsigned processProposal transaction for the oldest ready one. Throws if none are ready. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        first: z.number().int().positive().max(1000).optional().describe('Number of indexed proposals to scan. Defaults to 100.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, first }) => {
      try {
        const built = await buildOldestReadyProcessTx({ config, service, chainId, dao: asAddress(dao), first: first ?? 100 });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(built, null, 2) }],
          structuredContent: built as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'moloch_mint_shares',
    {
      title: 'Mint voting shares proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, mints DAO voting shares directly to the given recipients. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        recipients: z.array(AddressSchema).min(1),
        amountsRaw: z.array(RawUintSchema).min(1).describe('Share amounts in raw 18-decimal base units, aligned by index with recipients.'),
        title: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, recipients, amountsRaw, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildMintSharesTx({
      chainId,
      dao: asAddress(dao),
      recipients: recipients.map(asAddress),
      amounts: amountsRaw.map((value) => toBigInt(value, 'amountsRaw')),
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_mint_loot',
    {
      title: 'Mint non-voting loot proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, mints DAO non-voting loot directly to the given recipients. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        recipients: z.array(AddressSchema).min(1),
        amountsRaw: z.array(RawUintSchema).min(1).describe('Loot amounts in raw 18-decimal base units, aligned by index with recipients.'),
        title: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, recipients, amountsRaw, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildMintLootTx({
      chainId,
      dao: asAddress(dao),
      recipients: recipients.map(asAddress),
      amounts: amountsRaw.map((value) => toBigInt(value, 'amountsRaw')),
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_submit_payment',
    {
      title: 'Treasury payment proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, transfers ETH or an ERC-20 token from the DAO treasury (its Baal-owned Safe) to a recipient. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        recipient: AddressSchema,
        amountRaw: RawUintSchema.describe('Payment amount in raw base units (wei for native ETH, or the token\'s raw base units for ERC-20).'),
        token: AddressSchema.optional().describe('ERC-20 token address. Omit for a native ETH payment.'),
        title: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, recipient, amountRaw, token, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildPaymentTx({
      chainId,
      dao: asAddress(dao),
      recipient: asAddress(recipient),
      amount: toBigInt(amountRaw, 'amountRaw'),
      token: token ? asAddress(token) : undefined,
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_cancel',
    {
      title: 'Cancel a proposal',
      description: `Builds an unsigned cancelProposal transaction. Only the proposal's sponsor (or the DAO's shaman permissions allowing) can cancel. ${BUILD_ONLY_NOTE}`,
      inputSchema: { dao: AddressSchema, proposal: ProposalIdSchema },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, proposal }) => safeBuiltTx(() => buildCancelTx({ chainId, dao: asAddress(dao), proposal })),
  );

  server.registerTool(
    'moloch_ragequit',
    {
      title: 'Ragequit (exit the DAO)',
      description: `Builds an unsigned ragequit transaction. This is a direct member action, not a proposal: it burns the caller's shares/loot and claims proportional treasury assets to "to". Treat it as irreversible once signed and broadcast. The token list must be sorted ascending, as Baal requires — use moloch_list_treasury_tokens's ragequitTokensCsv as the source, or pass "ETH"/"NATIVE" for the Baal ETH sentinel. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        to: AddressSchema.describe('Recipient of the claimed treasury assets.'),
        sharesToBurnRaw: RawUintSchema.optional().describe('Voting shares to burn, in raw 18-decimal base units. Defaults to 0.'),
        lootToBurnRaw: RawUintSchema.optional().describe('Non-voting loot to burn, in raw 18-decimal base units. Defaults to 0.'),
        tokens: z.array(z.union([AddressSchema, z.enum(['ETH', 'NATIVE'])])).min(1)
          .describe('Treasury token list, ascending-sorted by address (Baal requirement). Get this from moloch_list_treasury_tokens\'s ragequitTokensCsv.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, to, sharesToBurnRaw, lootToBurnRaw, tokens }) => safeBuiltTx(() => buildRagequitTx({
      chainId,
      dao: asAddress(dao),
      to: asAddress(to),
      sharesToBurn: sharesToBurnRaw == null ? 0n : toBigInt(sharesToBurnRaw, 'sharesToBurnRaw'),
      lootToBurn: lootToBurnRaw == null ? 0n : toBigInt(lootToBurnRaw, 'lootToBurnRaw'),
      tokens: normalizeRagequitTokens(tokens),
    })),
  );

  server.registerTool(
    'moloch_post_memory',
    {
      title: 'Post a community memory record',
      description: `Builds an unsigned Poster.post transaction that writes a JSON record (e.g. a thread post, vote reason, or draft) to the DAOhaus community-memory database. The sender must satisfy the DAO's database tag permissions for the record to index. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        table: z.string().optional().describe('Record table. Defaults to "communityMemory".'),
        type: z.string().optional().describe('Record type, e.g. "thread-post" or "vote-reason". Defaults to "thread-post".'),
        threadId: z.string().optional(),
        topicId: z.string().optional(),
        proposalId: z.string().optional(),
        draftId: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        vote: z.string().optional().describe('"yes" or "no", for vote-reason records.'),
        contentURI: z.string().optional(),
        contentHash: z.string().optional(),
        workspaceURI: z.string().optional(),
        stateURI: z.string().optional(),
        agent: z.string().optional(),
        version: z.string().optional(),
        tag: z.string().optional().describe('Poster tag. Defaults to the member-database tag.'),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ dao, table, type, threadId, topicId, proposalId, draftId, title, body, vote, contentURI, contentHash, workspaceURI, stateURI, agent, version, tag }) => safeBuiltTx(() => buildMemoryPostTx({
      chainId,
      dao: asAddress(dao),
      table: table ?? 'communityMemory',
      type,
      threadId,
      topicId,
      proposalId,
      draftId,
      title,
      body,
      vote,
      contentURI,
      contentHash,
      workspaceURI,
      stateURI,
      agent,
      version,
      tag,
    })),
  );

  server.registerTool(
    'moloch_submit_signal',
    {
      title: 'Submit a signal proposal',
      description: `Builds an unsigned submitProposal transaction for a non-binding "signal" proposal (a Poster post wrapped as a Baal proposal, with no on-chain actions). ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        title: z.string().min(1),
        description: z.string(),
        link: z.string().optional().describe('Proposal content URI (e.g. ipfs://... proposal workspace link).'),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0; read the DAO\'s proposalOffering via moloch_read_dao if the DAO requires one.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildSignalTx({
      chainId,
      dao: asAddress(dao),
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_update_dao_meta',
    {
      title: 'Update DAO metadata proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, posts updated DAO profile metadata (name, description, workspace URIs, ...) via the Poster contract. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        title: z.string().optional().describe('Proposal title. Defaults to "Update DAO metadata".'),
        description: z.string().optional().describe('Proposal description.'),
        link: z.string().optional().describe('Proposal content URI.'),
        name: z.string().optional().describe('New DAO display name.'),
        daoDescription: z.string().optional().describe('New DAO profile description (distinct from the proposal description).'),
        communityMemoryURI: z.string().optional(),
        proposalWorkspaceURI: z.string().optional(),
        sharedStateURI: z.string().optional(),
        web: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ dao, title, description, link, name, daoDescription, communityMemoryURI, proposalWorkspaceURI, sharedStateURI, web, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildDaoMetaTx({
      chainId,
      dao: asAddress(dao),
      title,
      description,
      link,
      name,
      daoDescription,
      communityMemoryURI,
      proposalWorkspaceURI,
      sharedStateURI,
      web,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_submit_dao_record',
    {
      title: 'Submit a generic DAO record proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, posts a record to an arbitrary Poster table (charter, joinRules, manifesto, ...) — the same mechanism moloch_update_dao_meta uses for the daoProfile table, generalized to any table. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        table: z.string().optional().describe('Poster record table to post to, e.g. "charter" or "joinRules". Defaults to "daoProfile" — for that specific table, prefer moloch_update_dao_meta\'s named fields.'),
        tag: z.string().optional().describe('Poster tag under which the record is indexed. Defaults to the DAO profile update tag.'),
        content: z.record(z.string(), z.unknown()).optional().describe('Arbitrary record body merged into the posted content. Cannot override the daoId/table/queryType/updatedAt envelope fields.'),
        title: z.string().optional().describe('Proposal title. Defaults to "Update <table> record".'),
        description: z.string().optional().describe('Proposal description.'),
        link: z.string().optional().describe('Proposal content URI.'),
        name: z.string().optional().describe('Named field: DAO display name (only meaningful for table "daoProfile").'),
        daoDescription: z.string().optional().describe('Named field: DAO profile description (only meaningful for table "daoProfile").'),
        communityMemoryURI: z.string().optional(),
        proposalWorkspaceURI: z.string().optional(),
        sharedStateURI: z.string().optional(),
        web: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ dao, table, tag, content, title, description, link, name, daoDescription, communityMemoryURI, proposalWorkspaceURI, sharedStateURI, web, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildDaoRecordTx({
      chainId,
      dao: asAddress(dao),
      table,
      tag,
      content,
      title,
      description,
      link,
      name,
      daoDescription,
      communityMemoryURI,
      proposalWorkspaceURI,
      sharedStateURI,
      web,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_update_gov_settings',
    {
      title: 'Update governance settings proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, calls setGovernanceConfig with new voting/grace periods, offering, quorum, sponsor threshold, and minimum retention. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        link: z.string().optional().describe('Proposal content URI. Overrides params.link if both are set.'),
        params: z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          link: z.string().optional(),
          votingPeriodInSeconds: z.number().int().nonnegative(),
          gracePeriodInSeconds: z.number().int().nonnegative(),
          newOffering: RawUintSchema,
          quorum: RawUintSchema.describe('Whole-number percentage (0-100).'),
          sponsorThreshold: RawUintSchema,
          minRetention: RawUintSchema.describe('Whole-number percentage (0-100).'),
          expiration: z.number().int().nonnegative().optional(),
          baalGasRaw: RawUintSchema.optional(),
          valueRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        }),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, link, params, autoFetchProposalOffering }) => safeBuiltTx(async () => buildGovernanceSettingsTx({
      chainId,
      dao: asAddress(dao),
      link,
      params: {
        title: params.title,
        description: params.description,
        link: params.link,
        votingPeriodInSeconds: params.votingPeriodInSeconds,
        gracePeriodInSeconds: params.gracePeriodInSeconds,
        newOffering: toBigInt(params.newOffering, 'params.newOffering'),
        quorum: toBigInt(params.quorum, 'params.quorum'),
        sponsorThreshold: toBigInt(params.sponsorThreshold, 'params.sponsorThreshold'),
        minRetention: toBigInt(params.minRetention, 'params.minRetention'),
        expiration: params.expiration,
        baalGas: params.baalGasRaw == null ? undefined : toBigInt(params.baalGasRaw, 'params.baalGasRaw'),
        value: await resolveOffering(asAddress(dao), params.valueRaw, autoFetchProposalOffering),
      } satisfies GovernanceSettingsParams,
    })),
  );

  server.registerTool(
    'moloch_update_token_settings',
    {
      title: 'Update token settings proposal',
      description: `Builds an unsigned submitProposal transaction that, if it passes and is processed, calls setAdminConfig to pause/unpause DAO share and/or loot transfers. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        pauseShares: z.boolean(),
        pauseLoot: z.boolean(),
        title: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, pauseShares, pauseLoot, title, description, link, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildTokenSettingsTx({
      chainId,
      dao: asAddress(dao),
      pauseShares,
      pauseLoot,
      title,
      description,
      link,
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_submit_custom_proposal',
    {
      title: 'Submit a custom (generic action) proposal',
      description: `Builds an unsigned submitProposal transaction wrapping an arbitrary list of Safe-style actions ({to, value, data, operation}) via Baal's multisend — the generic escape hatch for proposal types not covered by the other proposal tools. Use moloch_read_dao/moloch_service_list_proposals/etc. to inspect state and encode the calldata yourself for each action. ${BUILD_ONLY_NOTE}`,
      inputSchema: {
        dao: AddressSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        link: z.string().optional(),
        proposalType: z.string().optional().describe('Free-form proposal type tag. Defaults to "CUSTOM".'),
        actions: z.array(z.object({
          to: AddressSchema,
          valueRaw: RawUintSchema.optional().describe('Native ETH value for this action, in wei. Defaults to 0.'),
          data: HexDataSchema.optional().describe('Calldata for this action. Defaults to "0x".'),
          operation: z.number().int().min(0).max(1).optional().describe('0 = call, 1 = delegatecall. Defaults to 0.'),
        })).min(1),
        expiration: z.number().int().nonnegative().optional(),
        baalGasRaw: RawUintSchema.optional(),
        proposalOfferingRaw: RawUintSchema.optional().describe('ETH proposal offering (transaction value), in wei. Defaults to 0.'),
        autoFetchProposalOffering: z.boolean().optional().describe(AUTO_FETCH_OFFERING_NOTE),
      },
      outputSchema: BuiltTxOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dao, title, description, link, proposalType, actions, expiration, baalGasRaw, proposalOfferingRaw, autoFetchProposalOffering }) => safeBuiltTx(async () => buildCustomProposalTx({
      chainId,
      dao: asAddress(dao),
      title,
      description,
      link,
      proposalType,
      actions: actions.map((action): CustomProposalAction => ({
        to: asAddress(action.to),
        value: action.valueRaw == null ? undefined : toBigInt(action.valueRaw, 'actions[].valueRaw'),
        data: action.data == null ? undefined : asHex(action.data),
        operation: action.operation,
      })),
      expiration,
      baalGas: baalGasRaw == null ? undefined : toBigInt(baalGasRaw, 'baalGasRaw'),
      proposalOffering: await resolveOffering(asAddress(dao), proposalOfferingRaw, autoFetchProposalOffering),
    })),
  );

  server.registerTool(
    'moloch_read_dao',
    {
      title: 'Read DAO state directly from chain',
      description: 'Reads proposalCount, proposalOffering, sponsorThreshold, and latestSponsoredProposalId directly from the Baal contract on Base (no indexer dependency).',
      inputSchema: { dao: AddressSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao }) => safeRead(() => readDaoDirect(config, asAddress(dao))),
  );

  // TODO(pagination): mcp_best_practices.md wants list tools to return
  // has_more/next_offset/total_count alongside the page. We pass first/skip
  // straight through to the hosted service and return its response as-is;
  // the indexer's /proposals endpoint doesn't currently expose a total
  // count, so synthesizing that metadata here isn't possible without a
  // separate count query against the service (out of scope for this
  // build/read-wrapper pass — would need service.ts's proposals() to grow
  // an optional count field, or a new count endpoint on the hosted side).
  server.registerTool(
    'moloch_service_list_proposals',
    {
      title: 'List indexed DAO proposals',
      description: 'Direct passthrough to the hosted moloch-service: lists the DAO\'s proposals from the indexer (Graph), including proposalData needed for moloch_process.',
      inputSchema: {
        dao: AddressSchema,
        first: z.number().int().positive().max(1000).optional().describe('Page size. Defaults to 100.'),
        skip: z.number().int().nonnegative().optional().describe('Pagination offset. Defaults to 0.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, first, skip }) => safeRead(() => service.proposals({ dao, first: first ?? 100, skip: skip ?? 0 })),
  );

  server.registerTool(
    'moloch_list_treasury_tokens',
    {
      title: 'List DAO treasury tokens',
      description: 'Resolves the DAO\'s Safe treasury address and lists its non-zero token balances, plus a ready-to-use ragequitTokensCsv (ascending-sorted token list, as Baal\'s ragequit requires).',
      inputSchema: { dao: AddressSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao }) => safeRead(() => readTreasuryTokens({ config, service, dao: asAddress(dao) })),
  );

  // TODO(pagination): same gap as moloch_service_list_proposals — first/skip
  // only, no has_more/next_offset/total_count.
  server.registerTool(
    'moloch_read_dao_history',
    {
      title: 'Read DAO profile and proposal history together',
      description: 'Composes the indexed DAO profile with its proposal history in one call (moloch-agent has no combined indexer endpoint, so this issues two requests: moloch_service_get_dao + moloch_service_list_proposals). Equivalent to moloch.mjs\'s graph-dao-history.',
      inputSchema: {
        dao: AddressSchema,
        first: z.number().int().positive().max(1000).optional().describe('Number of proposals to fetch. Defaults to 100.'),
        skip: z.number().int().nonnegative().optional().describe('Number of proposals to skip, for pagination. Defaults to 0.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, first, skip }) => safeRead(() => readDaoHistory({ config, service, dao: asAddress(dao), first: first ?? 100, skip: skip ?? 0 })),
  );

  server.registerTool(
    'moloch_read_proposal',
    {
      title: 'Read a single proposal directly from chain',
      description: 'Reads one proposal\'s raw tuple, status flags, and state directly from the Baal contract on Base (no indexer dependency).',
      inputSchema: { dao: AddressSchema, proposal: ProposalIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, proposal }) => safeRead(() => readProposalDirect(config, asAddress(dao), proposal)),
  );

  server.registerTool(
    'moloch_read_proposal_lifecycle',
    {
      title: 'Derive a proposal\'s lifecycle status',
      description: 'Answers "is this proposal processable right now, and if not, why": blends the indexed proposal (falling back to a chain-only read if the indexer is unavailable) with direct chain status/state to derive a lifecycle summary (needsSponsor, inVoting, inGrace, processableNow, failedQuorum, ...). This is the same derivation moloch-agent\'s process-queue/process-ready use, and does not rely on indexed "passed" as the execution gate. Use moloch_preflight_process instead if you also want the already-processed and proposalData-match checks moloch_process\'s CLI counterpart runs before broadcasting.',
      inputSchema: { dao: AddressSchema, proposal: ProposalIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, proposal }) => safeRead(() => proposalLifecycle({ config, service, dao: asAddress(dao), proposal })),
  );

  server.registerTool(
    'moloch_preflight_process',
    {
      title: 'Check whether a proposal is safe to process now',
      description: 'Runs the same checks this server\'s moloch-agent CLI applies before broadcasting `process`: processableNow (via moloch_read_proposal_lifecycle\'s derivation), not already processed, and — when proposalData is supplied — that it matches what the indexer has for this proposal. Returns {ok, reason, status, processGasLimit, ...} instead of throwing, so a caller can inspect why a proposal isn\'t ready before calling moloch_process.',
      inputSchema: {
        dao: AddressSchema,
        proposal: ProposalIdSchema,
        proposalData: HexDataSchema.optional().describe('The proposalData you intend to pass to moloch_process. Verified against the indexer\'s copy when given.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, proposal, proposalData }) => safeRead(() => preflightProcess({
      config,
      service,
      dao: asAddress(dao),
      proposal,
      proposalData: proposalData == null ? undefined : asHex(proposalData),
    })),
  );

  server.registerTool(
    'moloch_estimate_baal_gas',
    {
      title: 'Estimate a safe baalGas stipend',
      description: 'Simulates a proposal\'s multisend calldata through the DAO\'s Safe module (the same path a passed proposal executes through) to estimate a submitProposal baalGas stipend, ported from the CLI\'s --estimate-baal-gas. Offered as a standalone estimate rather than auto-applied to any build tool here: this server\'s write tools default baalGas to 0 and expect the caller\'s smart account or relayer to size execution gas, so this tool is CLI-oriented but usable from either.',
      inputSchema: {
        dao: AddressSchema,
        proposalData: HexDataSchema.describe('The proposal\'s multisend calldata, e.g. a built tx\'s summary.proposalData.'),
        actionCount: z.number().int().positive().optional().describe('Number of actions encoded in the multisend. Defaults to 1.'),
        bufferPercent: z.number().int().positive().optional().describe('Whole-number percentage multiplier applied to the raw gas estimate. Defaults to 120 (1.2x).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, proposalData, actionCount, bufferPercent }) => safeRead(() => estimateBaalGas({
      config,
      service,
      dao: asAddress(dao),
      proposalData: asHex(proposalData),
      actionCount: actionCount ?? 1,
      bufferPercent,
    })),
  );

  server.registerTool(
    'moloch_decode_proposal',
    {
      title: 'Decode proposal calldata into named actions',
      description: 'Decodes Baal submitProposal or multisend calldata into named actions (Poster posts are parsed as JSON, other Baal calls are decoded by function name and args, unrecognized calls fall back to their 4-byte selector). Verifies what a proposal actually executes before signing (pass --data, e.g. this server\'s own build-only tx.data) or before voting (pass --dao/--proposal to fetch proposalData from the indexer — the Baal contract itself only stores a hash, not the calldata, so this path requires the indexer to have it).',
      inputSchema: {
        data: HexDataSchema.optional().describe('submitProposal or multisend calldata to decode directly. Takes precedence over dao/proposal.'),
        dao: AddressSchema.optional().describe('Fetch proposalData for this DAO + proposal from the indexer instead of decoding --data directly.'),
        proposal: ProposalIdSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ data, dao, proposal }) => safeRead(() => decodeProposal({ config, service, data: data == null ? undefined : asHex(data), dao, proposal })),
  );

  // TODO(pagination): same gap as moloch_service_list_proposals — this
  // scans up to `first` indexed proposals and returns the full derived
  // queue with no has_more/next_offset/total_count. Queues are typically
  // small (only unprocessed proposals past their grace period), so this is
  // lower priority than the raw indexer list tools, but the same fix would
  // apply if a DAO's queue ever grows large enough to matter.
  server.registerTool(
    'moloch_list_process_queue',
    {
      title: 'List processable proposals',
      description: 'Scans the DAO\'s indexed proposals and derives, via direct chain state, which ones are processable right now (queued oldest-first). Use moloch_process_ready if you only want the built transaction for the single oldest one; use this to see the full queue and each item\'s status first.',
      inputSchema: {
        dao: AddressSchema,
        first: z.number().int().positive().max(1000).optional().describe('Number of indexed proposals to scan. Defaults to 100.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, first }) => safeRead(() => processQueue({ config, service, dao: asAddress(dao), first: first ?? 100 })),
  );

  server.registerTool(
    'moloch_read_balances',
    {
      title: 'Read native/ERC-20 balances',
      description: 'Reads the native ETH balance (and, if a token is given, its ERC-20 balance) for an explicit address, or for a DAO\'s Safe treasury address when only "dao" is given. Requires at least one of "dao" or "address".',
      inputSchema: {
        dao: AddressSchema.optional().describe('Look up this DAO\'s Safe treasury address. Ignored if "address" is set.'),
        address: AddressSchema.optional().describe('Explicit address to read balances for.'),
        token: AddressSchema.optional().describe('ERC-20 token to also read a balance for.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, address, token }) => safeRead(() => readBalances({
      config,
      service,
      dao: dao ? asAddress(dao) : undefined,
      address: address ? asAddress(address) : undefined,
      token: token ? asAddress(token) : undefined,
    })),
  );

  server.registerTool(
    'moloch_service_get_dao',
    {
      title: 'Read the indexed DAO profile',
      description: 'Direct passthrough to the hosted moloch-service: the indexed DAO document (name, safeAddress, metadata, ...) from the Graph. Distinct from moloch_read_dao, which reads counters directly from the Baal contract.',
      inputSchema: { dao: AddressSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao }) => safeRead(() => service.dao({ dao })),
  );

  server.registerTool(
    'moloch_service_get_proposal',
    {
      title: 'Read a single indexed proposal',
      description: 'Direct passthrough to the hosted moloch-service: a single proposal document from the indexer (Graph), by id.',
      inputSchema: { dao: AddressSchema, proposal: ProposalIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, proposal }) => safeRead(() => service.proposal({ dao, proposal: String(proposal) })),
  );

  // TODO(pagination): same gap as moloch_service_list_proposals — see that
  // TODO. Applies here too since /members has the same first/skip shape
  // with no total count.
  server.registerTool(
    'moloch_service_list_members',
    {
      title: 'List indexed DAO members',
      description: 'Direct passthrough to the hosted moloch-service: the DAO\'s member list from the indexer (Graph).',
      inputSchema: {
        dao: AddressSchema,
        first: z.number().int().positive().max(1000).optional().describe('Page size. Defaults to 100.'),
        skip: z.number().int().nonnegative().optional().describe('Pagination offset. Defaults to 0.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, first, skip }) => safeRead(() => service.members({ dao, first: first ?? 100, skip: skip ?? 0 })),
  );

  // TODO(pagination): same gap as moloch_service_list_proposals — see that
  // TODO. Applies here too since /records has the same first/skip shape
  // with no total count.
  server.registerTool(
    'moloch_service_list_records',
    {
      title: 'List indexed community memory records',
      description: 'Direct passthrough to the hosted moloch-service: community-memory-style records (posts, votes, drafts, ...) for a DAO table from the indexer (Graph).',
      inputSchema: {
        dao: AddressSchema,
        table: z.string().optional().describe('Record table. Defaults to "communityMemory".'),
        first: z.number().int().positive().max(1000).optional().describe('Page size. Defaults to 100.'),
        skip: z.number().int().nonnegative().optional().describe('Pagination offset. Defaults to 0.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dao, table, first, skip }) => safeRead(() => service.records({ dao, table: table ?? 'communityMemory', first: first ?? 100, skip: skip ?? 0 })),
  );

  server.registerTool(
    'moloch_service_get_health',
    {
      title: 'Check hosted service health',
      description: 'Direct passthrough to the hosted moloch-service\'s health endpoint.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => safeRead(() => service.health()),
  );

  server.registerTool(
    'moloch_service_get_capabilities',
    {
      title: 'Read hosted service capabilities',
      description: 'Direct passthrough to the hosted moloch-service\'s capabilities endpoint.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => safeRead(() => service.capabilities()),
  );

  server.registerTool(
    'moloch_service_pin_json',
    {
      title: 'Pin arbitrary JSON to IPFS',
      description: 'Direct passthrough to the hosted moloch-service\'s /pin/json endpoint. Unlike every other tool in this server, this one is NOT build-only and returns no unsigned transaction: it actually performs the pin (a real HTTP write to the hosted service) as soon as it is called, and returns the resulting {cid, uri, gatewayUrl}. It never touches chain state or a wallet, so it does not conflict with this server\'s no-signing boundary — but callers should know it has a real, immediate side effect on the hosted pinning service.',
      inputSchema: {
        name: z.string().optional().describe('Optional name/label for the pinned content.'),
        data: z.unknown().describe('Arbitrary JSON-serializable data to pin.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, data }) => safeRead(() => service.pinJson({ name, data })),
  );

  return server;
}

// npm always installs bin entries (moloch-agent-mcp) as symlinks into
// node_modules/.bin. import.meta.url resolves through symlinks to the
// package's real file path, but process.argv[1] does not — it's the literal
// (symlinked) path the process was invoked with. Comparing them directly
// (as `import.meta.url === \`file://${process.argv[1]}\``) therefore always
// evaluates to false for anyone running the published bin, silently
// skipping main() and exiting with no output. Resolve argv[1]'s real path
// first so the comparison holds for both direct and symlinked invocation.
export function isMainModule(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

async function main() {
  const config = getConfig();
  const service = createServiceClient(config);
  const server = createServer(config, service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} running on stdio (chainId ${config.chainId}, build-only, no signing).\n`);
}
