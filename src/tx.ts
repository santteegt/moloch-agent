import crypto from 'node:crypto';
import {
  encodeAbiParameters,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbiParameters,
  parseEther,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';
import { getNetwork } from './networks.js';

// Protocol-level sentinels, not per-chain deployments — kept as plain constants.
// Per-chain deployment addresses and Poster tags live in ./networks.js.
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const BAAL_ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const BAAL_TOKEN_DECIMALS = 18;

export const BAAL_ABI = [
  { type: 'function', name: 'submitProposal', stateMutability: 'payable', inputs: [{ name: 'proposalData', type: 'bytes' }, { name: 'expiration', type: 'uint32' }, { name: 'baalGas', type: 'uint256' }, { name: 'details', type: 'string' }], outputs: [] },
  { type: 'function', name: 'sponsorProposal', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint32' }], outputs: [] },
  { type: 'function', name: 'submitVote', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint32' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'processProposal', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint32' }, { name: 'proposalData', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'cancelProposal', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint32' }], outputs: [] },
  { type: 'function', name: 'mintShares', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address[]' }, { name: 'amount', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'mintLoot', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address[]' }, { name: 'amount', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'setGovernanceConfig', stateMutability: 'nonpayable', inputs: [{ name: '_governanceConfig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'setAdminConfig', stateMutability: 'nonpayable', inputs: [{ name: 'pauseShares', type: 'bool' }, { name: 'pauseLoot', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'ragequit', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'sharesToBurn', type: 'uint256' }, { name: 'lootToBurn', type: 'uint256' }, { name: 'tokens', type: 'address[]' }], outputs: [] },
  { type: 'function', name: 'setShamans', stateMutability: 'nonpayable', inputs: [{ name: '_shamans', type: 'address[]' }, { name: '_permissions', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'executeAsBaal', stateMutability: 'nonpayable', inputs: [{ name: '_to', type: 'address' }, { name: '_value', type: 'uint256' }, { name: '_data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'proposalCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'proposalOffering', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sponsorThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'latestSponsoredProposalId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'getProposalStatus', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint32' }], outputs: [{ type: 'bool[4]' }] },
  { type: 'function', name: 'state', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint32' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'proposals', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ name: 'id', type: 'uint32' }, { name: 'prevProposalId', type: 'uint32' }, { name: 'votingStarts', type: 'uint32' }, { name: 'votingEnds', type: 'uint32' }, { name: 'graceEnds', type: 'uint32' }, { name: 'expiration', type: 'uint32' }, { name: 'baalGas', type: 'uint256' }, { name: 'yesVotes', type: 'uint256' }, { name: 'noVotes', type: 'uint256' }, { name: 'maxTotalSharesAndLootAtVote', type: 'uint256' }, { name: 'maxTotalSharesAtSponsor', type: 'uint256' }, { name: 'sponsor', type: 'address' }, { name: 'proposalDataHash', type: 'bytes32' }] },
] as const;

export const POSTER_ABI = [
  { type: 'function', name: 'post', stateMutability: 'nonpayable', inputs: [{ name: 'content', type: 'string' }, { name: 'tag', type: 'string' }], outputs: [] },
] as const;

export const MULTISEND_ABI = [
  { type: 'function', name: 'multiSend', stateMutability: 'payable', inputs: [{ name: 'transactions', type: 'bytes' }], outputs: [] },
] as const;

export const GNOSIS_MODULE_ABI = [
  { type: 'function', name: 'execTransactionFromModule', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }], outputs: [{ type: 'bool' }] },
] as const;

const TRIBUTE_MINION_ABI = [
  { type: 'function', name: 'submitTributeProposal', stateMutability: 'payable', inputs: [{ name: 'baal', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'loot', type: 'uint256' }, { name: 'expiration', type: 'uint32' }, { name: 'baalgas', type: 'uint256' }, { name: 'details', type: 'string' }], outputs: [] },
] as const;

const ERC20_TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const ERC20_APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

const SUMMONER_ABI = [
  { type: 'function', name: 'summonBaalFromReferrer', stateMutability: 'nonpayable', inputs: [{ name: '_safeAddr', type: 'address' }, { name: '_forwarderAddr', type: 'address' }, { name: '_saltNonce', type: 'uint256' }, { name: 'initializationMintParams', type: 'bytes' }, { name: 'initializationTokenParams', type: 'bytes' }, { name: 'postInitializationActions', type: 'bytes[]' }], outputs: [] },
] as const;

export type UnsignedTx = {
  chainId: number;
  to: `0x${string}`;
  value: string;
  data: Hex;
  gas?: string;
};

export type BuiltTx = {
  summary: Record<string, unknown>;
  tx: UnsignedTx;
};

export type SendResult = BuiltTx & {
  sent: true;
  hash: Hex;
};

export type SummonParams = {
  daoName: string;
  description?: string;
  longDescription?: string;
  avatarImg?: string;
  bannerImg?: string;
  links?: unknown;
  goalsURI?: string;
  charterURI?: string;
  joinRulesURI?: string;
  rulesURI?: string;
  manifestoURI?: string;
  communityMemoryURI?: string;
  proposalWorkspaceURI?: string;
  sharedStateURI?: string;
  memberAddresses: `0x${string}`[];
  memberShares: Array<string | number | bigint>;
  memberLoot?: Array<string | number | bigint>;
  tokenName: string;
  tokenSymbol: string;
  lootTokenName: string;
  lootTokenSymbol: string;
  votingTransferable?: boolean;
  nvTransferable?: boolean;
  votingPeriodInSeconds: number;
  gracePeriodInSeconds: number;
  newOffering?: string | number | bigint;
  quorum: string | number | bigint;
  sponsorThreshold: string | number | bigint;
  minRetention: string | number | bigint;
  shamanAddresses?: `0x${string}`[];
  shamanPermissions?: Array<string | number | bigint>;
  safeAddress?: `0x${string}`;
  saltNonce?: string | number | bigint;
};

export function signerAccount(config: Config): Record<string, unknown> {
  if (!config.privateKey) {
    return {
      available: false,
      source: 'PRIVATE_KEY',
      note: 'PRIVATE_KEY is not set.',
    };
  }
  const account = privateKeyToAccount(config.privateKey);
  return {
    available: true,
    source: 'PRIVATE_KEY',
    address: account.address,
  };
}

export type GovernanceSettingsParams = {
  title?: string;
  description?: string;
  link?: string;
  votingPeriodInSeconds: number;
  gracePeriodInSeconds: number;
  newOffering: string | number | bigint;
  quorum: string | number | bigint;
  sponsorThreshold: string | number | bigint;
  minRetention: string | number | bigint;
  expiration?: number;
  baalGas?: string | number | bigint;
  value?: string | number | bigint;
};

export type CustomProposalAction = {
  to: `0x${string}`;
  value?: string | number | bigint;
  data?: Hex;
  operation?: number;
};

export function buildWrapEthTx(input: { chainId: number; amount: bigint; weth?: `0x${string}` }): BuiltTx {
  const weth = input.weth || getNetwork(input.chainId).contracts.WETH;
  const data = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' });
  return withSummary(tx(input.chainId, weth, data, input.amount), {
    action: 'wrap-eth',
    token: weth,
    amount: input.amount.toString(),
    note: 'Wraps native ETH into WETH. Use WETH as the ERC-20 token for Tribute Minion swaps.',
  });
}

export function buildUnwrapEthTx(input: { chainId: number; amount: bigint; weth?: `0x${string}` }): BuiltTx {
  const weth = input.weth || getNetwork(input.chainId).contracts.WETH;
  const data = encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [input.amount] });
  return withSummary(tx(input.chainId, weth, data), {
    action: 'unwrap-eth',
    token: weth,
    amount: input.amount.toString(),
    note: 'Unwraps WETH back to native ETH.',
  });
}

export function buildApproveTokenTx(input: { chainId: number; token: `0x${string}`; spender?: `0x${string}`; amount: bigint }): BuiltTx {
  const spender = input.spender || getNetwork(input.chainId).contracts.TRIBUTE_MINION;
  const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender, input.amount] });
  return withSummary(tx(input.chainId, input.token, data), {
    action: 'approve-token',
    token: input.token,
    spender,
    amount: input.amount.toString(),
    note: 'Approves ERC-20 spending. Tribute Minion needs allowance before token-for-shares/loot proposals can be submitted.',
  });
}

export function buildRagequitTx(input: {
  chainId: number;
  dao: `0x${string}`;
  to: `0x${string}`;
  sharesToBurn: bigint;
  lootToBurn: bigint;
  tokens: `0x${string}`[];
}): BuiltTx {
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'ragequit',
    args: [input.to, input.sharesToBurn, input.lootToBurn, input.tokens],
  });
  return withSummary(tx(input.chainId, input.dao, data), {
    action: 'ragequit',
    dao: input.dao,
    to: input.to,
    sharesToBurn: input.sharesToBurn.toString(),
    lootToBurn: input.lootToBurn.toString(),
    tokens: input.tokens,
    note: 'Direct member action. Burns caller shares/loot and claims proportional treasury assets. Token list must be sorted ascending for Baal.',
  });
}

