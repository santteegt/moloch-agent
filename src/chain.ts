import { createPublicClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, type Hex } from 'viem';
import type { Config } from './config.js';
import { getNetwork } from './networks.js';
import type { ServiceClient } from './service.js';
import { BAAL_ABI, BAAL_ETH_TOKEN, GNOSIS_MODULE_ABI, parseBigint, type BuiltTx } from './tx.js';
import { buildProcessTx } from './tx.js';

// Baal proposal state ordinals, in on-chain enum order — translates numeric
// `state()`/`getProposalStatus()` reads into readable names. Used by
// readProposalDirect and deriveProposalLifecycle.
export const STATE_NAMES = ['unborn', 'submitted', 'voting', 'cancelled', 'grace', 'ready', 'processed', 'defeated'];

// Baal states from which a *previous* proposal counts as resolved enough to
// unblock processing the current one. Used by deriveProposalLifecycle's
// blockedByPreviousProposal check.
const PREV_PROCESS_ELIGIBLE = new Set([0, 3, 6, 7]);

// Extra gas headroom added on top of a proposal's declared baalGas when
// computing a `process` transaction's gas limit. Used by chainProposalContext.
const PROCESS_PROPOSAL_GAS_LIMIT_ADDITION = 400000n;

// Fallback gas limit for `process` when a proposal declared no baalGas (or
// none could be read). Used by chainProposalContext and buildOldestReadyProcessTx.
const DEFAULT_PROCESS_GAS_LIMIT = 800000n;

// Extra gas added per multisend action on top of the raw
// execTransactionFromModule gas simulation. Used by estimateBaalGas.
const ACTION_GAS_LIMIT_ADDITION = 150000n;

// Default safety multiplier (120 = 1.2x) applied to estimateBaalGas's raw
// estimate when the caller doesn't supply bufferPercent.
const DEFAULT_BAAL_GAS_BUFFER_PERCENT = 120;

// Minimal ERC-20 read ABI. Used by readBalances for optional --token balance lookups.
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

export async function readDaoDirect(config: Config, dao: `0x${string}`): Promise<Record<string, unknown>> {
  const client = publicClient(config);
  const [proposalCount, proposalOffering, sponsorThreshold, latestSponsoredProposalId] = await Promise.all([
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'proposalCount' }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'proposalOffering' }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'sponsorThreshold' }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'latestSponsoredProposalId' }),
  ]);
  return {
    dao,
    proposalCount: proposalCount.toString(),
    proposalOffering: proposalOffering.toString(),
    sponsorThreshold: sponsorThreshold.toString(),
    latestSponsoredProposalId: latestSponsoredProposalId.toString(),
  };
}

// Shared by the CLI (which parses --proposal-offering/--value into `explicit` itself)
// and the MCP server's autoFetchProposalOffering flag.
export async function resolveProposalOffering(config: Config, dao: `0x${string}`, explicit?: bigint): Promise<bigint> {
  if (explicit != null) return explicit;
  const daoState = await readDaoDirect(config, dao);
  const offering = daoState.proposalOffering;
  return typeof offering === 'string' ? parseBigint(offering) : 0n;
}

export async function readProposalDirect(config: Config, dao: `0x${string}`, proposal: number): Promise<Record<string, unknown>> {
  const client = publicClient(config);
  const [raw, status, state] = await Promise.all([
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'proposals', args: [BigInt(proposal)] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'getProposalStatus', args: [proposal] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'state', args: [proposal] }),
  ]);
  return {
    dao,
    proposal,
    raw: namedProposalTuple(raw),
    status: namedProposalStatus(status),
    state: Number(state),
    stateName: STATE_NAMES[Number(state)] || `unknown-${state}`,
  };
}

