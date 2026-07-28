import test from 'node:test';
import assert from 'node:assert/strict';
import { BAAL_ETH_TOKEN, buildApproveTokenTx, buildCancelTx, buildCustomProposalTx, buildDaoMetaTx, buildDaoRecordTx, buildGovernanceSettingsTx, buildMemoryPostTx, buildMintLootTx, buildMintSharesTx, buildPaymentTx, buildRagequitTx, buildSignalTx, buildSponsorTx, buildSummonTx, buildTokenSettingsTx, buildTributeTx, buildUnwrapEthTx, buildVoteTx, buildWrapEthTx, parseBaalTokenUnits, parseNativeTokenAmount, parseTokenUnits, signerAccount } from '../src/tx.js';
import { getNetwork } from '../src/networks.js';

const BASE_WETH = getNetwork(8453).contracts.WETH;

const dao = '0x0000000000000000000000000000000000000001';

test('signerAccount derives exact account address from private key', () => {
  const account = signerAccount({
    chainId: 8453,
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  });

  assert.equal(account.available, true);
  assert.equal(account.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
});

test('buildVoteTx creates vote transaction summary', () => {
  const built = buildVoteTx({ chainId: 8453, dao, proposal: 12, approved: true });

  assert.equal(built.tx.to, dao);
  assert.equal(built.tx.value, '0');
  assert.match(built.tx.data, /^0x/);
  assert.equal(built.summary.action, 'vote');
  assert.equal(built.summary.proposalId, 12);
});

test('buildSponsorTx creates sponsor transaction summary', () => {
  const built = buildSponsorTx({ chainId: 8453, dao, proposal: 12 });

  assert.equal(built.tx.to, dao);
  assert.match(built.tx.data, /^0x/);
  assert.equal(built.summary.action, 'sponsor');
});

test('buildCancelTx creates cancel transaction summary', () => {
  const built = buildCancelTx({ chainId: 8453, dao, proposal: 12 });

  assert.equal(built.tx.to, dao);
  assert.match(built.tx.data, /^0x/);
  assert.equal(built.summary.action, 'cancel');
  assert.equal(built.summary.proposalId, 12);
});

test('buildMemoryPostTx uses community memory defaults', () => {
  const built = buildMemoryPostTx({
    chainId: 8453,
    dao,
    table: 'communityMemory',
    threadId: 'proposal-12',
    body: 'Vote reason.',
  });

  assert.equal(built.tx.to, '0x000000000000cd17345801aa8147b8D3950260FF');
  assert.equal(built.summary.recordTable, 'communityMemory');
  assert.equal(built.summary.threadId, 'proposal-12');
});

test('buildMemoryPostTx can encode vote reasons', () => {
  const built = buildMemoryPostTx({
    chainId: 8453,
    dao,
    table: 'communityMemory',
    type: 'vote-reason',
    proposalId: '12',
    threadId: 'proposal-12-vote-reasons',
    body: 'I voted no because the ask needs clearer scope.',
    vote: 'no',
    workspaceURI: 'ipfs://workspace',
  });

  assert.equal(built.summary.recordTable, 'communityMemory');
  assert.equal(built.summary.type, 'vote-reason');
  assert.equal(built.summary.proposalId, '12');
});

test('buildSignalTx creates submitProposal transaction', () => {
  const built = buildSignalTx({
    chainId: 8453,
    dao,
    title: 'Signal',
    description: 'Body',
    link: 'ipfs://example',
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'SIGNAL');
  assert.equal(built.summary.submissionTarget, 'BAAL');
  assert.equal(built.summary.contentURI, 'ipfs://example');
  assert.match(String(built.summary.proposalData), /^0x8d80ff0a/);
});

test('buildDaoMetaTx creates metadata proposal', () => {
  const built = buildDaoMetaTx({
    chainId: 8453,
    dao,
    communityMemoryURI: 'ipfs://memory',
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'UPDATE_METADATA_SETTINGS');
  assert.equal(built.summary.recordTable, 'daoProfile');
});

test('buildDaoRecordTx posts to an arbitrary table with a default title and tag', () => {
  const built = buildDaoRecordTx({
    chainId: 8453,
    dao,
    table: 'charter',
    content: { body: 'We govern by rough consensus.' },
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'UPDATE_METADATA_SETTINGS');
  assert.equal(built.summary.recordTable, 'charter');
});

test('buildDaoRecordTx honors an explicit tag and title, and defaults the table to daoProfile', () => {
  const daoMeta = buildDaoMetaTx({ chainId: 8453, dao, communityMemoryURI: 'ipfs://memory' });
  const record = buildDaoRecordTx({
    chainId: 8453,
    dao,
    communityMemoryURI: 'ipfs://memory',
    tag: 'custom.tag',
    title: 'Custom title',
  });

  // Same table/target as the daoProfile wrapper, but the explicit tag/title win.
  assert.equal(record.summary.recordTable, daoMeta.summary.recordTable);
  assert.equal(record.tx.to, daoMeta.tx.to);
  assert.equal(record.summary.tag, 'custom.tag');
});

test('buildTributeTx creates ERC-20 tribute transaction with separate proposal offering', () => {
  const built = buildTributeTx({
    chainId: 8453,
    dao,
    token: '0x0000000000000000000000000000000000000002',
    amount: 10n,
    shares: parseBaalTokenUnits('10000'),
    proposalOffering: 3n,
  });

  assert.equal(built.tx.to, '0x00768B047f73D88b6e9c14bcA97221d6E179d468');
  assert.equal(built.tx.value, '3');
  assert.equal(built.summary.proposalKind, 'TOKENS_FOR_SHARES');
  assert.equal(built.summary.amount, '10');
  assert.equal(built.summary.proposalOffering, '3');
});

test('buildTributeTx rejects native ETH tribute', () => {
  assert.throws(() => buildTributeTx({
    chainId: 8453,
    dao,
    token: 'ETH',
    amount: 10n,
  }), /Native ETH, Baal ETH sentinel, and 0x0000000000000000000000000000000000000000 tribute are not supported/);
});

test('buildTributeTx rejects zero-address tribute token', () => {
  assert.throws(() => buildTributeTx({
    chainId: 8453,
    dao,
    token: '0x0000000000000000000000000000000000000000',
    amount: 10n,
  }), /nonzero ERC-20 token address/);
});

test('buildTributeTx rejects Baal ETH sentinel tribute token', () => {
  assert.throws(() => buildTributeTx({
    chainId: 8453,
    dao,
    token: BAAL_ETH_TOKEN,
    amount: 10n,
  }), /Baal ETH sentinel/);
});

test('buildWrapEthTx creates Base WETH deposit transaction', () => {
  const built = buildWrapEthTx({ chainId: 8453, amount: parseNativeTokenAmount('0.01') });

  assert.equal(built.tx.to, BASE_WETH);
  assert.equal(built.tx.value, '10000000000000000');
  assert.equal(built.summary.action, 'wrap-eth');
});

test('buildUnwrapEthTx creates Base WETH withdraw transaction', () => {
  const built = buildUnwrapEthTx({ chainId: 8453, amount: parseNativeTokenAmount('0.01') });

  assert.equal(built.tx.to, BASE_WETH);
  assert.equal(built.tx.value, '0');
  assert.equal(built.summary.action, 'unwrap-eth');
});

test('buildApproveTokenTx defaults spender to Tribute Minion', () => {
  const built = buildApproveTokenTx({
    chainId: 8453,
    token: BASE_WETH,
    amount: parseNativeTokenAmount('0.01'),
  });

  assert.equal(built.tx.to, BASE_WETH);
  assert.equal(built.tx.value, '0');
  assert.equal(built.summary.action, 'approve-token');
  assert.equal(built.summary.spender, '0x00768B047f73D88b6e9c14bcA97221d6E179d468');
});

test('buildRagequitTx creates direct member ragequit transaction', () => {
  const built = buildRagequitTx({
    chainId: 8453,
    dao,
    to: dao,
    sharesToBurn: parseBaalTokenUnits('1'),
    lootToBurn: 0n,
    tokens: [BAAL_ETH_TOKEN],
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.tx.value, '0');
  assert.equal(built.summary.action, 'ragequit');
  assert.deepEqual(built.summary.tokens, [BAAL_ETH_TOKEN]);
});

test('parseNativeTokenAmount accepts decimal ETH amounts', () => {
  assert.equal(parseNativeTokenAmount('0.01').toString(), '10000000000000000');
  assert.equal(parseNativeTokenAmount('1').toString(), '1000000000000000000');
});

test('buildMintSharesTx treats amount as 18-decimal shares', () => {
  const built = buildMintSharesTx({
    chainId: 8453,
    dao,
    recipients: [dao],
    amounts: [parseBaalTokenUnits('1')],
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'MINT_SHARES');
  assert.deepEqual(built.summary.amounts, ['1000000000000000000']);
});

test('buildMintLootTx creates non-voting loot proposal', () => {
  const built = buildMintLootTx({
    chainId: 8453,
    dao,
    recipients: [dao],
    amounts: [parseBaalTokenUnits('100')],
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'ISSUE');
  assert.equal(built.summary.tokenAction, 'mintLoot');
  assert.deepEqual(built.summary.amounts, ['100000000000000000000']);
});

test('buildPaymentTx creates native ETH treasury payment proposal', () => {
  const built = buildPaymentTx({
    chainId: 8453,
    dao,
    recipient: '0x0000000000000000000000000000000000000002',
    amount: parseNativeTokenAmount('0.01'),
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'TRANSFER_NETWORK_TOKEN');
  assert.equal(built.summary.token, 'ETH');
  assert.equal(built.summary.amount, '10000000000000000');
});

test('buildPaymentTx creates ERC-20 treasury payment proposal', () => {
  const built = buildPaymentTx({
    chainId: 8453,
    dao,
    recipient: '0x0000000000000000000000000000000000000002',
    token: '0x0000000000000000000000000000000000000003',
    amount: parseTokenUnits('1.5', 6),
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'TRANSFER_ERC20');
  assert.equal(built.summary.token, '0x0000000000000000000000000000000000000003');
  assert.equal(built.summary.amount, '1500000');
});

test('buildGovernanceSettingsTx creates governance config proposal', () => {
  const built = buildGovernanceSettingsTx({
    chainId: 8453,
    dao,
    params: {
      votingPeriodInSeconds: 14400,
      gracePeriodInSeconds: 14400,
      newOffering: '0',
      quorum: 30,
      sponsorThreshold: '1000000000000000000',
      minRetention: 66,
    },
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'UPDATE_GOV_SETTINGS');
  assert.equal(built.summary.quorum, '30');
  assert.equal(built.summary.minRetention, '66');
});

test('buildTokenSettingsTx creates token settings proposal', () => {
  const built = buildTokenSettingsTx({
    chainId: 8453,
    dao,
    pauseShares: false,
    pauseLoot: true,
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'TOKEN_SETTINGS');
  assert.equal(built.summary.pauseShares, false);
  assert.equal(built.summary.pauseLoot, true);
});

test('buildCustomProposalTx creates generic action proposal', () => {
  const built = buildCustomProposalTx({
    chainId: 8453,
    dao,
    title: 'Custom action',
    actions: [{ to: dao, value: '0', data: '0x', operation: 0 }],
  });

  assert.equal(built.tx.to, dao);
  assert.equal(built.summary.proposalKind, 'CUSTOM');
  assert.equal(built.summary.actionCount, 1);
});

test('buildSummonTx creates advanced token summoner transaction with metadata', () => {
  const built = buildSummonTx({
    chainId: 8453,
    params: {
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
    },
  });

  assert.equal(built.tx.to, '0x97Aaa5be8B38795245f1c38A883B44cccdfB3E11');
  assert.equal(built.summary.proposalKind, 'SUMMON');
  assert.equal(built.summary.daoName, 'Example DAO');
  assert.equal(built.summary.metadataIncluded, true);
  assert.equal(built.summary.communityMemoryURI, 'ipfs://memory');
});