export function buildVoteTx(input: { chainId: number; dao: `0x${string}`; proposal: number; approved: boolean }): BuiltTx {
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'submitVote',
    args: [input.proposal, input.approved],
  });
  return withSummary(tx(input.chainId, input.dao, data), {
    action: 'vote',
    dao: input.dao,
    proposalId: input.proposal,
    approved: input.approved,
  });
}

export function buildSponsorTx(input: { chainId: number; dao: `0x${string}`; proposal: number }): BuiltTx {
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'sponsorProposal',
    args: [input.proposal],
  });
  return withSummary(tx(input.chainId, input.dao, data), {
    action: 'sponsor',
    dao: input.dao,
    proposalId: input.proposal,
  });
}

export function buildCancelTx(input: { chainId: number; dao: `0x${string}`; proposal: number }): BuiltTx {
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'cancelProposal',
    args: [input.proposal],
  });
  return withSummary(tx(input.chainId, input.dao, data), {
    action: 'cancel',
    dao: input.dao,
    proposalId: input.proposal,
  });
}

export function buildProcessTx(input: { chainId: number; dao: `0x${string}`; proposal: number; proposalData: Hex; gasLimit?: bigint }): BuiltTx {
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'processProposal',
    args: [input.proposal, input.proposalData],
  });
  return withSummary(tx(input.chainId, input.dao, data, 0n, input.gasLimit), {
    action: 'process',
    dao: input.dao,
    proposalId: input.proposal,
    gasLimit: input.gasLimit?.toString(),
    note: 'Use exact indexed proposalData. Processing is mechanical settlement after governance is complete.',
  });
}