export async function readBalances(input: {
  config: Config;
  service: ServiceClient;
  dao?: `0x${string}`;
  address?: `0x${string}`;
  token?: `0x${string}`;
}): Promise<Record<string, unknown>> {
  const client = publicClient(input.config);
  let safeAddress: `0x${string}` | undefined;
  if (!input.address && input.dao) {
    safeAddress = await safeAddressForDao(input.service, input.dao);
  }
  const address = input.address || safeAddress;
  if (!address) throw new Error('Provide --address, or provide --dao for DAO Safe balance lookup.');
  const wei = await client.getBalance({ address });
  const result: Record<string, unknown> = {
    chainId: input.config.chainId,
    dao: input.dao || '',
    safeAddress: safeAddress || '',
    address,
    native: {
      symbol: 'ETH',
      wei: wei.toString(),
      eth: formatEther(wei),
    },
    explorerUrl: `${explorerBaseUrl(input.config.chainId)}/address/${address}`,
  };
  if (input.token) {
    const [rawBalance, decimals, symbol] = await Promise.all([
      client.readContract({ address: input.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
      client.readContract({ address: input.token, abi: ERC20_ABI, functionName: 'decimals' }),
      client.readContract({ address: input.token, abi: ERC20_ABI, functionName: 'symbol' }),
    ]);
    result.erc20 = {
      token: input.token,
      symbol,
      decimals,
      raw: rawBalance.toString(),
      formatted: formatUnits(rawBalance, decimals),
      explorerUrl: `${explorerBaseUrl(input.config.chainId)}/token/${input.token}?a=${address}`,
    };
  }
  return result;
}

export async function readTreasuryTokens(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
}): Promise<Record<string, unknown>> {
  const safeAddress = await safeAddressForDao(input.service, input.dao);
  const balances = await safeBalances(input.config.chainId, safeAddress);
  const tokens = balances
    .filter((item) => BigInt(String(item.balance || '0')) > 0n)
    .map((item) => ({
      tokenAddress: item.tokenAddress || BAAL_ETH_TOKEN,
      symbol: item.token?.symbol || (item.tokenAddress ? '' : 'ETH'),
      name: item.token?.name || (item.tokenAddress ? '' : 'Ether'),
      decimals: item.token?.decimals,
      balance: item.balance,
    }));
  const ragequitTokens = tokens
    .map((item) => item.tokenAddress)
    .sort((a, b) => BigInt(a.toLowerCase()) < BigInt(b.toLowerCase()) ? -1 : 1);
  return {
    dao: input.dao,
    safeAddress,
    tokens,
    ragequitTokens,
    ragequitTokensCsv: ragequitTokens.join(','),
    note: 'Use ragequitTokensCsv as --tokens. Native ETH is represented with Baal ETH sentinel.',
  };
}

// DAO profile + proposal history in one call, mirroring moloch.mjs's
// graph-dao-history. The hosted service has no combined endpoint, so this
// composes the two GETs the service does offer (dao + proposals).
export async function readDaoHistory(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
  first: number;
  skip: number;
}): Promise<Record<string, unknown>> {
  const [daoResult, proposalsResult] = await Promise.all([
    input.service.dao({ dao: input.dao }),
    input.service.proposals({ dao: input.dao, first: input.first, skip: input.skip }),
  ]);
  const dao = isRecord(daoResult) && isRecord(daoResult.dao) ? daoResult.dao : undefined;
  const proposals = extractProposals(proposalsResult);
  return { dao, proposals };
}

export async function proposalLifecycle(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
  proposal: number;
}): Promise<Record<string, unknown>> {
  let indexed: unknown;
  let indexedError: string | undefined;
  try {
    indexed = await input.service.proposal({ dao: input.dao, proposal: String(input.proposal) });
  } catch (error) {
    indexedError = compactError(error);
  }
  const proposal = extractProposal(indexed) || await chainOnlyProposal(input.config, input.dao, input.proposal);
  let chain: Record<string, unknown> = {};
  try {
    chain = await chainProposalContext(input.config, input.dao, proposal);
  } catch (error) {
    chain = { error: compactError(error) };
  }
  return {
    proposal: compactProposal(proposal),
    lifecycle: deriveProposalLifecycle(proposal, Math.floor(Date.now() / 1000), chain),
    chain,
    indexedError,
    mode: indexedError ? 'chain-fallback' : 'indexed+chain',
  };
}

