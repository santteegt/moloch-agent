import { base, type Chain } from 'viem/chains';

export const DEFAULT_SERVICE_URL = 'https://moloch-service-production.up.railway.app';

export type ChainNetwork = {
  chainId: number;
  name: string;
  rpcUrl: string;
  serviceUrl: string;
  explorerBaseUrl: string;
  safeApiBaseUrl: string;
  contracts: {
    POSTER: `0x${string}`;
    TRIBUTE_MINION: `0x${string}`;
    GNOSIS_MULTISEND: `0x${string}`;
    // moloch-skills/moloch-agent/config/networks.json calls this V3_FACTORY_ADV_TOKEN.
    SUMMONER: `0x${string}`;
    WETH: `0x${string}`;
  };
  tags: {
    DAO_DB: string;
    MEMBER_DB: string;
    DAO_PROFILE_UPDATE: string;
    SUMMONER: string;
  };
  viemChain: Chain;
};

const NETWORKS: Record<number, ChainNetwork> = {
  8453: {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    serviceUrl: DEFAULT_SERVICE_URL,
    explorerBaseUrl: 'https://basescan.org',
    safeApiBaseUrl: 'https://safe-transaction-base.safe.global',
    contracts: {
      POSTER: '0x000000000000cd17345801aa8147b8D3950260FF',
      TRIBUTE_MINION: '0x00768B047f73D88b6e9c14bcA97221d6E179d468',
      GNOSIS_MULTISEND: '0x998739BFdAAdde7C933B942a68053933098f9EDa',
      SUMMONER: '0x97Aaa5be8B38795245f1c38A883B44cccdfB3E11',
      WETH: '0x4200000000000000000000000000000000000006',
    },
    tags: {
      DAO_DB: 'daohaus.proposal.database',
      MEMBER_DB: 'daohaus.member.database',
      DAO_PROFILE_UPDATE: 'daohaus.shares.daoProfile',
      SUMMONER: 'daohaus.summoner.daoProfile',
    },
    viemChain: base,
  },
};

// Full list of chains this tool supports, in registry order — used by the
// CLI `networks` command and MCP `moloch_list_networks` tool. Static
// registry data only; unlike getNetwork(), does not apply the
// RPC_URL/MOLOCH_SERVICE_URL env overrides, since those only make sense for
// the single currently-configured chain, not the catalog of all of them.
export function listNetworks(): ChainNetwork[] {
  return Object.values(NETWORKS);
}

// Resolves a chain's registry entry, applying RPC_URL/MOLOCH_SERVICE_URL env
// overrides on top of the per-chain defaults (e.g. an always-on agent's own
// Alchemy/Infura RPC, or a self-hosted moloch-service). Throws immediately
// for an unsupported chain ID, before any command (including --build-only)
// can construct a transaction against the wrong deployment.
export function getNetwork(chainId: number, env: NodeJS.ProcessEnv = process.env): ChainNetwork {
  const network = NETWORKS[chainId];
  if (!network) {
    const supported = Object.values(NETWORKS).map((n) => `${n.chainId} (${n.name})`).join(', ');
    throw new Error(`Chain ID ${chainId} is not supported. Supported: ${supported}.`);
  }
  return {
    ...network,
    rpcUrl: env.RPC_URL || network.rpcUrl,
    serviceUrl: normalizeServiceUrl(env.MOLOCH_SERVICE_URL || network.serviceUrl),
  };
}

export function getViemChain(chainId: number): Chain {
  return getNetwork(chainId).viemChain;
}

export function normalizeServiceUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
