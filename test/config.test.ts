import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RPC_URL, DEFAULT_SERVICE_URL, getConfig, normalizeServiceUrl } from '../src/config.js';

test('getConfig applies defaults', () => {
  const config = getConfig({});

  assert.equal(config.serviceUrl, DEFAULT_SERVICE_URL);
  assert.equal(config.chainId, 8453);
  assert.equal(config.rpcUrl, DEFAULT_RPC_URL);
});

test('getConfig applies overrides', () => {
  const config = getConfig({
    MOLOCH_SERVICE_URL: 'https://example.test/',
    CHAIN_ID: '8453',
    RPC_URL: 'https://rpc.example.test',
    IPFS_GATEWAY_URL: 'https://gateway.example.test/ipfs/',
  });

  assert.equal(config.serviceUrl, 'https://example.test');
  assert.equal(config.chainId, 8453);
  assert.equal(config.rpcUrl, 'https://rpc.example.test');
  assert.equal(config.ipfsGatewayUrl, 'https://gateway.example.test/ipfs/');
});

test('getConfig rejects an unsupported chain ID immediately, even without --build-only in play', () => {
  assert.throws(
    () => getConfig({ CHAIN_ID: '84532' }),
    /Chain ID 84532 is not supported/,
  );
});

test('normalizeServiceUrl strips trailing slash', () => {
  assert.equal(normalizeServiceUrl('https://example.test///'), 'https://example.test');
});