export function buildMemoryPostTx(input: {
  chainId: number;
  dao: `0x${string}`;
  table: string;
  type?: string;
  threadId?: string;
  topicId?: string;
  proposalId?: string;
  draftId?: string;
  title?: string;
  body?: string;
  vote?: string;
  contentURI?: string;
  contentHash?: string;
  workspaceURI?: string;
  stateURI?: string;
  agent?: string;
  version?: string;
  tag?: string;
}): BuiltTx {
  const content = compactObject({
    daoId: input.dao,
    table: input.table,
    queryType: 'list',
    schema: 'community-memory/v1',
    type: input.type || 'thread-post',
    title: input.title,
    body: input.body,
    vote: input.vote,
    threadId: input.threadId || input.topicId,
    topicId: input.topicId,
    proposalId: input.proposalId,
    draftId: input.draftId,
    contentURI: input.contentURI,
    contentHash: input.contentHash,
    workspaceURI: input.workspaceURI,
    stateURI: input.stateURI,
    agent: input.agent,
    version: input.version,
    createdAt: new Date().toISOString(),
  });
  const network = getNetwork(input.chainId);
  const tag = input.tag || network.tags.MEMBER_DB;
  const data = encodeFunctionData({
    abi: POSTER_ABI,
    functionName: 'post',
    args: [JSON.stringify(content), tag],
  });
  return withSummary(tx(input.chainId, network.contracts.POSTER, data), {
    action: 'memory-post',
    dao: input.dao,
    recordTable: input.table,
    tag,
    type: content.type,
    threadId: content.threadId,
    proposalId: content.proposalId,
    contentURI: content.contentURI,
    note: 'Sender must satisfy DAOhaus database tag permissions for the record to index.',
  });
}

export function buildSignalTx(input: {
  chainId: number;
  dao: `0x${string}`;
  title: string;
  description: string;
  link?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  const network = getNetwork(input.chainId);
  const postData = encodeFunctionData({
    abi: POSTER_ABI,
    functionName: 'post',
    args: [
      JSON.stringify({
        daoId: input.dao,
        table: 'signal',
        queryType: 'list',
        title: input.title,
        description: input.description,
        link: input.link || '',
      }),
      network.tags.DAO_DB,
    ],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: network.contracts.POSTER, value: 0n, data: postData, operation: 0 }],
    title: input.title,
    description: input.description,
    link: input.link,
    proposalType: 'SIGNAL',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: 'SIGNAL',
      dao: input.dao,
      title: input.title,
      contentURI: input.link || '',
    },
  });
}

