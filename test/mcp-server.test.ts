import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp-server.js';
import {
  BAAL_ETH_TOKEN,
  BASE_WETH,
  buildApproveTokenTx,
  buildCancelTx,
  buildCustomProposalTx,
  buildDaoMetaTx,
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
} from '../src/tx.js';
import type { Config } from '../src/config.js';
import type { ServiceClient } from '../src/service.js';

const dao = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const recipient = '0x0000000000000000000000000000000000000003';

const config: Config = {
  serviceUrl: 'https://example.test',
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
};

function stubServiceClient(overrides: Partial<ServiceClient> = {}): ServiceClient {
  return {
    health: async () => ({}),
    capabilities: async () => ({}),
    dao: async () => ({}),
    proposals: async () => ({ proposals: [] }),
    proposal: async () => ({}),
    members: async () => ({}),
    records: async () => ({}),
    pinJson: async () => ({}),
    ...overrides,
  };
}

async function connectedClient(service: ServiceClient = stubServiceClient(), serverConfig: Config = config) {
  const server = createServer(serverConfig, service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

test('createServer rejects a non-Base chainId', () => {
  assert.throws(
    () => createServer({ ...config, chainId: 1 }, stubServiceClient()),
    /Base mainnet \(chainId 8453\)/,
  );
});

test('lists all documented moloch tools', async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    'moloch_approve_token',
    'moloch_balances',
    'moloch_cancel',
    'moloch_custom_proposal',
    'moloch_dao_meta',
    'moloch_gov_settings',
    'moloch_memory_post',
    'moloch_mint_loot',
    'moloch_mint_shares',
    'moloch_payment',
    'moloch_process',
    'moloch_process_queue',
    'moloch_process_ready',
    'moloch_proposal_lifecycle',
    'moloch_ragequit',
    'moloch_read_dao',
    'moloch_read_proposal',
    'moloch_service_capabilities',
    'moloch_service_dao',
    'moloch_service_health',
    'moloch_service_members',
    'moloch_service_pin_json',
    'moloch_service_proposal',
    'moloch_service_proposals',
    'moloch_service_records',
    'moloch_signal',
    'moloch_sponsor',
    'moloch_summon',
    'moloch_token_settings',
    'moloch_treasury_tokens',
    'moloch_tribute',
    'moloch_unwrap_eth',
    'moloch_vote',
    'moloch_wrap_eth',
  ]);

  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description && tool.description.length > 0);
  }
});

test('moloch_summon matches buildSummonTx output for identical params', async () => {
  const { client } = await connectedClient();
  const params = {
    daoName: 'Example DAO',
    description: 'Test DAO',
    memberAddresses: [dao],
    memberShares: ['10000000000000000000000'],
    memberLoot: ['0'],
    tokenName: 'Example Shares',
    tokenSymbol: 'EXAMPLE',
    lootTokenName: 'Example Loot',
    lootTokenSymbol: 'EXAMPLELOOT',
    votingPeriodInSeconds: 14400,
    gracePeriodInSeconds: 14400,
    newOffering: '0',
    quorum: 30,
    sponsorThreshold: '1000000000000000000',
    minRetention: 66,
    communityMemoryURI: 'ipfs://memory',
    saltNonce: '1',
  };

  const result = await client.callTool({ name: 'moloch_summon', arguments: { params } });
  const expected = buildSummonTx({ chainId: 8453, params });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
  assert.equal((result.structuredContent as typeof expected).tx.to, '0x97Aaa5be8B38795245f1c38A883B44cccdfB3E11');
});

test('moloch_summon rejects invalid input before touching the builder', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_summon', arguments: { params: { daoName: 'Missing fields' } } });
  assert.equal(result.isError, true);
});

test('moloch_wrap_eth matches buildWrapEthTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_wrap_eth', arguments: { amountWei: '10000000000000000' } });
  const expected = buildWrapEthTx({ chainId: 8453, amount: 10000000000000000n, weth: BASE_WETH });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_unwrap_eth matches buildUnwrapEthTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_unwrap_eth', arguments: { amountWei: '5000000000000000' } });
  const expected = buildUnwrapEthTx({ chainId: 8453, amount: 5000000000000000n, weth: BASE_WETH });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_approve_token matches buildApproveTokenTx output and defaults spender to Tribute Minion', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_approve_token',
    arguments: { token: BASE_WETH, amountRaw: '10000000000000000' },
  });
  const expected = buildApproveTokenTx({ chainId: 8453, token: BASE_WETH, amount: 10000000000000000n });

  assert.deepEqual(result.structuredContent, expected);
  assert.equal((result.structuredContent as typeof expected).summary.spender, '0x00768B047f73D88b6e9c14bcA97221d6E179d468');
});

