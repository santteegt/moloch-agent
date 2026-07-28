import { getNetwork } from './networks.js';

export const DEFAULT_CHAIN_ID = 8453;

export type Config = {
  chainId: number;
  ipfsGatewayUrl?: string;
  privateKey?: `0x${string}`;
};

export function getConfig(env = process.env): Config {
  const chainId = Number(env.CHAIN_ID || DEFAULT_CHAIN_ID);
  // Throws on an unsupported chain ID immediately, before any command (including
  // --build-only) can construct a transaction against the wrong deployment.
  // Also validates RPC_URL/MOLOCH_SERVICE_URL overrides are picked up from
  // the same env this config was built from.
  getNetwork(chainId, env);
  return {
    chainId,
    ipfsGatewayUrl: env.IPFS_GATEWAY_URL,
    privateKey: env.PRIVATE_KEY as `0x${string}` | undefined,
  };
}
