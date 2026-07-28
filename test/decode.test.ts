import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProposal, decodeProposalCalldata } from '../src/decode.js';
import { buildSignalTx } from '../src/tx.js';
import type { Config } from '../src/config.js';
import type { ServiceClient } from '../src/service.js';

const dao = '0x0000000000000000000000000000000000000001' as `0x${string}`;

const config: Config = {
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

test('decodeProposalCalldata auto-detects a full submitProposal envelope and decodes the inner Poster action', () => {
  const built = buildSignalTx({ chainId: 8453, dao, title: 'Signal', description: 'Body', link: 'ipfs://example' });

  const decoded = decodeProposalCalldata(built.tx.data);

  assert.equal(decoded.source, 'submitProposal');
  assert.equal(decoded.submitProposal?.expiration, 0);
  assert.deepEqual(decoded.submitProposal?.details, { title: 'Signal', description: 'Body', contentURI: 'ipfs://example', contentURIType: 'url', proposalType: 'SIGNAL' });
  assert.equal(decoded.actions.length, 1);
  const action = decoded.actions[0].decoded;
  assert.equal(action.contract, 'Poster');
  if (action.contract === 'Poster') {
    assert.deepEqual(action.content, { daoId: dao, table: 'signal', queryType: 'list', title: 'Signal', description: 'Body', link: 'ipfs://example' });
  }
});

test('decodeProposalCalldata auto-detects raw multisend calldata (what the indexer stores as proposalData)', () => {
  const built = buildSignalTx({ chainId: 8453, dao, title: 'Signal', description: 'Body' });
  const proposalData = built.summary.proposalData as `0x${string}`;

  const decoded = decodeProposalCalldata(proposalData);

  assert.equal(decoded.source, 'multiSend');
  assert.equal(decoded.submitProposal, undefined);
  assert.equal(decoded.actions.length, 1);
  assert.equal(decoded.actions[0].decoded.contract, 'Poster');
});

test('decodeProposal prefers explicit data over dao/proposal', async () => {
  const built = buildSignalTx({ chainId: 8453, dao, title: 'Signal', description: 'Body' });
  const service = stubServiceClient({
    proposal: async () => {
      throw new Error('should not be called when --data is given');
    },
  });

  const decoded = await decodeProposal({ config, service, data: built.tx.data });

  assert.equal(decoded.source, 'submitProposal');
});

test('decodeProposal fetches proposalData from the indexer when only dao/proposal are given', async () => {
  const built = buildSignalTx({ chainId: 8453, dao, title: 'Signal', description: 'Body' });
  const proposalData = built.summary.proposalData as `0x${string}`;
  const service = stubServiceClient({
    proposal: async (input) => {
      assert.equal(input.dao, dao);
      assert.equal(input.proposal, '7');
      return { proposal: { proposalId: '7', proposalData } };
    },
  });

  const decoded = await decodeProposal({ config, service, dao, proposal: 7 });

  assert.equal(decoded.source, 'multiSend');
  assert.equal(decoded.actions[0].decoded.contract, 'Poster');
});

test('decodeProposal requires either data or dao+proposal', async () => {
  await assert.rejects(
    () => decodeProposal({ config, service: stubServiceClient(), dao }),
    /Provide --data, or --dao and --proposal/,
  );
});

test('decodeProposal errors clearly when the indexer has no proposalData for that proposal', async () => {
  const service = stubServiceClient({ proposal: async () => ({ proposal: { proposalId: '7' } }) });

  await assert.rejects(
    () => decodeProposal({ config, service, dao, proposal: 7 }),
    /No indexed proposalData found for proposal 7/,
  );
});