test('moloch_tribute matches buildTributeTx output for identical params', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_tribute',
    arguments: { dao, token, amountRaw: '10', sharesRaw: '10000000000000000000000', proposalOfferingRaw: '3' },
  });
  const expected = buildTributeTx({
    chainId: 8453,
    dao: dao as `0x${string}`,
    token,
    amount: 10n,
    shares: 10000000000000000000000n,
    proposalOffering: 3n,
  });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_tribute rejects native ETH tribute tokens the same way buildTributeTx does', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_tribute',
    arguments: { dao, token: '0x0000000000000000000000000000000000000000' },
  });

  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0].text, /nonzero ERC-20 token address/);
});

test('moloch_sponsor matches buildSponsorTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_sponsor', arguments: { dao, proposal: 12 } });
  const expected = buildSponsorTx({ chainId: 8453, dao: dao as `0x${string}`, proposal: 12 });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_vote matches buildVoteTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_vote', arguments: { dao, proposal: 12, approved: true } });
  const expected = buildVoteTx({ chainId: 8453, dao: dao as `0x${string}`, proposal: 12, approved: true });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_process matches buildProcessTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_process',
    arguments: { dao, proposal: 12, proposalData: '0x1234', gasLimitRaw: '800000' },
  });
  const expected = buildProcessTx({ chainId: 8453, dao: dao as `0x${string}`, proposal: 12, proposalData: '0x1234', gasLimit: 800000n });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_mint_shares matches buildMintSharesTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_mint_shares',
    arguments: { dao, recipients: [recipient], amountsRaw: ['1000000000000000000'] },
  });
  const expected = buildMintSharesTx({ chainId: 8453, dao: dao as `0x${string}`, recipients: [recipient as `0x${string}`], amounts: [1000000000000000000n] });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_mint_loot matches buildMintLootTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_mint_loot',
    arguments: { dao, recipients: [recipient], amountsRaw: ['100000000000000000000'] },
  });
  const expected = buildMintLootTx({ chainId: 8453, dao: dao as `0x${string}`, recipients: [recipient as `0x${string}`], amounts: [100000000000000000000n] });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_payment matches buildPaymentTx output for a native ETH payment', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_payment',
    arguments: { dao, recipient, amountRaw: '10000000000000000' },
  });
  const expected = buildPaymentTx({ chainId: 8453, dao: dao as `0x${string}`, recipient: recipient as `0x${string}`, amount: 10000000000000000n });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_payment matches buildPaymentTx output for an ERC-20 payment', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_payment',
    arguments: { dao, recipient, token, amountRaw: '1500000' },
  });
  const expected = buildPaymentTx({ chainId: 8453, dao: dao as `0x${string}`, recipient: recipient as `0x${string}`, token: token as `0x${string}`, amount: 1500000n });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_read_dao surfaces chain read errors as tool errors instead of throwing', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_read_dao', arguments: { dao: '0xnot-an-address' } });
  assert.equal(result.isError, true);
});

test('moloch_service_proposals calls the injected service client with the requested dao', async () => {
  let received: unknown;
  const service = stubServiceClient({
    proposals: async (input) => {
      received = input;
      return { proposals: [{ proposalId: '1' }] };
    },
  });
  const { client } = await connectedClient(service);
  const result = await client.callTool({ name: 'moloch_service_proposals', arguments: { dao, first: 5, skip: 2 } });

  assert.deepEqual(received, { dao, first: 5, skip: 2 });
  assert.deepEqual(result.structuredContent, { proposals: [{ proposalId: '1' }] });
});

test('moloch_treasury_tokens surfaces service errors as tool errors', async () => {
  const service = stubServiceClient({
    dao: async () => {
      throw new Error('indexer unavailable');
    },
  });
  const { client } = await connectedClient(service);
  const result = await client.callTool({ name: 'moloch_treasury_tokens', arguments: { dao } });

  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0].text, /indexer unavailable/);
});