// Wraps proposalLifecycle with the two checks moloch.mjs's process command runs
// before broadcasting that this repo's `process` case didn't: already-processed,
// and (when the caller supplies --proposal-data) that it matches what's indexed.
export async function preflightProcess(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
  proposal: number;
  proposalData?: Hex;
}): Promise<{
  ok: boolean;
  reason?: string;
  status: string;
  lifecycle: Record<string, unknown>;
  indexedProposalData?: `0x${string}`;
  processGasLimit?: string;
}> {
  const result = await proposalLifecycle({ config: input.config, service: input.service, dao: input.dao, proposal: input.proposal });
  const lifecycle = result.lifecycle as Record<string, unknown>;
  const status = String(lifecycle.status ?? 'unknown');
  const processGasLimit = typeof lifecycle.processGasLimit === 'string' ? lifecycle.processGasLimit : undefined;

  let indexedProposalData: `0x${string}` | undefined;
  try {
    const indexed = await input.service.proposal({ dao: input.dao, proposal: String(input.proposal) });
    indexedProposalData = extractProposal(indexed)?.proposalData;
  } catch {
    // Indexer unreachable — fall through with indexedProposalData left undefined;
    // the calldata-match check below is simply skipped in that case.
  }

  if (lifecycle.processed === true) {
    return { ok: false, reason: `Proposal ${input.proposal} is already processed.`, status, lifecycle, indexedProposalData, processGasLimit };
  }
  if (!lifecycle.processableNow) {
    return { ok: false, reason: `Proposal ${input.proposal} is not processable now: ${status}.`, status, lifecycle, indexedProposalData, processGasLimit };
  }
  if (input.proposalData && indexedProposalData && input.proposalData.toLowerCase() !== indexedProposalData.toLowerCase()) {
    return { ok: false, reason: `Proposal ${input.proposal} proposalData does not match indexed proposalData.`, status, lifecycle, indexedProposalData, processGasLimit };
  }
  return { ok: true, status, lifecycle, indexedProposalData, processGasLimit };
}

export async function processQueue(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
  first: number;
}): Promise<Record<string, unknown>> {
  let indexed: unknown;
  let indexedError: string | undefined;
  try {
    indexed = await input.service.proposals({ dao: input.dao, first: input.first, skip: 0 });
  } catch (error) {
    indexedError = compactError(error);
  }
  const proposals = extractProposals(indexed);
  if (!proposals.length && indexedError) {
    return {
      dao: input.dao,
      queue: [],
      indexedError,
      mode: 'chain-fallback-unavailable',
      note: 'Indexed proposal list failed. process-queue needs indexed proposalData to build process transactions.',
    };
  }
  const candidates = proposals
    .filter((proposal) => (
      proposal.proposalId != null &&
      Number(proposal.graceEnds || 0) < Math.floor(Date.now() / 1000) &&
      Boolean(proposal.proposalData) &&
      !Boolean(proposal.cancelled) &&
      !Boolean(proposal.processed)
    ));

  const checked = await Promise.all(candidates.map(async (proposal) => {
    try {
      const chain = await chainProposalContext(input.config, input.dao, proposal);
      return { proposal, lifecycle: deriveProposalLifecycle(proposal, Math.floor(Date.now() / 1000), chain), chain };
    } catch (error) {
      return {
        proposal,
        lifecycle: {
          status: 'chainPreflightError',
          processableNow: false,
          error: compactError(error),
        },
      };
    }
  }));

  const queue = checked
    .filter((item) => item.lifecycle.processableNow)
    .sort((a, b) => Number(a.proposal.proposalId) - Number(b.proposal.proposalId))
    .map((item, index) => ({ ...queueItem(item.proposal, item.lifecycle), queueIndex: index, processFirst: index === 0 }));

  return { dao: input.dao, queue, indexedError, mode: indexedError ? 'chain-fallback' : 'indexed+chain' };
}

export async function buildOldestReadyProcessTx(input: {
  config: Config;
  service: ServiceClient;
  chainId: number;
  dao: `0x${string}`;
  first: number;
}): Promise<BuiltTx> {
  const result = await processQueue(input);
  const queue = Array.isArray(result.queue) ? result.queue : [];
  const oldest = queue.find((item): item is { proposalId: string; proposalData: `0x${string}`; processGasLimit: string } => (
    typeof item === 'object' &&
    item !== null &&
    'processFirst' in item &&
    Boolean(item.processFirst) &&
    'proposalData' in item &&
    typeof item.proposalData === 'string'
  ));
  if (!oldest) throw new Error('No ready-to-process proposal found.');
  return buildProcessTx({
    chainId: input.chainId,
    dao: input.dao,
    proposal: Number(oldest.proposalId),
    proposalData: oldest.proposalData,
    gasLimit: BigInt(oldest.processGasLimit || DEFAULT_PROCESS_GAS_LIMIT),
  });
}

