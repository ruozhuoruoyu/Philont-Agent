import assert from 'node:assert/strict';
import test from 'node:test';

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