test('moloch_cancel matches buildCancelTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_cancel', arguments: { dao, proposal: 12 } });
  const expected = buildCancelTx({ chainId: 8453, dao: dao as `0x${string}`, proposal: 12 });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_ragequit matches buildRagequitTx output and resolves the ETH sentinel alias', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_ragequit',
    arguments: { dao, to: dao, sharesToBurnRaw: '1000000000000000000', tokens: ['ETH'] },
  });
  const expected = buildRagequitTx({
    chainId: 8453,
    dao: dao as `0x${string}`,
    to: dao as `0x${string}`,
    sharesToBurn: 1000000000000000000n,
    lootToBurn: 0n,
    tokens: [BAAL_ETH_TOKEN],
  });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_ragequit rejects a non-ascending token list', async () => {
  const { client } = await connectedClient();
  const high = `0x${'9'.padStart(40, '0')}`;
  const low = `0x${'1'.padStart(40, '0')}`;
  const result = await client.callTool({
    name: 'moloch_ragequit',
    arguments: { dao, to: dao, tokens: [high, low] },
  });

  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0].text, /sorted ascending/);
});

test('moloch_memory_post matches buildMemoryPostTx output', async () => {
  // buildMemoryPostTx stamps a fresh `createdAt` timestamp on every call, so
  // the raw calldata isn't deterministic across two separate invocations
  // (the tool's and this test's) — assert the stable fields instead, same
  // approach as this repo's own "buildMemoryPostTx can encode vote reasons"
  // test in test/tx.test.ts.
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_memory_post',
    arguments: { dao, type: 'vote-reason', proposalId: '12', threadId: 'proposal-12-vote-reasons', body: 'I voted no because the ask needs clearer scope.', vote: 'no', workspaceURI: 'ipfs://workspace' },
  });
  const expected = buildMemoryPostTx({
    chainId: 8453,
    dao: dao as `0x${string}`,
    table: 'communityMemory',
    type: 'vote-reason',
    proposalId: '12',
    threadId: 'proposal-12-vote-reasons',
    body: 'I voted no because the ask needs clearer scope.',
    vote: 'no',
    workspaceURI: 'ipfs://workspace',
  });
  const content = result.structuredContent as typeof expected;

  assert.equal(content.tx.to, expected.tx.to);
  assert.equal(content.summary.recordTable, expected.summary.recordTable);
  assert.equal(content.summary.type, expected.summary.type);
  assert.equal(content.summary.threadId, expected.summary.threadId);
  assert.equal(content.summary.proposalId, expected.summary.proposalId);
});

test('moloch_signal matches buildSignalTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_signal',
    arguments: { dao, title: 'Signal', description: 'Body', link: 'ipfs://example' },
  });
  const expected = buildSignalTx({ chainId: 8453, dao: dao as `0x${string}`, title: 'Signal', description: 'Body', link: 'ipfs://example' });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_dao_meta matches buildDaoMetaTx output', async () => {
  // buildDaoMetaTx stamps a fresh `updatedAt` timestamp on every call (like
  // buildMemoryPostTx's `createdAt`), so the raw calldata isn't
  // deterministic across two separate invocations — assert the stable
  // fields instead.
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_dao_meta',
    arguments: { dao, communityMemoryURI: 'ipfs://memory' },
  });
  const expected = buildDaoMetaTx({ chainId: 8453, dao: dao as `0x${string}`, communityMemoryURI: 'ipfs://memory' });
  const content = result.structuredContent as typeof expected;

  assert.equal(content.tx.to, expected.tx.to);
  assert.equal(content.summary.proposalKind, expected.summary.proposalKind);
  assert.equal(content.summary.recordTable, expected.summary.recordTable);
});

test('moloch_gov_settings matches buildGovernanceSettingsTx output', async () => {
  const { client } = await connectedClient();
  const params = {
    votingPeriodInSeconds: 14400,
    gracePeriodInSeconds: 14400,
    newOffering: '0',
    quorum: 30,
    sponsorThreshold: '1000000000000000000',
    minRetention: 66,
  };
  const result = await client.callTool({ name: 'moloch_gov_settings', arguments: { dao, params } });
  const expected = buildGovernanceSettingsTx({ chainId: 8453, dao: dao as `0x${string}`, params });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_token_settings matches buildTokenSettingsTx output', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_token_settings',
    arguments: { dao, pauseShares: false, pauseLoot: true },
  });
  const expected = buildTokenSettingsTx({ chainId: 8453, dao: dao as `0x${string}`, pauseShares: false, pauseLoot: true });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_custom_proposal matches buildCustomProposalTx output (the gap this pass closes)', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({
    name: 'moloch_custom_proposal',
    arguments: { dao, title: 'Custom action', actions: [{ to: dao }] },
  });
  const expected = buildCustomProposalTx({
    chainId: 8453,
    dao: dao as `0x${string}`,
    title: 'Custom action',
    actions: [{ to: dao as `0x${string}` }],
  });

  assert.deepEqual(result.structuredContent, expected);
});

