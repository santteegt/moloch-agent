import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

test('getConfig applies defaults', () => {
  const config = getConfig({});

  assert.equal(config.chainId, 8453);
  assert.equal(config.ipfsGatewayUrl, undefined);
  assert.equal(config.privateKey, undefined);
});

test('getConfig applies overrides', () => {
  const config = getConfig({
    CHAIN_ID: '8453',
    IPFS_GATEWAY_URL: 'https://gateway.example.test/ipfs/',
  });

  assert.equal(config.chainId, 8453);
  assert.equal(config.ipfsGatewayUrl, 'https://gateway.example.test/ipfs/');
});

test('getConfig rejects an unsupported chain ID immediately, even without --build-only in play', () => {
  assert.throws(
    () => getConfig({ CHAIN_ID: '84532' }),
    /Chain ID 84532 is not supported/,
  );
});