export function buildDaoRecordTx(input: {
  chainId: number;
  dao: `0x${string}`;
  table?: string;
  tag?: string;
  title?: string;
  description?: string;
  link?: string;
  name?: string;
  daoDescription?: string;
  communityMemoryURI?: string;
  proposalWorkspaceURI?: string;
  sharedStateURI?: string;
  web?: string;
  content?: Record<string, unknown>;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  const network = getNetwork(input.chainId);
  const table = input.table || 'daoProfile';
  const content = compactObject({
    name: input.name,
    description: input.daoDescription,
    communityMemoryURI: input.communityMemoryURI,
    proposalWorkspaceURI: input.proposalWorkspaceURI,
    sharedStateURI: input.sharedStateURI,
    web: input.web,
    ...input.content,
    // Protected envelope fields — cannot be overridden by an arbitrary --content payload.
    daoId: input.dao,
    table,
    queryType: 'list',
    updatedAt: new Date().toISOString(),
  });
  const tag = input.tag || network.tags.DAO_PROFILE_UPDATE;
  const postData = encodeFunctionData({
    abi: POSTER_ABI,
    functionName: 'post',
    args: [JSON.stringify(content), tag],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: network.contracts.POSTER, value: 0n, data: postData, operation: 0 }],
    title: input.title || (table === 'daoProfile' ? 'Update DAO metadata' : `Update ${table} record`),
    description: input.description || '',
    link: input.link,
    proposalType: 'UPDATE_METADATA_SETTINGS',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: 'UPDATE_METADATA_SETTINGS',
      dao: input.dao,
      recordTable: table,
      tag,
      contentURI: input.link || '',
    },
  });
}

export function buildDaoMetaTx(input: {
  chainId: number;
  dao: `0x${string}`;
  title?: string;
  description?: string;
  link?: string;
  name?: string;
  daoDescription?: string;
  communityMemoryURI?: string;
  proposalWorkspaceURI?: string;
  sharedStateURI?: string;
  web?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  return buildDaoRecordTx({ ...input, table: 'daoProfile' });
}

export function buildTributeTx(input: {
  chainId: number;
  dao: `0x${string}`;
  title?: string;
  description?: string;
  link?: string;
  token?: string;
  amount?: bigint;
  shares?: bigint;
  loot?: bigint;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  const title = input.title || 'Tribute for DAO tokens';
  const description = input.description || '';
  const link = input.link || '';
  const token = normalizeToken(input.token || 'ETH');
  if (token === ZERO_ADDRESS || token.toLowerCase() === BAAL_ETH_TOKEN.toLowerCase()) {
    throw new Error('Tribute/swap proposals require a nonzero ERC-20 token address. Native ETH, Baal ETH sentinel, and 0x0000000000000000000000000000000000000000 tribute are not supported by the DAOhaus Tribute Minion.');
  }
  const amount = input.amount || 0n;
  const shares = input.shares || 0n;
  const loot = input.loot || 0n;
  const value = input.proposalOffering || 0n;
  const data = encodeFunctionData({
    abi: TRIBUTE_MINION_ABI,
    functionName: 'submitTributeProposal',
    args: [input.dao, token, amount, shares, loot, input.expiration || 0, input.baalGas || 0n, details({ title, description, link, proposalType: 'TOKENS_FOR_SHARES' })],
  });
  return withSummary(tx(input.chainId, getNetwork(input.chainId).contracts.TRIBUTE_MINION, data, value), {
    action: 'submitTributeProposal',
    dao: input.dao,
    proposalKind: 'TOKENS_FOR_SHARES',
    submissionTarget: 'TRIBUTE_MINION',
    token,
    amount: amount.toString(),
    shares: shares.toString(),
    loot: loot.toString(),
    proposalOffering: value.toString(),
    note: 'ERC-20 tribute. Transaction value is the DAO proposal offering only. Approve the Tribute Minion first if allowance is insufficient. Shares/loot use 18-decimal base units.',
  });
}

export function buildMintSharesTx(input: {
  chainId: number;
  dao: `0x${string}`;
  recipients: `0x${string}`[];
  amounts: bigint[];
  title?: string;
  description?: string;
  link?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  if (!input.recipients.length) throw new Error('Missing recipient address.');
  if (input.recipients.length !== input.amounts.length) throw new Error('Recipients and amounts must have the same length.');
  const action = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'mintShares',
    args: [input.recipients, input.amounts],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: input.dao, value: 0n, data: action, operation: 0 }],
    title: input.title || 'Mint voting shares',
    description: input.description || '',
    link: input.link,
    proposalType: 'MINT_SHARES',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: 'MINT_SHARES',
      dao: input.dao,
      recipients: input.recipients,
      amounts: input.amounts.map(String),
      note: '--amount uses human 18-decimal share units; use --amount-raw for exact base units.',
    },
  });
}