test('moloch_read_proposal surfaces a config error as a tool error instead of hitting the network', async () => {
  const { client } = await connectedClient(stubServiceClient(), { ...config, rpcUrl: undefined });
  const result = await client.callTool({ name: 'moloch_read_proposal', arguments: { dao, proposal: 1 } });

  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0].text, /RPC_URL is required/);
});

test('moloch_proposal_lifecycle surfaces a config error as a tool error instead of hitting the network', async () => {
  const { client } = await connectedClient(stubServiceClient(), { ...config, rpcUrl: undefined });
  const result = await client.callTool({ name: 'moloch_proposal_lifecycle', arguments: { dao, proposal: 1 } });

  assert.equal(result.isError, true);
});

test('moloch_process_queue returns an empty queue when the indexer has no candidate proposals (no network reads needed)', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_process_queue', arguments: { dao } });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as { dao: string; queue: unknown[] };
  assert.equal(content.dao, dao);
  assert.deepEqual(content.queue, []);
});

test('moloch_balances requires at least dao or address', async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: 'moloch_balances', arguments: {} });

  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0].text, /Provide --address, or provide --dao/);
});

test('moloch_service_dao calls the injected service client', async () => {
  let received: unknown;
  const service = stubServiceClient({
    dao: async (input) => {
      received = input;
      return { dao: { safeAddress: dao } };
    },
  });
  const { client } = await connectedClient(service);
  const result = await client.callTool({ name: 'moloch_service_dao', arguments: { dao } });

  assert.deepEqual(received, { dao });
  assert.deepEqual(result.structuredContent, { dao: { safeAddress: dao } });
});

test('moloch_service_proposal calls the injected service client with a stringified proposal id', async () => {
  let received: unknown;
  const service = stubServiceClient({
    proposal: async (input) => {
      received = input;
      return { proposalId: '12' };
    },
  });
  const { client } = await connectedClient(service);
  const result = await client.callTool({ name: 'moloch_service_proposal', arguments: { dao, proposal: 12 } });

  assert.deepEqual(received, { dao, proposal: '12' });
  assert.deepEqual(result.structuredContent, { proposalId: '12' });
});

test('moloch_service_members calls the injected service client', async () => {
  let received: unknown;
  const service = stubServiceClient({
    members: async (input) => {
      received = input;
      return { members: [] };
    },
  });
  const { client } = await connectedClient(service);
  await client.callTool({ name: 'moloch_service_members', arguments: { dao, first: 10, skip: 1 } });

  assert.deepEqual(received, { dao, first: 10, skip: 1 });
});

test('moloch_service_records calls the injected service client with default table', async () => {
  let received: unknown;
  const service = stubServiceClient({
    records: async (input) => {
      received = input;
      return { records: [] };
    },
  });
  const { client } = await connectedClient(service);
  await client.callTool({ name: 'moloch_service_records', arguments: { dao } });

  assert.deepEqual(received, { dao, table: 'communityMemory', first: 100, skip: 0 });
});

test('moloch_service_health and moloch_service_capabilities call the injected service client with no args', async () => {
  const service = stubServiceClient({
    health: async () => ({ ok: true }),
    capabilities: async () => ({ features: [] }),
  });
  const { client } = await connectedClient(service);

  const health = await client.callTool({ name: 'moloch_service_health', arguments: {} });
  const capabilities = await client.callTool({ name: 'moloch_service_capabilities', arguments: {} });

  assert.deepEqual(health.structuredContent, { ok: true });
  assert.deepEqual(capabilities.structuredContent, { features: [] });
});

test('moloch_service_pin_json calls the injected service client and is not build-only', async () => {
  let received: unknown;
  const service = stubServiceClient({
    pinJson: async (input) => {
      received = input;
      return { cid: 'bafy...', uri: 'ipfs://bafy...', gatewayUrl: 'https://gateway.test/ipfs/bafy...' };
    },
  });
  const { client } = await connectedClient(service);
  const result = await client.callTool({ name: 'moloch_service_pin_json', arguments: { name: 'test', data: { hello: 'world' } } });

  assert.deepEqual(received, { name: 'test', data: { hello: 'world' } });
  assert.deepEqual(result.structuredContent, { cid: 'bafy...', uri: 'ipfs://bafy...', gatewayUrl: 'https://gateway.test/ipfs/bafy...' });
});