// Simulates the DAO's Safe running the multisend via its Baal module (the same
// path a passed proposal executes through) to estimate a safe submitProposal
// baalGas stipend. Ported from moloch.mjs's estimateBaalGas — this repo's CLI
// defaults baalGas to 0 (correctness-safe), this is an opt-in refinement.
export async function estimateBaalGas(input: {
  config: Config;
  service: ServiceClient;
  dao: `0x${string}`;
  proposalData: Hex;
  actionCount: number;
  bufferPercent?: number;
}): Promise<{ baalGas: string; rawEstimate: string; bufferPercent: number; safeAddress: `0x${string}` }> {
  const safeAddress = await safeAddressForDao(input.service, input.dao);
  const client = publicClient(input.config);
  const moduleData = encodeFunctionData({
    abi: GNOSIS_MODULE_ABI,
    functionName: 'execTransactionFromModule',
    args: [getNetwork(input.config.chainId).contracts.GNOSIS_MULTISEND, 0n, input.proposalData, 1],
  });
  const rawEstimate = await client.estimateGas({ account: input.dao, to: safeAddress, value: 0n, data: moduleData });
  const withActionBuffer = rawEstimate + BigInt(input.actionCount) * ACTION_GAS_LIMIT_ADDITION;
  const bufferPercent = input.bufferPercent ?? DEFAULT_BAAL_GAS_BUFFER_PERCENT;
  const buffered = (withActionBuffer * BigInt(bufferPercent) + 99n) / 100n;
  return { baalGas: buffered.toString(), rawEstimate: rawEstimate.toString(), bufferPercent, safeAddress };
}

// Exported so its output can be checked against the shared fixture in
// test/fixtures/proposal-lifecycle.fixture.json — the same fixture
// moloch-skills' moloch.mjs tests against — as a drift tripwire between the
// two independent implementations of this state machine.
export function deriveProposalLifecycle(proposal: IndexedProposal, now = Math.floor(Date.now() / 1000), chain: Record<string, unknown> = {}) {
  const sponsored = Boolean(proposal.sponsored);
  const chainStatus = isRecord(chain.namedStatus) ? chain.namedStatus : {};
  const hasChainStatus = Array.isArray(chainStatus.raw);
  const cancelled = hasChainStatus ? Boolean(chainStatus.cancelled) : Boolean(proposal.cancelled);
  const processed = hasChainStatus ? Boolean(chainStatus.processed) : Boolean(proposal.processed);
  const passed = hasChainStatus ? Boolean(chainStatus.passed) : Boolean(proposal.passed);
  const actionFailed = hasChainStatus ? Boolean(chainStatus.actionFailed) : Boolean(proposal.actionFailed);
  const votingStarts = Number(proposal.votingStarts || 0);
  const votingEnds = Number(proposal.votingEnds || 0);
  const graceEnds = Number(proposal.graceEnds || 0);
  const yes = BigInt(String(proposal.yesBalance || proposal.yesVotes || '0'));
  const no = BigInt(String(proposal.noBalance || proposal.noVotes || '0'));
  const quorum = hasQuorum(proposal);
  const afterGrace = sponsored && !cancelled && !processed && now > graceEnds;
  const needsSponsor = !sponsored && !cancelled;
  const inVoting = sponsored && !cancelled && !processed && votingStarts < now && votingEnds > now;
  const inGrace = sponsored && !cancelled && !processed && votingEnds < now && graceEnds > now;
  const graphReady = afterGrace && yes > no && quorum;
  const prevState = typeof chain.prevState === 'number' ? chain.prevState : undefined;
  const state = typeof chain.state === 'number' ? chain.state : undefined;
  const chainProposal = isRecord(chain.proposal) ? chain.proposal : {};
  const prevProposalId = String(chainProposal.prevProposalId || proposal.prevProposalId || '');
  const prevStateEligible = prevState == null ? undefined : PREV_PROCESS_ELIGIBLE.has(prevState);
  const stateReady = state == null ? undefined : state === 5;
  const stateDefeated = state == null ? undefined : state === 7;
  const failedQuorum = afterGrace && state == null && !quorum;
  const failedVote = afterGrace && (stateDefeated == null ? yes <= no : stateDefeated);
  const readyByChainOrGraph = stateReady == null ? graphReady : stateReady;
  const blockedByPreviousProposal = Boolean(readyByChainOrGraph && proposal.proposalData && prevStateEligible === false);
  const processableNow = Boolean(readyByChainOrGraph && proposal.proposalData && !blockedByPreviousProposal);

  let status = 'unknown';
  if (needsSponsor) status = 'unsponsored';
  if (cancelled) status = 'cancelled';
  else if (actionFailed) status = 'actionFailed';
  else if (processed && passed) status = 'processedPassed';
  else if (processed && !passed) status = 'processedFailed';
  else if (inVoting) status = 'voting';
  else if (inGrace) status = 'grace';
  else if (processableNow) status = 'needsProcessing';
  else if (blockedByPreviousProposal) status = 'blockedByPreviousProposal';
  else if (stateDefeated || failedQuorum || failedVote) status = 'failed';

  return {
    proposalId: String(proposal.proposalId ?? ''),
    status,
    needsSponsor,
    needsVote: inVoting,
    inVoting,
    inGrace,
    graphReady,
    chainReady: stateReady,
    processableNow,
    blockedByPreviousProposal,
    failedQuorum,
    failedVote,
    processed,
    passed,
    actionFailed,
    hasProposalData: Boolean(proposal.proposalData),
    chainState: state == null ? undefined : STATE_NAMES[state] || `unknown-${state}`,
    prevProposalId,
    prevState: prevState == null ? undefined : STATE_NAMES[prevState] || `unknown-${prevState}`,
    prevStateEligible,
    processGasLimit: typeof chain.processGasLimit === 'string' ? chain.processGasLimit : undefined,
  };
}

