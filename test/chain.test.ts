import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBaalGas, preflightProcess, readDaoHistory, resolveProposalOffering } from '../src/chain.js';
import type { Config } from '../src/config.js';
import type { ServiceClient } from '../src/service.js';

const dao = '0x0000000000000000000000000000000000000001' as `0x${string}`;

const config: Config = {
  serviceUrl: 'https://example.test',
  chainId: 8453,
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

test('resolveProposalOffering returns the explicit value without any chain read', async () => {
  const offering = await resolveProposalOffering({ ...config, rpcUrl: undefined }, dao, 42n);

  assert.equal(offering, 42n);
});

test('preflightProcess rejects a proposal still in voting', async () => {
  const now = Math.floor(Date.now() / 1000);
  const service = stubServiceClient({
    proposal: async () => ({
      proposal: {
        proposalId: '2',
        sponsored: true,
        cancelled: false,
        processed: false,
        passed: false,
        actionFailed: false,
        votingStarts: now - 100,
        votingEnds: now + 1000,
        graceEnds: now + 2000,
        yesBalance: '10',
        noBalance: '0',
        proposalData: '0x',
        dao: { totalShares: '100', quorumPercent: '20' },
      },
    }),
  });

  const result = await preflightProcess({ config: { ...config, rpcUrl: undefined }, service, dao, proposal: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'voting');
  assert.match(result.reason ?? '', /not processable now: voting/);
});

test('preflightProcess allows a proposal past grace with quorum and no RPC configured (graph-derived readiness)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const service = stubServiceClient({
    proposal: async () => ({
      proposal: {
        proposalId: '4',
        prevProposalId: '3',
        sponsored: true,
        cancelled: false,
        processed: false,
        passed: false,
        actionFailed: false,
        votingStarts: now - 1000,
        votingEnds: now - 500,
        graceEnds: now - 100,
        yesBalance: '30',
        noBalance: '0',
        proposalData: '0x1234',
        dao: { totalShares: '100', quorumPercent: '20' },
      },
    }),
  });

  const result = await preflightProcess({ config: { ...config, rpcUrl: undefined }, service, dao, proposal: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'needsProcessing');
  assert.equal(result.indexedProposalData, '0x1234');
});

test('preflightProcess rejects an already-processed proposal even if it otherwise reads as ready', async () => {
  const now = Math.floor(Date.now() / 1000);
  const service = stubServiceClient({
    proposal: async () => ({
      proposal: {
        proposalId: '6',
        sponsored: true,
        cancelled: false,
        processed: true,
        passed: true,
        actionFailed: false,
        votingStarts: now - 1000,
        votingEnds: now - 500,
        graceEnds: now - 100,
        yesBalance: '30',
        noBalance: '0',
        proposalData: '0x1234',
        dao: { totalShares: '100', quorumPercent: '20' },
      },
    }),
  });

  const result = await preflightProcess({ config: { ...config, rpcUrl: undefined }, service, dao, proposal: 6 });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /already processed/);
});

test('preflightProcess rejects when the supplied proposalData does not match the indexer', async () => {
  const now = Math.floor(Date.now() / 1000);
  const service = stubServiceClient({
    proposal: async () => ({
      proposal: {
        proposalId: '4',
        sponsored: true,
        cancelled: false,
        processed: false,
        passed: false,
        actionFailed: false,
        votingStarts: now - 1000,
        votingEnds: now - 500,
        graceEnds: now - 100,
        yesBalance: '30',
        noBalance: '0',
        proposalData: '0x1234',
        dao: { totalShares: '100', quorumPercent: '20' },
      },
    }),
  });

  const result = await preflightProcess({ config: { ...config, rpcUrl: undefined }, service, dao, proposal: 4, proposalData: '0xdeadbeef' });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /does not match indexed proposalData/);
});

test('readDaoHistory composes service.dao and service.proposals in one call', async () => {
  const calls: string[] = [];
  const service = stubServiceClient({
    dao: async (input) => {
      calls.push('dao');
      assert.equal(input.dao, dao);
      return { dao: { id: dao, name: 'Example DAO', safeAddress: dao } };
    },
    proposals: async (input) => {
      calls.push('proposals');
      assert.equal(input.first, 50);
      assert.equal(input.skip, 10);
      return { proposals: [{ proposalId: '1' }, { proposalId: '2' }] };
    },
  });

  const result = await readDaoHistory({ config, service, dao, first: 50, skip: 10 });

  assert.deepEqual(calls.sort(), ['dao', 'proposals']);
  assert.equal((result.dao as { name: string }).name, 'Example DAO');
  assert.equal((result.proposals as unknown[]).length, 2);
});

test('estimateBaalGas surfaces the Safe-address resolution error before touching RPC', async () => {
  const service = stubServiceClient({ dao: async () => ({}) });

  await assert.rejects(
    () => estimateBaalGas({ config: { ...config, rpcUrl: undefined }, service, dao, proposalData: '0x1234', actionCount: 1 }),
    /Could not resolve DAO Safe address/,
  );
});
