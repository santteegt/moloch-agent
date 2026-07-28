#!/usr/bin/env node
import { parseArgs, numberFlag, requiredFlag, stringFlag } from './args.js';
import { readJsonFile } from './files.js';
import { helpText } from './help.js';
import { getConfig, type Config } from './config.js';
import { decodeProposal } from './decode.js';
import { getNetwork } from './networks.js';
import { createServiceClient, type ServiceClient } from './service.js';
import { printCompact, printJson } from './output.js';
import { buildOldestReadyProcessTx, estimateBaalGas, preflightProcess, processQueue, proposalLifecycle, readBalances, readDaoDirect, readDaoHistory, readProposalDirect, readTreasuryTokens, resolveProposalOffering } from './chain.js';
import {
  asAddress,
  asHex,
  asProposalId,
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
  maybeSend,
  parseBaalTokenUnits,
  parseBigint,
  parseNativeTokenAmount,
  parseTokenUnits,
  signerAccount,
  type BuiltTx,
  type CustomProposalAction,
  type GovernanceSettingsParams,
  type SendOptions,
  type SummonParams,
} from './tx.js';

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const config = getConfig();
  const service = createServiceClient(config);
  const compact = Boolean(parsed.flags.compact);
  const full = Boolean(parsed.flags.full);
  const send = !parsed.flags['build-only'] && process.env.MOLOCH_SEND_DEFAULT !== 'false';
  const sendOptions = sendOptionsFromFlags(parsed.flags);

  let output: unknown;

  switch (parsed.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText);
      return;

    case 'health':
      output = await service.health();
      break;

    case 'capabilities':
      output = await service.capabilities();
      break;

    case 'account':
    case 'signer':
      output = signerAccount(config);
      break;

    case 'dao':
      output = await service.dao({ dao: requiredFlag(parsed.flags, 'dao') });
      break;

    case 'proposals':
      output = await service.proposals({
        dao: requiredFlag(parsed.flags, 'dao'),
        first: numberFlag(parsed.flags, 'first', 100),
        skip: numberFlag(parsed.flags, 'skip', 0),
      });
      break;

    case 'proposal':
      output = await service.proposal({
        dao: requiredFlag(parsed.flags, 'dao'),
        proposal: requiredFlag(parsed.flags, 'proposal'),
      });
      break;

    case 'links':
    case 'admin-url':
    case 'daohaus-url':
      output = linksFor(config.chainId, {
        dao: stringFlag(parsed.flags, 'dao'),
        proposal: stringFlag(parsed.flags, 'proposal'),
        address: stringFlag(parsed.flags, 'address') || stringFlag(parsed.flags, 'contract'),
        tx: stringFlag(parsed.flags, 'tx') || stringFlag(parsed.flags, 'hash'),
      });
      break;

    case 'read-dao':
      output = await readDaoDirect(config, asAddress(requiredFlag(parsed.flags, 'dao')));
      break;

    case 'balances':
    case 'balance':
      output = await readBalances({
        config,
        service,
        dao: optionalAddress(parsed.flags, 'dao'),
        address: optionalAddress(parsed.flags, 'address'),
        token: optionalAddress(parsed.flags, 'token'),
      });
      break;

    case 'treasury-tokens':
    case 'ragequit-tokens':
      output = await readTreasuryTokens({
        config,
        service,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
      });
      break;

    case 'dao-history':
      output = await readDaoHistory({
        config,
        service,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        first: numberFlag(parsed.flags, 'first', 100),
        skip: numberFlag(parsed.flags, 'skip', 0),
      });
      break;

    case 'read-proposal':
      output = await readProposalDirect(config, asAddress(requiredFlag(parsed.flags, 'dao')), asProposalId(requiredFlag(parsed.flags, 'proposal')));
      break;

    case 'proposal-lifecycle':
      output = await proposalLifecycle({
        config,
        service,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        proposal: asProposalId(requiredFlag(parsed.flags, 'proposal')),
      });
      break;

    case 'decode-proposal':
      output = await decodeProposal({
        config,
        service,
        data: stringFlag(parsed.flags, 'data') ? asHex(requiredFlag(parsed.flags, 'data')) : undefined,
        dao: stringFlag(parsed.flags, 'dao'),
        proposal: stringFlag(parsed.flags, 'proposal'),
      });
      break;

    case 'estimate-baal-gas':
      output = await estimateBaalGas({
        config,
        service,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        proposalData: asHex(requiredFlag(parsed.flags, 'proposal-data')),
        actionCount: numberFlag(parsed.flags, 'action-count', 1),
        bufferPercent: baalGasBufferPercent(parsed.flags),
      });
      break;

    case 'process-queue':
      output = await processQueue({
        config,
        service,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        first: numberFlag(parsed.flags, 'first', 100),
      });
      break;

    case 'members':
      output = await service.members({
        dao: requiredFlag(parsed.flags, 'dao'),
        first: numberFlag(parsed.flags, 'first', 100),
        skip: numberFlag(parsed.flags, 'skip', 0),
      });
      break;

    case 'records':
      output = await service.records({
        dao: requiredFlag(parsed.flags, 'dao'),
        table: stringFlag(parsed.flags, 'table', 'communityMemory') || 'communityMemory',
        first: numberFlag(parsed.flags, 'first', 100),
        skip: numberFlag(parsed.flags, 'skip', 0),
      });
      break;

    case 'pin-json':
      output = await service.pinJson({
        name: stringFlag(parsed.flags, 'name'),
        data: readJsonFile(requiredFlag(parsed.flags, 'file')),
      });
      break;

    case 'workspace-create':
      output = await createWorkspace(service, {
        config,
        kind: parseWorkspaceKind(stringFlag(parsed.flags, 'kind', 'dao') || 'dao'),
        dao: stringFlag(parsed.flags, 'dao'),
        daoName: stringFlag(parsed.flags, 'dao-name'),
        proposalKind: stringFlag(parsed.flags, 'proposal-kind'),
        proposalId: stringFlag(parsed.flags, 'proposal'),
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
      });
      break;

    case 'summon':
      output = await maybeSend(config, attachWorkspace(buildSummonTx({
        chainId: config.chainId,
        params: await summonParamsWithWorkspace(config, service, readJsonFile(requiredFlag(parsed.flags, 'params')) as SummonParams, Boolean(parsed.flags['no-workspace'])),
      }), latestWorkspace), send, sendOptions);
      break;

    case 'vote':
      output = await voteWithOptionalReason(config, service, parsed.flags, send, sendOptions);
      break;

    case 'sponsor':
      output = await maybeSend(config, buildSponsorTx({
        chainId: config.chainId,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        proposal: asProposalId(requiredFlag(parsed.flags, 'proposal')),
      }), send, sendOptions);
      break;

    case 'cancel':
      output = await maybeSend(config, buildCancelTx({
        chainId: config.chainId,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        proposal: asProposalId(requiredFlag(parsed.flags, 'proposal')),
      }), send, sendOptions);
      break;

    case 'process':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const proposal = asProposalId(requiredFlag(parsed.flags, 'proposal'));
      const proposalData = asHex(requiredFlag(parsed.flags, 'proposal-data'));
      let gasLimit = optionalBigint(parsed.flags, 'gas-limit') || optionalBigint(parsed.flags, 'process-gas-limit');
      if (send && !parsed.flags['skip-preflight']) {
        const preflight = await preflightProcess({ config, service, dao, proposal, proposalData });
        if (!preflight.ok) throw new Error(preflight.reason);
        if (gasLimit == null && preflight.processGasLimit != null) gasLimit = BigInt(preflight.processGasLimit);
      }
      output = await maybeSend(config, buildProcessTx({
        chainId: config.chainId,
        dao,
        proposal,
        proposalData,
        gasLimit,
      }), send, sendOptions);
      break;
      }

    case 'process-ready':
      output = await maybeSend(config, await buildOldestReadyProcessTx({
        config,
        service,
        chainId: config.chainId,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        first: numberFlag(parsed.flags, 'first', 100),
      }), send, sendOptions);
      break;

    case 'wrap-eth':
    case 'wrap-weth':
      output = await maybeSend(config, buildWrapEthTx({
        chainId: config.chainId,
        weth: optionalAddress(parsed.flags, 'weth') || getNetwork(config.chainId).contracts.WETH,
        amount: parseNativeTokenAmount(requiredFlag(parsed.flags, 'amount')),
      }), send, sendOptions);
      break;

    case 'unwrap-eth':
    case 'unwrap-weth':
      output = await maybeSend(config, buildUnwrapEthTx({
        chainId: config.chainId,
        weth: optionalAddress(parsed.flags, 'weth') || getNetwork(config.chainId).contracts.WETH,
        amount: parseNativeTokenAmount(requiredFlag(parsed.flags, 'amount')),
      }), send, sendOptions);
      break;

    case 'approve-token':
    case 'approve':
      output = await maybeSend(config, buildApproveTokenTx({
        chainId: config.chainId,
        token: optionalAddress(parsed.flags, 'token') || getNetwork(config.chainId).contracts.WETH,
        spender: optionalAddress(parsed.flags, 'spender'),
        amount: parseApprovalAmount(parsed.flags),
      }), send, sendOptions);
      break;

    case 'ragequit':
    case 'rage-quit':
      requireRagequitConfirmation(parsed.flags);
      output = await maybeSend(config, buildRagequitTx({
        chainId: config.chainId,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        to: asAddress(requiredFlag(parsed.flags, 'to')),
        sharesToBurn: optionalBigint(parsed.flags, 'shares-raw') || parseBaalTokenUnits(stringFlag(parsed.flags, 'shares', '0') || '0'),
        lootToBurn: optionalBigint(parsed.flags, 'loot-raw') || parseBaalTokenUnits(stringFlag(parsed.flags, 'loot', '0') || '0'),
        tokens: parseRagequitTokens(requiredFlag(parsed.flags, 'tokens')),
      }), send, sendOptions);
      break;

    case 'memory-post':
      output = await maybeSend(config, buildMemoryPostTx({
        chainId: config.chainId,
        dao: asAddress(requiredFlag(parsed.flags, 'dao')),
        table: stringFlag(parsed.flags, 'table', 'communityMemory') || 'communityMemory',
        type: stringFlag(parsed.flags, 'type'),
        threadId: stringFlag(parsed.flags, 'thread-id'),
        topicId: stringFlag(parsed.flags, 'topic-id'),
        proposalId: stringFlag(parsed.flags, 'proposal'),
        draftId: stringFlag(parsed.flags, 'draft-id'),
        title: stringFlag(parsed.flags, 'title'),
        body: stringFlag(parsed.flags, 'body') || stringFlag(parsed.flags, 'description'),
        vote: stringFlag(parsed.flags, 'vote'),
        contentURI: stringFlag(parsed.flags, 'content-uri') || stringFlag(parsed.flags, 'link'),
        contentHash: stringFlag(parsed.flags, 'content-hash'),
        workspaceURI: stringFlag(parsed.flags, 'workspace-uri'),
        stateURI: stringFlag(parsed.flags, 'state-uri'),
        agent: stringFlag(parsed.flags, 'agent'),
        version: stringFlag(parsed.flags, 'version'),
        tag: stringFlag(parsed.flags, 'tag'),
      }), send, sendOptions);
      break;

    case 'signal':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, 'SIGNAL');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildSignalTx({
        chainId: config.chainId,
        dao,
        title: requiredFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description', '') || '',
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'dao-meta':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, 'UPDATE_METADATA_SETTINGS');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildDaoMetaTx({
        chainId: config.chainId,
        dao,
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        name: stringFlag(parsed.flags, 'name'),
        daoDescription: stringFlag(parsed.flags, 'dao-description'),
        communityMemoryURI: stringFlag(parsed.flags, 'community-memory-uri'),
        proposalWorkspaceURI: stringFlag(parsed.flags, 'proposal-workspace-uri'),
        sharedStateURI: stringFlag(parsed.flags, 'shared-state-uri'),
        web: stringFlag(parsed.flags, 'web'),
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'dao-record':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const table = stringFlag(parsed.flags, 'table', 'daoProfile');
      const content = stringFlag(parsed.flags, 'content-file') ? readJsonFile(requiredFlag(parsed.flags, 'content-file')) as Record<string, unknown> : undefined;
      const link = await proposalLink(config, service, parsed.flags, 'UPDATE_METADATA_SETTINGS');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildDaoRecordTx({
        chainId: config.chainId,
        dao,
        table,
        tag: stringFlag(parsed.flags, 'tag'),
        content,
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'gov-settings':
    case 'governance-settings':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const params = readJsonFile(requiredFlag(parsed.flags, 'params')) as GovernanceSettingsParams;
      if (params.value == null) params.value = await proposalOffering(config, dao, parsed.flags);
      const link = await proposalLink(config, service, parsed.flags, 'UPDATE_GOV_SETTINGS');
      const explicitBaalGas = params.baalGas == null ? undefined : BigInt(params.baalGas);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, explicitBaalGas, (baalGas) => buildGovernanceSettingsTx({
        chainId: config.chainId,
        dao,
        params: { ...params, baalGas },
        link,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'token-settings':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, 'TOKEN_SETTINGS');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildTokenSettingsTx({
        chainId: config.chainId,
        dao,
        pauseShares: parseBool(requiredFlag(parsed.flags, 'pause-shares')),
        pauseLoot: parseBool(requiredFlag(parsed.flags, 'pause-loot')),
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'custom-proposal':
    case 'custom':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, stringFlag(parsed.flags, 'proposal-type', 'CUSTOM') || 'CUSTOM');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildCustomProposalTx({
        chainId: config.chainId,
        dao,
        title: requiredFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        proposalType: stringFlag(parsed.flags, 'proposal-type', 'CUSTOM'),
        actions: readJsonFile(requiredFlag(parsed.flags, 'actions')) as CustomProposalAction[],
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'tribute':
    case 'join-dao':
    case 'swap':
    case 'token-swap':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      output = await maybeSend(config, attachWorkspace(buildTributeTx({
        chainId: config.chainId,
        dao,
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link: await proposalLink(config, service, parsed.flags, 'TOKENS_FOR_SHARES'),
        token: requiredFlag(parsed.flags, 'token'),
        amount: parseTributeAmount(parsed.flags),
        shares: optionalBigint(parsed.flags, 'shares-raw') || parseBaalTokenUnits(stringFlag(parsed.flags, 'shares', '0') || '0'),
        loot: optionalBigint(parsed.flags, 'loot-raw') || parseBaalTokenUnits(stringFlag(parsed.flags, 'loot', '0') || '0'),
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas: optionalBigint(parsed.flags, 'baal-gas'),
        proposalOffering: await proposalOffering(config, dao, parsed.flags),
      }), latestWorkspace), send, sendOptions);
      break;
      }

    case 'payment':
    case 'pay':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, optionalAddress(parsed.flags, 'token') ? 'TRANSFER_ERC20' : 'TRANSFER_NETWORK_TOKEN');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildPaymentTx({
        chainId: config.chainId,
        dao,
        recipient: asAddress(requiredFlag(parsed.flags, 'recipient')),
        token: optionalAddress(parsed.flags, 'token'),
        amount: parsePaymentAmount(parsed.flags),
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'mint-shares':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, 'MINT_SHARES');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildMintSharesTx({
        chainId: config.chainId,
        dao,
        recipients: listFlag(requiredFlag(parsed.flags, 'to')).map(asAddress),
        amounts: parseAmountList(parsed.flags),
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    case 'mint-loot':
      {
      const dao = asAddress(requiredFlag(parsed.flags, 'dao'));
      const link = await proposalLink(config, service, parsed.flags, 'ISSUE');
      const offering = await proposalOffering(config, dao, parsed.flags);
      const builtTx = await withBaalGasEstimate(config, service, dao, parsed.flags, optionalBigint(parsed.flags, 'baal-gas'), (baalGas) => buildMintLootTx({
        chainId: config.chainId,
        dao,
        recipients: listFlag(requiredFlag(parsed.flags, 'to')).map(asAddress),
        amounts: parseAmountList(parsed.flags),
        title: stringFlag(parsed.flags, 'title'),
        description: stringFlag(parsed.flags, 'description'),
        link,
        expiration: numberFlag(parsed.flags, 'expiration', 0),
        baalGas,
        proposalOffering: offering,
      }));
      output = await maybeSend(config, attachWorkspace(builtTx, latestWorkspace), send, sendOptions);
      break;
      }

    default:
      throw new Error(`Unknown command: ${parsed.command}\n\n${helpText}`);
  }

  const printable = full ? output : summarizeOutput(output);
  if (compact) printCompact(printable);
  else printJson(printable);
}

let latestWorkspace: WorkspaceResult | undefined;

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function linksFor(chainId: number, input: { dao?: string; proposal?: string; address?: string; tx?: string }): Record<string, string | number> {
  const dao = input.dao ? asAddress(input.dao) : undefined;
  const address = input.address ? asAddress(input.address) : undefined;
  const tx = input.tx ? asHex(input.tx) : undefined;
  if (!dao && !address && !tx) throw new Error('Provide --dao, --address, or --tx.');
  const adminBase = dao ? `https://admin.daohaus.club/molochv3/0x${chainId.toString(16)}/${dao}` : '';
  const explorerBase = getNetwork(chainId).explorerBaseUrl;
  return {
    chainId,
    dao: dao || '',
    daoUrl: adminBase,
    proposalsUrl: adminBase ? `${adminBase}/proposals` : '',
    proposalUrl: adminBase && input.proposal ? `${adminBase}/proposal/${input.proposal}` : '',
    daoExplorerUrl: dao ? `${explorerBase}/address/${dao}` : '',
    address: address || '',
    addressExplorerUrl: address ? `${explorerBase}/address/${address}` : '',
    addressCodeUrl: address ? `${explorerBase}/address/${address}#code` : '',
    tx: tx || '',
    txExplorerUrl: tx ? `${explorerBase}/tx/${tx}` : '',
  };
}

async function proposalLink(
  config: Config,
  service: ServiceClient,
  flags: Record<string, string | boolean>,
  proposalKind: string,
): Promise<string> {
  const explicit = stringFlag(flags, 'link') || stringFlag(flags, 'content-uri');
  if (explicit || flags['no-workspace']) return explicit || '';
  const title = stringFlag(flags, 'title') || `${proposalKind} proposal workspace`;
  const workspace = await createWorkspace(service, {
    config,
    kind: 'proposal',
    dao: requiredFlag(flags, 'dao'),
    proposalKind,
    title,
    description: stringFlag(flags, 'description'),
  });
  latestWorkspace = workspace;
  return workspace.link;
}

async function summonParamsWithWorkspace(
  config: Config,
  service: ServiceClient,
  params: SummonParams,
  noWorkspace: boolean,
): Promise<SummonParams> {
  if (noWorkspace) return params;
  if (params.communityMemoryURI && params.proposalWorkspaceURI && params.sharedStateURI) return params;
  const workspace = await createWorkspace(service, {
    config,
    kind: 'dao',
    daoName: params.daoName,
    title: `${params.daoName} workspace`,
    description: params.description,
  });
  latestWorkspace = workspace;
  return {
    ...params,
    communityMemoryURI: params.communityMemoryURI || workspace.uri,
    proposalWorkspaceURI: params.proposalWorkspaceURI || workspace.uri,
    sharedStateURI: params.sharedStateURI || workspace.uri,
  };
}

async function createWorkspace(service: ServiceClient, input: WorkspaceInput): Promise<WorkspaceResult> {
  const now = new Date().toISOString();
  const slug = slugify(input.title || input.daoName || input.dao || input.kind);
  const workspace = compactObject({
    schema: input.kind === 'dao' ? 'dao-workspace/v1' : 'proposal-workspace/v1',
    kind: input.kind,
    dao: input.dao?.toLowerCase(),
    daoName: input.daoName,
    proposalId: input.proposalId,
    proposalKind: input.proposalKind,
    title: input.title,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    communityState: input.kind === 'dao' ? {
      version: 1,
      body: input.description || '',
      ratifiedByProposalId: null,
    } : undefined,
    threads: input.kind === 'proposal' ? [
      { id: 'deliberation', title: 'Deliberation' },
      { id: 'vote-reasons', title: 'Vote Reasons' },
      { id: 'retro', title: 'Retro' },
    ] : [
      { id: 'community-state', title: 'Community State' },
      { id: 'join-rules', title: 'Join Rules' },
      { id: 'operations', title: 'Operations' },
    ],
    records: [],
  });
  const pinned = normalizePinResult(await service.pinJson({
    name: `${input.kind}-workspace-${slug}-${Date.now()}`,
    data: workspace,
  }));
  const link = input.config.ipfsGatewayUrl ? pinned.gatewayUrl : pinned.uri;
  return {
    ...pinned,
    kind: input.kind,
    link,
    workspace,
  };
}

async function voteWithOptionalReason(
  config: Config,
  service: ServiceClient,
  flags: Record<string, string | boolean>,
  send: boolean,
  sendOptions: SendOptions,
): Promise<unknown> {
  const dao = asAddress(requiredFlag(flags, 'dao'));
  const proposal = asProposalId(requiredFlag(flags, 'proposal'));
  const approved = parseBool(requiredFlag(flags, 'approved'));
  const reason = stringFlag(flags, 'reason');
  const voteTx = buildVoteTx({
    chainId: config.chainId,
    dao,
    proposal,
    approved,
  });

  if (!reason) return maybeSend(config, voteTx, send, sendOptions);

  const workspaceURI = stringFlag(flags, 'workspace-uri') || await proposalContentURI(service, dao, proposal);
  const reasonTx = buildMemoryPostTx({
    chainId: config.chainId,
    dao,
    table: 'communityMemory',
    type: 'vote-reason',
    threadId: stringFlag(flags, 'thread-id') || `proposal-${proposal}-vote-reasons`,
    proposalId: String(proposal),
    title: stringFlag(flags, 'reason-title') || `Vote ${approved ? 'yes' : 'no'} on proposal ${proposal}`,
    body: reason,
    vote: approved ? 'yes' : 'no',
    workspaceURI,
    agent: stringFlag(flags, 'agent'),
  });

  const reasonResult = await maybeSend(config, reasonTx, send, sendOptions);
  const voteResult = await maybeSend(config, voteTx, send, sendOptions);
  return {
    action: 'vote-with-reason',
    reason: reasonResult,
    vote: voteResult,
  };
}

function sendOptionsFromFlags(flags: Record<string, string | boolean>): SendOptions {
  if (flags.wait && flags['no-wait']) throw new Error('Use either --wait or --no-wait, not both.');
  const confirmations = numberFlag(flags, 'confirmations', 1);
  if (confirmations < 1) throw new Error('--confirmations must be a positive integer');
  if (flags['no-wait'] && confirmations !== 1) throw new Error('--confirmations requires waiting; remove --no-wait.');
  return {
    wait: flags['no-wait'] ? false : flags.wait ? true : undefined,
    confirmations,
  };
}

async function proposalContentURI(service: ServiceClient, dao: `0x${string}`, proposal: number): Promise<string | undefined> {
  try {
    const value = await service.proposal({ dao, proposal: String(proposal) });
    return findStringField(value, 'contentURI');
  } catch {
    return undefined;
  }
}

function findStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, key);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  for (const item of Object.values(record)) {
    const found = findStringField(item, key);
    if (found) return found;
  }
  return undefined;
}

function attachWorkspace<T extends BuiltTx>(built: T, workspace?: WorkspaceResult): T {
  if (!workspace) return built;
  return {
    ...built,
    summary: {
      ...built.summary,
      workspaceURI: workspace.uri,
      workspaceLink: workspace.link,
      workspaceGatewayUrl: workspace.gatewayUrl,
    },
  };
}

function normalizePinResult(value: unknown): PinResult {
  if (!value || typeof value !== 'object') throw new Error('Pinning service returned an invalid response.');
  const record = value as Record<string, unknown>;
  const cid = String(record.cid || '');
  const uri = String(record.uri || (cid ? `ipfs://${cid}` : ''));
  const gatewayUrl = String(record.gatewayUrl || '');
  if (!cid || !uri) throw new Error('Pinning service response is missing cid/uri.');
  return {
    cid,
    uri,
    gatewayUrl,
    name: typeof record.name === 'string' ? record.name : undefined,
  };
}

function parseWorkspaceKind(value: string): WorkspaceKind {
  if (value === 'dao' || value === 'proposal') return value;
  throw new Error('--kind must be dao or proposal.');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
}

function parseBool(value: string): boolean {
  if (/^(true|1|yes|y)$/i.test(value)) return true;
  if (/^(false|0|no|n)$/i.test(value)) return false;
  throw new Error('Expected boolean true/false.');
}

function optionalBigint(flags: Record<string, string | boolean>, name: string): bigint | undefined {
  const value = stringFlag(flags, name);
  return value == null ? undefined : parseBigint(value);
}

async function proposalOffering(config: Config, dao: `0x${string}`, flags: Record<string, string | boolean>): Promise<bigint> {
  const explicit = optionalBigint(flags, 'proposal-offering') ?? optionalBigint(flags, 'value');
  return resolveProposalOffering(config, dao, explicit);
}

// --baal-gas-buffer is a decimal multiplier (default 1.2); estimateBaalGas
// wants it as a whole-number percentage (120).
function baalGasBufferPercent(flags: Record<string, string | boolean>): number | undefined {
  const input = stringFlag(flags, 'baal-gas-buffer', '1.2') || '1.2';
  const percent = Math.round(Number(input) * 100);
  return Number.isFinite(percent) ? percent : undefined;
}

// Opt-in (--estimate-baal-gas): builds once with baalGas=0 to obtain the
// proposal's multisend calldata and action count, estimates a safe baalGas
// stipend by simulating that calldata through the DAO's Safe module, then
// rebuilds with the estimate applied. No-op (and no extra RPC call) unless
// the flag is passed or baalGas is already explicit (--baal-gas, or
// --params' baalGas field for gov-settings).
async function withBaalGasEstimate(
  config: Config,
  service: ServiceClient,
  dao: `0x${string}`,
  flags: Record<string, string | boolean>,
  explicitBaalGas: bigint | undefined,
  build: (baalGas: bigint | undefined) => BuiltTx,
): Promise<BuiltTx> {
  if (explicitBaalGas != null || !flags['estimate-baal-gas']) return build(explicitBaalGas);

  const draft = build(0n);
  const proposalData = draft.summary.proposalData;
  if (typeof proposalData !== 'string' || !proposalData.startsWith('0x')) return draft;
  const actionCount = typeof draft.summary.actionCount === 'number' ? draft.summary.actionCount : 1;

  try {
    const estimate = await estimateBaalGas({
      config,
      service,
      dao,
      proposalData: proposalData as `0x${string}`,
      actionCount,
      bufferPercent: baalGasBufferPercent(flags),
    });
    return build(BigInt(estimate.baalGas));
  } catch (error) {
    if (flags['require-baal-gas-estimate']) throw error instanceof Error ? error : new Error(String(error));
    return draft;
  }
}

function optionalAddress(flags: Record<string, string | boolean>, name: string): `0x${string}` | undefined {
  const value = stringFlag(flags, name);
  return value == null ? undefined : asAddress(value);
}

function listFlag(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseAmountList(flags: Record<string, string | boolean>): bigint[] {
  const raw = stringFlag(flags, 'amount-raw');
  if (raw) return listFlag(raw).map(parseBigint);
  const amount = requiredFlag(flags, 'amount');
  return listFlag(amount).map(parseBaalTokenUnits);
}

function parseTributeAmount(flags: Record<string, string | boolean>): bigint {
  const raw = stringFlag(flags, 'amount-raw');
  if (raw) return parseBigint(raw);
  const amount = stringFlag(flags, 'amount', '0') || '0';
  const token = stringFlag(flags, 'token', 'ETH') || 'ETH';
  if (/^(ETH|NATIVE)$/i.test(token) || token.toLowerCase() === '0x0000000000000000000000000000000000000000' || token.toLowerCase() === BAAL_ETH_TOKEN.toLowerCase()) {
    throw new Error('Tribute/swap proposals require a nonzero ERC-20 --token address. Native ETH, Baal ETH sentinel, and 0x0000000000000000000000000000000000000000 tribute are not supported by the DAOhaus Tribute Minion.');
  }
  return parseBigint(amount);
}

function parsePaymentAmount(flags: Record<string, string | boolean>): bigint {
  const raw = stringFlag(flags, 'amount-raw');
  if (raw) return parseBigint(raw);
  const amount = requiredFlag(flags, 'amount');
  if (!stringFlag(flags, 'token')) return parseNativeTokenAmount(amount);
  const decimals = stringFlag(flags, 'decimals');
  if (!decimals) {
    throw new Error('ERC-20 payment proposals require --amount-raw or --decimals because token decimals vary.');
  }
  return parseTokenUnits(amount, Number(decimals));
}

function parseApprovalAmount(flags: Record<string, string | boolean>): bigint {
  if (flags.max) return (1n << 256n) - 1n;
  const raw = stringFlag(flags, 'amount-raw');
  if (raw) return parseBigint(raw);
  const amount = requiredFlag(flags, 'amount');
  const decimals = stringFlag(flags, 'decimals');
  return decimals ? parseTokenUnits(amount, Number(decimals)) : parseNativeTokenAmount(amount);
}

function requireRagequitConfirmation(flags: Record<string, string | boolean>): void {
  if (flags['build-only'] || flags['confirm-ragequit']) return;
  throw new Error('ragequit burns DAO shares/loot and exits treasury value. Re-run with --confirm-ragequit to broadcast, or --build-only to inspect.');
}

function parseRagequitTokens(value: string): `0x${string}`[] {
  const tokens = listFlag(value).map((token) => {
    if (/^(ETH|NATIVE)$/i.test(token)) return BAAL_ETH_TOKEN as `0x${string}`;
    return asAddress(token);
  });
  const sorted = [...tokens].sort((a, b) => BigInt(a.toLowerCase()) < BigInt(b.toLowerCase()) ? -1 : 1);
  if (tokens.some((token, index) => token.toLowerCase() !== sorted[index].toLowerCase())) {
    throw new Error('Baal ragequit token list must be sorted ascending. Use ETH/NATIVE for the Baal ETH sentinel.');
  }
  return tokens;
}

function summarizeOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if ('summary' in value) {
    const result = value as { summary: Record<string, unknown>; sent?: boolean; hash?: string };
    const summary = { ...result.summary };
    delete summary.proposalData;
    return {
      summary,
      sent: result.sent || false,
      hash: result.hash,
      note: 'Use --full to print unsigned transaction calldata.',
    };
  }
  return stripLargeFields(value);
}

type WorkspaceKind = 'dao' | 'proposal';

type WorkspaceInput = {
  config: Config;
  kind: WorkspaceKind;
  dao?: string;
  daoName?: string;
  proposalKind?: string;
  proposalId?: string;
  title?: string;
  description?: string;
};

type PinResult = {
  cid: string;
  uri: string;
  gatewayUrl: string;
  name?: string;
};

type WorkspaceResult = PinResult & {
  kind: WorkspaceKind;
  link: string;
  workspace: Record<string, unknown>;
};

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function stripLargeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLargeFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key === 'data' || key === 'proposalData') && typeof item === 'string' && item.startsWith('0x') && item.length > 80) {
      return [key, `${item.slice(0, 42)}...${item.slice(-8)}`];
    }
    return [key, stripLargeFields(item)];
  }));
}