export function extractProposal(value: unknown): IndexedProposal | undefined {
  if (isRecord(value) && isRecord(value.proposal)) return value.proposal as IndexedProposal;
  return undefined;
}

function publicClient(config: Config) {
  const network = getNetwork(config.chainId);
  return createPublicClient({ chain: network.viemChain, transport: http(network.rpcUrl) });
}

async function safeAddressForDao(service: ServiceClient, dao: `0x${string}`): Promise<`0x${string}`> {
  const indexed = await service.dao({ dao });
  if (isRecord(indexed) && isRecord(indexed.dao) && typeof indexed.dao.safeAddress === 'string') {
    return getAddress(indexed.dao.safeAddress);
  }
  throw new Error('Could not resolve DAO Safe address from indexed DAO data. Pass --address 0xSAFE.');
}

function explorerBaseUrl(chainId: number): string {
  return getNetwork(chainId).explorerBaseUrl;
}

async function safeBalances(chainId: number, safeAddress: `0x${string}`): Promise<SafeBalance[]> {
  const response = await fetch(`${safeApiBaseUrl(chainId)}/api/v1/safes/${safeAddress}/balances/?trusted=false`);
  if (!response.ok) throw new Error(`Safe balances request failed: ${response.status}`);
  return await response.json() as SafeBalance[];
}

function safeApiBaseUrl(chainId: number): string {
  return getNetwork(chainId).safeApiBaseUrl;
}

async function chainProposalContext(config: Config, dao: `0x${string}`, proposal: IndexedProposal): Promise<Record<string, unknown>> {
  const client = publicClient(config);
  const id = Number(proposal.proposalId);
  const [rawStatus, state, raw] = await Promise.all([
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'getProposalStatus', args: [id] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'state', args: [id] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'proposals', args: [BigInt(id)] }),
  ]);
  const tuple = namedProposalTuple(raw);
  const prevId = Number(tuple.prevProposalId || proposal.prevProposalId || 0);
  const prevState = await client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'state', args: [prevId] });
  const baalGas = BigInt(tuple.baalGas || '0');
  return {
    namedStatus: namedProposalStatus(rawStatus),
    state: Number(state),
    prevState: Number(prevState),
    proposal: tuple,
    processGasLimit: (baalGas > 0n ? baalGas + PROCESS_PROPOSAL_GAS_LIMIT_ADDITION : DEFAULT_PROCESS_GAS_LIMIT).toString(),
  };
}

async function chainOnlyProposal(config: Config, dao: `0x${string}`, proposalId: number): Promise<IndexedProposal> {
  const client = publicClient(config);
  const [raw, rawStatus, state] = await Promise.all([
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'proposals', args: [BigInt(proposalId)] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'getProposalStatus', args: [proposalId] }),
    client.readContract({ address: dao, abi: BAAL_ABI, functionName: 'state', args: [proposalId] }),
  ]);
  const tuple = namedProposalTuple(raw);
  const status = namedProposalStatus(rawStatus);
  return {
    id: `${dao}-proposal-${proposalId}`,
    proposalId,
    prevProposalId: tuple.prevProposalId,
    sponsored: Number(tuple.votingStarts || '0') > 0,
    processed: Boolean(status.processed),
    cancelled: Boolean(status.cancelled),
    passed: Boolean(status.passed),
    actionFailed: Boolean(status.actionFailed),
    votingStarts: tuple.votingStarts,
    votingEnds: tuple.votingEnds,
    graceEnds: tuple.graceEnds,
    expiration: tuple.expiration,
    yesVotes: tuple.yesVotes,
    noVotes: tuple.noVotes,
    title: `Proposal ${proposalId}`,
    proposalType: 'UNKNOWN_CHAIN_ONLY',
    chainState: Number(state),
  };
}