export function buildMintLootTx(input: {
  chainId: number;
  dao: `0x${string}`;
  recipients: `0x${string}`[];
  amounts: bigint[];
  title?: string;
  description?: string;
  link?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  if (!input.recipients.length) throw new Error('Missing recipient address.');
  if (input.recipients.length !== input.amounts.length) throw new Error('Recipients and amounts must have the same length.');
  const action = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'mintLoot',
    args: [input.recipients, input.amounts],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: input.dao, value: 0n, data: action, operation: 0 }],
    title: input.title || 'Mint non-voting loot',
    description: input.description || '',
    link: input.link,
    proposalType: 'ISSUE',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: 'ISSUE',
      dao: input.dao,
      tokenAction: 'mintLoot',
      recipients: input.recipients,
      amounts: input.amounts.map(String),
      note: '--amount uses human 18-decimal loot units; use --amount-raw for exact base units.',
    },
  });
}

export function buildPaymentTx(input: {
  chainId: number;
  dao: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  token?: `0x${string}`;
  title?: string;
  description?: string;
  link?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  const isErc20 = Boolean(input.token);
  const data = isErc20
    ? encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [input.recipient, input.amount] })
    : '0x';
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{
      to: input.token || input.recipient,
      value: isErc20 ? 0n : input.amount,
      data,
      operation: 0,
    }],
    title: input.title || (isErc20 ? 'Transfer ERC-20 tokens' : 'Transfer ETH'),
    description: input.description || '',
    link: input.link,
    proposalType: isErc20 ? 'TRANSFER_ERC20' : 'TRANSFER_NETWORK_TOKEN',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: isErc20 ? 'TRANSFER_ERC20' : 'TRANSFER_NETWORK_TOKEN',
      dao: input.dao,
      recipient: input.recipient,
      token: input.token || 'ETH',
      amount: input.amount.toString(),
      note: isErc20
        ? 'ERC-20 treasury payment proposal. Amount is raw token units unless parsed with --decimals.'
        : 'Native ETH treasury payment proposal. --amount is a human ETH decimal.',
    },
  });
}

export function buildGovernanceSettingsTx(input: {
  chainId: number;
  dao: `0x${string}`;
  params: GovernanceSettingsParams;
  link?: string;
}): BuiltTx {
  const params = input.params;
  const inner = encodeValues(
    ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      params.votingPeriodInSeconds,
      params.gracePeriodInSeconds,
      BigInt(params.newOffering),
      rawPercent('quorum', params.quorum),
      BigInt(params.sponsorThreshold),
      rawPercent('minRetention', params.minRetention),
    ],
  );
  const action = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'setGovernanceConfig',
    args: [inner],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: input.dao, value: 0n, data: action, operation: 0 }],
    title: params.title || 'Update governance settings',
    description: params.description || '',
    link: input.link || params.link,
    proposalType: 'UPDATE_GOV_SETTINGS',
    expiration: params.expiration,
    baalGas: params.baalGas == null ? undefined : BigInt(params.baalGas),
    value: params.value == null ? undefined : BigInt(params.value),
    summary: {
      action: 'submitProposal',
      proposalKind: 'UPDATE_GOV_SETTINGS',
      dao: input.dao,
      votingPeriodInSeconds: params.votingPeriodInSeconds,
      gracePeriodInSeconds: params.gracePeriodInSeconds,
      newOffering: String(params.newOffering),
      quorum: rawPercent('quorum', params.quorum).toString(),
      sponsorThreshold: String(params.sponsorThreshold),
      minRetention: rawPercent('minRetention', params.minRetention).toString(),
    },
  });
}

