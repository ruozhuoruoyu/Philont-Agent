import assert from 'node:assert/strict';
import test from 'node:test';

import { isMarketplaceSourceTag } from '@agent/tools';
import { isDownloadedSkill } from '../../web-ui/src/marketplace_model.js';

test('installed marketplace classification falls back to persisted source when the lock is unavailable', () => {
  for (const source of [
    'github:owner/repo@abc1234',
    'clawhub:@publisher/skill@1.2.3',
    'url:https://example.test/SKILL.md',
  ]) {
    assert.equal(isDownloadedSkill({ source, provenance: null }), true, source);
  }

  assert.equal(isDownloadedSkill({ source: 'self:reflection', provenance: null }), false);
  assert.equal(isDownloadedSkill({ source: null, provenance: null }), false);
  assert.equal(isDownloadedSkill({ source: null, provenance: { sourceId: 'git' } }), true);
});

test('the UI copy of the marketplace-source rule cannot drift from the canonical one', () => {
  // web-ui cannot import @agent/tools (browser bundle, no dependency), so the rule exists twice.
  // This is the only place both are reachable — bind them here rather than trusting two lists to
  // stay equal, which is the failure this repo keeps paying for.
  const cases: Array<[string, boolean]> = [
    ['github:owner/repo@abc1234', true],
    ['clawhub:@publisher/skill@1.2.3', true],
    ['url:https://example.test/SKILL.md', true],
    ['self:reflection', false],
    ['reflect:2026-08-20', false],
    ['', false],
    ['not-a-tag', false],
  ];
  for (const [source, expected] of cases) {
    assert.equal(isMarketplaceSourceTag(source), expected, `canonical: ${source}`);
    assert.equal(isDownloadedSkill({ source, provenance: null }), expected, `web-ui: ${source}`);
  }
});