function queueItem(proposal: IndexedProposal, lifecycle: Record<string, unknown>) {
  return {
    proposalId: String(proposal.proposalId),
    title: proposal.title,
    proposalType: proposal.proposalType,
    prevProposalId: proposal.prevProposalId,
    status: lifecycle.status,
    chainReady: lifecycle.chainReady,
    processableNow: lifecycle.processableNow,
    previousProposalProcessed: lifecycle.prevStateEligible,
    indexedPassed: Boolean(proposal.passed),
    indexedProcessed: Boolean(proposal.processed),
    indexedCancelled: Boolean(proposal.cancelled),
    proposalData: proposal.proposalData,
    processGasLimit: isRecord(lifecycle) && typeof lifecycle.processGasLimit === 'string' ? lifecycle.processGasLimit : undefined,
  };
}

function hasQuorum(proposal: IndexedProposal): boolean {
  const totalShares = BigInt(String(proposal.dao?.totalShares || '0'));
  const quorumPercent = BigInt(String(proposal.dao?.quorumPercent || '0'));
  const yes = BigInt(String(proposal.yesBalance || proposal.yesVotes || '0'));
  if (totalShares === 0n) return false;
  return yes * 100n >= quorumPercent * totalShares;
}

function namedProposalStatus(status: readonly boolean[]): Record<string, unknown> {
  const values = Array.from(status || []);
  return {
    cancelled: Boolean(values[0]),
    processed: Boolean(values[1]),
    passed: Boolean(values[2]),
    actionFailed: Boolean(values[3]),
    raw: values.map(Boolean),
  };
}

function namedProposalTuple(raw: readonly unknown[]): Record<string, string> {
  const names = ['id', 'prevProposalId', 'votingStarts', 'votingEnds', 'graceEnds', 'expiration', 'baalGas', 'yesVotes', 'noVotes', 'maxTotalSharesAndLootAtVote', 'maxTotalSharesAtSponsor', 'sponsor', 'proposalDataHash'];
  return Object.fromEntries(names.map((name, index) => [name, stringifyValue(raw[index])]));
}

function stringifyValue(value: unknown): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function extractProposals(value: unknown): IndexedProposal[] {
  if (isRecord(value) && Array.isArray(value.proposals)) return value.proposals as IndexedProposal[];
  return [];
}

function compactProposal(proposal: IndexedProposal) {
  return {
    id: proposal.id,
    proposalId: proposal.proposalId,
    title: proposal.title,
    proposalType: proposal.proposalType,
    sponsored: proposal.sponsored,
    processed: proposal.processed,
    cancelled: proposal.cancelled,
    passed: proposal.passed,
    votingStarts: proposal.votingStarts,
    votingEnds: proposal.votingEnds,
    graceEnds: proposal.graceEnds,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const schemaMessages = Array.from(raw.matchAll(/Type `[^`]+` has no field `[^`]+`/g)).map((match) => match[0]);
  if (schemaMessages.length) return Array.from(new Set(schemaMessages)).join('; ');
  const firstLine = raw.split('\n').find((line) => line.trim());
  return (firstLine || raw).slice(0, 500);
}

type IndexedProposal = Record<string, unknown> & {
  id?: string;
  proposalId?: string | number;
  title?: string;
  proposalType?: string;
  proposalData?: `0x${string}`;
  prevProposalId?: string | number;
  sponsored?: boolean;
  processed?: boolean;
  cancelled?: boolean;
  passed?: boolean;
  actionFailed?: boolean;
  votingStarts?: string | number;
  votingEnds?: string | number;
  graceEnds?: string | number;
  yesBalance?: string;
  noBalance?: string;
  yesVotes?: string;
  noVotes?: string;
  dao?: {
    totalShares?: string;
    quorumPercent?: string;
  };
};

type SafeBalance = {
  tokenAddress: `0x${string}` | null;
  token?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  } | null;
  balance: string;
};