export function buildTokenSettingsTx(input: {
  chainId: number;
  dao: `0x${string}`;
  pauseShares: boolean;
  pauseLoot: boolean;
  title?: string;
  description?: string;
  link?: string;
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  const action = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'setAdminConfig',
    args: [input.pauseShares, input.pauseLoot],
  });
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions: [{ to: input.dao, value: 0n, data: action, operation: 0 }],
    title: input.title || 'Update token settings',
    description: input.description || '',
    link: input.link,
    proposalType: 'TOKEN_SETTINGS',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: 'TOKEN_SETTINGS',
      dao: input.dao,
      pauseShares: input.pauseShares,
      pauseLoot: input.pauseLoot,
    },
  });
}

export function buildCustomProposalTx(input: {
  chainId: number;
  dao: `0x${string}`;
  title: string;
  description?: string;
  link?: string;
  proposalType?: string;
  actions: CustomProposalAction[];
  expiration?: number;
  baalGas?: bigint;
  proposalOffering?: bigint;
}): BuiltTx {
  if (!input.actions.length) throw new Error('Custom proposal requires at least one action.');
  const actions = input.actions.map((action) => ({
    to: asAddress(action.to),
    value: BigInt(action.value || 0),
    data: action.data || '0x',
    operation: Number(action.operation || 0),
  }));
  return buildProposalTx({
    chainId: input.chainId,
    dao: input.dao,
    actions,
    title: input.title,
    description: input.description || '',
    link: input.link,
    proposalType: input.proposalType || 'CUSTOM',
    expiration: input.expiration,
    baalGas: input.baalGas,
    value: input.proposalOffering,
    summary: {
      action: 'submitProposal',
      proposalKind: input.proposalType || 'CUSTOM',
      dao: input.dao,
      actionCount: actions.length,
      targets: actions.map((action) => action.to),
      note: 'Generic Baal proposal from supplied action JSON. Use --full to inspect calldata.',
    },
  });
}

export function buildSummonTx(input: {
  chainId: number;
  params: SummonParams;
}): BuiltTx {
  const params = normalizeSummonParams(input.params);
  const mint = encodeValues(
    ['address[]', 'uint256[]', 'uint256[]'],
    [params.memberAddresses, params.memberShares, params.memberLoot],
  );
  const tokens = encodeValues(
    ['string', 'string', 'string', 'string', 'bool', 'bool'],
    [
      params.tokenName,
      params.tokenSymbol,
      params.lootTokenName,
      params.lootTokenSymbol,
      Boolean(params.votingTransferable),
      Boolean(params.nvTransferable),
    ],
  );
  const gov = encodeValues(
    ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      params.votingPeriodInSeconds,
      params.gracePeriodInSeconds,
      params.newOffering,
      rawPercent('quorum', params.quorum),
      params.sponsorThreshold,
      rawPercent('minRetention', params.minRetention),
    ],
  );
  const govTx = encodeFunctionData({ abi: BAAL_ABI, functionName: 'setGovernanceConfig', args: [gov] });
  const shamanTx = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'setShamans',
    args: [params.shamanAddresses, params.shamanPermissions],
  });
  const network = getNetwork(input.chainId);
  const metadataPost = encodeFunctionData({
    abi: POSTER_ABI,
    functionName: 'post',
    args: [JSON.stringify(summonProfile(params)), network.tags.SUMMONER],
  });
  const metadataTx = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'executeAsBaal',
    args: [network.contracts.POSTER, 0n, metadataPost],
  });
  const saltNonce = params.saltNonce || BigInt(`0x${crypto.randomBytes(16).toString('hex')}`);
  const data = encodeFunctionData({
    abi: SUMMONER_ABI,
    functionName: 'summonBaalFromReferrer',
    args: [params.safeAddress || ZERO_ADDRESS, ZERO_ADDRESS, saltNonce, mint, tokens, [govTx, shamanTx, metadataTx]],
  });
  return withSummary(tx(input.chainId, network.contracts.SUMMONER, data), {
    action: 'summonBaalFromReferrer',
    proposalKind: 'SUMMON',
    submissionTarget: 'V3_FACTORY_ADV_TOKEN',
    daoName: params.daoName,
    tokenSymbol: params.tokenSymbol,
    lootTokenSymbol: params.lootTokenSymbol,
    members: params.memberAddresses.length,
    votingPeriodInSeconds: params.votingPeriodInSeconds,
    gracePeriodInSeconds: params.gracePeriodInSeconds,
    quorum: params.quorum.toString(),
    sponsorThreshold: params.sponsorThreshold.toString(),
    minRetention: params.minRetention.toString(),
    saltNonce: saltNonce.toString(),
    metadataIncluded: true,
    communityMemoryURI: params.communityMemoryURI,
    proposalWorkspaceURI: params.proposalWorkspaceURI,
    sharedStateURI: params.sharedStateURI,
  });
}

