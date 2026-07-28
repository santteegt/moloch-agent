import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVICE_URL, getNetwork, listNetworks, normalizeServiceUrl } from '../src/networks.js';

test('getNetwork returns the static per-chain defaults when no env overrides are set', () => {
  const network = getNetwork(8453, {});

  assert.equal(network.name, 'Base');
  assert.equal(network.rpcUrl, 'https://mainnet.base.org');
  assert.equal(network.serviceUrl, DEFAULT_SERVICE_URL);
});

test('getNetwork applies RPC_URL and MOLOCH_SERVICE_URL env overrides, normalizing the service URL', () => {
  const network = getNetwork(8453, {
    RPC_URL: 'https://rpc.example.test',
    MOLOCH_SERVICE_URL: 'https://service.example.test/',
  });

  assert.equal(network.rpcUrl, 'https://rpc.example.test');
  assert.equal(network.serviceUrl, 'https://service.example.test');
});

test('getNetwork rejects an unsupported chain ID with the supported list in the message', () => {
  assert.throws(
    () => getNetwork(1, {}),
    /Chain ID 1 is not supported\. Supported: 8453 \(Base\)\./,
  );
});

test('listNetworks returns the static registry, unaffected by env overrides', () => {
  const networks = listNetworks();

  assert.equal(networks.length, 1);
  assert.equal(networks[0].chainId, 8453);
  assert.equal(networks[0].rpcUrl, 'https://mainnet.base.org');
});

test('normalizeServiceUrl strips trailing slashes', () => {
  assert.equal(normalizeServiceUrl('https://example.test///'), 'https://example.test');
});
