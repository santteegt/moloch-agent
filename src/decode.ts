import { decodeFunctionData, type Hex } from 'viem';
import { extractProposal } from './chain.js';
import type { Config } from './config.js';
import type { ServiceClient } from './service.js';
import { BAAL_ABI, MULTISEND_ABI, POSTER_ABI } from './tx.js';

export type DecodedAction = {
  operation: number;
  to: `0x${string}`;
  value: string;
  data: Hex;
  decoded:
    | { contract: 'Poster'; functionName: 'post'; tag: string; content: unknown }
    | { contract: 'Baal'; functionName: string; args: readonly unknown[] }
    | { selector: string };
};

export type DecodedProposal = {
  // 'submitProposal' when --data was the full Baal submitProposal envelope
  // (e.g. this server's own --build-only tx.data); 'multiSend' when it was
  // already the inner multisend calldata (e.g. the indexer's proposalData).
  source: 'submitProposal' | 'multiSend';
  submitProposal?: {
    expiration: number;
    baalGas: string;
    details: unknown;
    proposalData: Hex;
  };
  actions: DecodedAction[];
};

function decodeMultiSendBytes(bytes: Hex): Array<{ operation: number; to: `0x${string}`; value: string; data: Hex }> {
  const clean = bytes.replace(/^0x/, '');
  const actions: Array<{ operation: number; to: `0x${string}`; value: string; data: Hex }> = [];
  let i = 0;
  while (i < clean.length) {
    const operation = Number.parseInt(clean.slice(i, i + 2), 16);
    i += 2;
    const to = `0x${clean.slice(i, i + 40)}` as `0x${string}`;
    i += 40;
    const value = BigInt(`0x${clean.slice(i, i + 64) || '0'}`);
    i += 64;
    const dataLength = Number(BigInt(`0x${clean.slice(i, i + 64) || '0'}`));
    i += 64;
    const data = `0x${clean.slice(i, i + dataLength * 2)}` as Hex;
    i += dataLength * 2;
    actions.push({ operation, to, value: value.toString(), data });
  }
  return actions;
}

function decodeAction(action: { operation: number; to: `0x${string}`; value: string; data: Hex }): DecodedAction {
  if (action.data && action.data !== '0x') {
    try {
      const decoded = decodeFunctionData({ abi: POSTER_ABI, data: action.data });
      const [content, tag] = decoded.args;
      let parsedContent: unknown = content;
      try {
        parsedContent = JSON.parse(content);
      } catch {
        // Not JSON — surface the raw string.
      }
      return { ...action, decoded: { contract: 'Poster', functionName: 'post', tag, content: parsedContent } };
    } catch {
      // Not a Poster post(string,string) call — fall through to Baal.
    }
    try {
      const decoded = decodeFunctionData({ abi: BAAL_ABI, data: action.data });
      return { ...action, decoded: { contract: 'Baal', functionName: decoded.functionName, args: decoded.args } };
    } catch {
      // Not a known Baal function either — fall through to the bare selector.
    }
  }
  return { ...action, decoded: { selector: (action.data || '0x').slice(0, 10) } };
}

function decodeMultiSendActions(proposalData: Hex): DecodedAction[] {
  const decoded = decodeFunctionData({ abi: MULTISEND_ABI, data: proposalData });
  return decodeMultiSendBytes(decoded.args[0]).map(decodeAction);
}

// Auto-detects whether `data` is a full Baal submitProposal envelope (what
// --build-only returns) or already the inner multisend calldata (what the
// indexer's proposalData field contains), and decodes accordingly.
export function decodeProposalCalldata(data: Hex): DecodedProposal {
  try {
    const decoded = decodeFunctionData({ abi: BAAL_ABI, data });
    if (decoded.functionName === 'submitProposal') {
      const [proposalData, expiration, baalGas, details] = decoded.args;
      let parsedDetails: unknown = details;
      try {
        parsedDetails = JSON.parse(details);
      } catch {
        // Not JSON — surface the raw string.
      }
      return {
        source: 'submitProposal',
        submitProposal: { expiration, baalGas: baalGas.toString(), details: parsedDetails, proposalData },
        actions: decodeMultiSendActions(proposalData),
      };
    }
  } catch {
    // Not a submitProposal call — try it as multisend calldata directly.
  }
  return { source: 'multiSend', actions: decodeMultiSendActions(data) };
}

// The Baal contract only stores proposalDataHash, never the calldata itself
// (see BAAL_ABI's `proposals` tuple in tx.ts), so --dao/--proposal decoding
// has a hard dependency on the indexer having proposalData for that id.
export async function decodeProposal(input: {
  config: Config;
  service: ServiceClient;
  data?: Hex;
  dao?: string;
  proposal?: string | number;
}): Promise<DecodedProposal> {
  if (input.data) return decodeProposalCalldata(input.data);
  if (!input.dao || input.proposal == null) {
    throw new Error('Provide --data, or --dao and --proposal to fetch proposalData from the indexer.');
  }
  const indexed = await input.service.proposal({ dao: input.dao, proposal: String(input.proposal) });
  const proposal = extractProposal(indexed);
  if (!proposal?.proposalData) {
    throw new Error(`No indexed proposalData found for proposal ${input.proposal}. The Baal contract only stores a hash, so decoding requires the indexer to have it.`);
  }
  return { source: 'multiSend', actions: decodeMultiSendActions(proposal.proposalData) };
}