export function parseBaalTokenUnits(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Token amount must be a non-negative decimal number.');
  return parseUnits(normalized, BAAL_TOKEN_DECIMALS);
}

export function parseBigint(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Expected a non-negative integer.');
  return BigInt(value);
}

export function parseNativeTokenAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Native token amount must be a non-negative decimal number.');
  return parseEther(normalized);
}

export function parseTokenUnits(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Token amount must be a non-negative decimal number.');
  return parseUnits(normalized, decimals);
}

export function normalizeToken(value: string): `0x${string}` {
  if (!value || value.toUpperCase() === 'ETH' || value.toUpperCase() === 'NATIVE') return ZERO_ADDRESS;
  if (value.toLowerCase() === BAAL_ETH_TOKEN.toLowerCase()) return BAAL_ETH_TOKEN;
  return asAddress(value);
}

function buildProposalTx(input: {
  chainId: number;
  dao: `0x${string}`;
  actions: Action[];
  title: string;
  description: string;
  link?: string;
  proposalType: string;
  expiration?: number;
  baalGas?: bigint;
  value?: bigint;
  summary: Record<string, unknown>;
}): BuiltTx {
  const proposalData = encodeMultiAction(input.actions);
  const resolvedBaalGas = input.baalGas || 0n;
  const data = encodeFunctionData({
    abi: BAAL_ABI,
    functionName: 'submitProposal',
    args: [
      proposalData,
      input.expiration || 0,
      resolvedBaalGas,
      details({
        title: input.title,
        description: input.description,
        link: input.link || '',
        proposalType: input.proposalType,
      }),
    ],
  });
  return withSummary(tx(input.chainId, input.dao, data, input.value || 0n), {
    submissionTarget: 'BAAL',
    baalGas: resolvedBaalGas.toString(),
    ...input.summary,
    proposalData,
  });
}

type Action = {
  operation: number;
  to: `0x${string}`;
  value: bigint;
  data: Hex;
};

function encodeMultiAction(actions: Action[]): Hex {
  return encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: 'multiSend',
    args: [encodeMultiSend(actions)],
  });
}

function encodeMultiSend(actions: Action[]): Hex {
  const packed = actions.map((action) => {
    const op = Number(action.operation || 0).toString(16).padStart(2, '0');
    const to = action.to.toLowerCase().replace(/^0x/, '').padStart(40, '0');
    const value = BigInt(action.value || 0n).toString(16).padStart(64, '0');
    const data = (action.data || '0x').replace(/^0x/, '');
    const len = (data.length / 2).toString(16).padStart(64, '0');
    return `${op}${to}${value}${len}${data}`;
  }).join('');
  return `0x${packed}`;
}

function details(input: { title: string; description: string; link: string; proposalType: string }): string {
  return JSON.stringify({
    title: input.title,
    description: input.description,
    contentURI: input.link,
    contentURIType: input.link ? 'url' : '',
    proposalType: input.proposalType,
  });
}

function encodeValues(types: string[], values: unknown[]): Hex {
  return encodeAbiParameters(parseAbiParameters(types.join(',')), values);
}

function rawPercent(name: string, value: string | number | bigint): bigint {
  const normalized = String(value).trim().replace(/%$/, '');
  if (normalized.includes('.')) throw new Error(`${name} must be a whole-number percent from 0 to 100.`);
  const percent = BigInt(normalized);
  if (percent < 0n || percent > 100n) throw new Error(`${name} must be a whole-number percent from 0 to 100.`);
  return percent;
}

function normalizeSummonParams(params: SummonParams): Required<Pick<SummonParams,
  'daoName' |
  'memberAddresses' |
  'tokenName' |
  'tokenSymbol' |
  'lootTokenName' |
  'lootTokenSymbol' |
  'votingPeriodInSeconds' |
  'gracePeriodInSeconds'
