import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveProposalLifecycle } from '../src/chain.js';

// Shared with moloch-skills' moloch.mjs (which is tested against the same
// fixture there) so a semantic change in either implementation's lifecycle
// state machine surfaces as a test failure here instead of silent drift
// between the two independent copies.
const fixturePath = fileURLToPath(new URL('./fixtures/proposal-lifecycle.fixture.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: Array<{
    name: string;
    proposal: Record<string, unknown>;
    now?: number;
    chain?: Record<string, unknown>;
    expectedStatus: string;
    expectedProcessableNow?: boolean;
  }>;
};

for (const testCase of fixture.cases) {
  test(`proposal-lifecycle fixture: ${testCase.name}`, () => {
    const now = testCase.now ?? Math.floor(Date.now() / 1000);
    const lifecycle = deriveProposalLifecycle(testCase.proposal as never, now, testCase.chain ?? {});

    assert.equal(lifecycle.status, testCase.expectedStatus);
    if (testCase.expectedProcessableNow != null) {
      assert.equal(lifecycle.processableNow, testCase.expectedProcessableNow);
    }
  });
}