>> & Omit<SummonParams, 'memberShares' | 'memberLoot' | 'newOffering' | 'sponsorThreshold' | 'shamanAddresses' | 'shamanPermissions' | 'saltNonce'> & {
  memberShares: bigint[];
  memberLoot: bigint[];
  newOffering: bigint;
  sponsorThreshold: bigint;
  shamanAddresses: `0x${string}`[];
  shamanPermissions: bigint[];
  saltNonce?: bigint;
} {
  if (!params.daoName) throw new Error('Summon params require daoName.');
  if (!params.memberAddresses?.length) throw new Error('Summon params require memberAddresses.');
  if (!params.memberShares?.length) throw new Error('Summon params require memberShares.');
  if (params.memberAddresses.length !== params.memberShares.length) throw new Error('memberAddresses and memberShares must have the same length.');
  const memberLoot = params.memberLoot || params.memberAddresses.map(() => 0);
  if (memberLoot.length !== params.memberAddresses.length) throw new Error('memberLoot must match memberAddresses length.');
  if (!params.tokenName || !params.tokenSymbol || !params.lootTokenName || !params.lootTokenSymbol) {
    throw new Error('Summon params require tokenName, tokenSymbol, lootTokenName, and lootTokenSymbol.');
  }
  return {
    ...params,
    memberAddresses: params.memberAddresses.map(asAddress),
    memberShares: params.memberShares.map(toBigint),
    memberLoot: memberLoot.map(toBigint),
    newOffering: toBigint(params.newOffering || 0),
    sponsorThreshold: toBigint(params.sponsorThreshold),
    shamanAddresses: (params.shamanAddresses || []).map(asAddress),
    shamanPermissions: (params.shamanPermissions || []).map(toBigint),
    safeAddress: params.safeAddress ? asAddress(params.safeAddress) : undefined,
    saltNonce: params.saltNonce == null ? undefined : toBigint(params.saltNonce),
  };
}

function summonProfile(params: SummonParams): Record<string, unknown> {
  return compactObject({
    name: params.daoName,
    description: params.description,
    longDescription: params.longDescription,
    avatarImg: params.avatarImg,
    bannerImg: params.bannerImg,
    links: params.links,
    goalsURI: params.goalsURI,
    charterURI: params.charterURI,
    joinRulesURI: params.joinRulesURI,
    rulesURI: params.rulesURI,
    manifestoURI: params.manifestoURI,
    communityMemoryURI: params.communityMemoryURI,
    proposalWorkspaceURI: params.proposalWorkspaceURI,
    sharedStateURI: params.sharedStateURI,
  });
}

function toBigint(value: string | number | bigint | undefined): bigint {
  if (value == null) throw new Error('Expected integer value.');
  return BigInt(value);
}

export type SendOptions = {
  wait?: boolean;
  confirmations?: number;
};

export async function maybeSend(config: Config, built: BuiltTx, send: boolean, options: SendOptions = {}): Promise<BuiltTx | SendResult> {
  if (!send) return built;
  if (!config.privateKey) throw new Error('PRIVATE_KEY is required for --send.');
  const network = getNetwork(config.chainId);

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: network.viemChain, transport: http(network.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: network.viemChain, transport: http(network.rpcUrl) });
  const request = await publicClient.prepareTransactionRequest({
    account,
    to: built.tx.to,
    value: BigInt(built.tx.value),
    data: built.tx.data,
    gas: built.tx.gas ? BigInt(built.tx.gas) : undefined,
    nonce: await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  });
  const hash = await walletClient.sendTransaction(request);
  const result: SendResult & { receipt?: unknown } = { ...built, sent: true, hash };
  if (options.wait ?? process.env.MOLOCH_WAIT_DEFAULT !== 'false') {
    result.receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: options.confirmations });
  }
  return result;
}

export function asAddress(value: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return value.toLowerCase() as `0x${string}`;
}

export function asHex(value: string): Hex {
  if (!/^0x[a-fA-F0-9]*$/.test(value)) throw new Error('Expected hex data.');
  return value as Hex;
}

export function asProposalId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('Proposal id must be a non-negative integer.');
  return parsed;
}

function tx(chainId: number, to: `0x${string}`, data: Hex, value = 0n, gas?: bigint): UnsignedTx {
  return { chainId, to, value: value.toString(), data, gas: gas?.toString() };
}

function withSummary(txObject: UnsignedTx, summary: Record<string, unknown>): BuiltTx {
  return {
    summary: {
      chainId: txObject.chainId,
      to: txObject.to,
      value: txObject.value,
      ...summary,
    },
    tx: txObject,
  };
}

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
