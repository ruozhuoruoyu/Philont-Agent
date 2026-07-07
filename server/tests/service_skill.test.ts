/**
 * Service-skill emission tests. Universality is the hard constraint: the emitted skill derives
 * ENTIRELY from the SpecDoc + verified calls — a fictional service exercises the same path as any
 * real one, and the module source contains no service names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderServiceSkill, writeServiceSkill } from '../src/service_skill.js';
import type { SpecDoc } from '../src/spec_compile.js';

const FICTIONAL: SpecDoc = {
  source: { contentHash: 'abc123def4567890' },
  service: { name: 'notably', hosts: ['notably.app'] },
  basePath: '/v2',
  auth: { scheme: 'bearer', header: 'Authorization' },
  endpoints: [
    { method: 'POST', path: '/v2/auth/register', purpose: 'one-time registration' },
    { method: 'POST', path: '/v2/notes', purpose: 'create note', requiredFields: ['title', 'body'] },
    { method: 'GET', path: '/v2/notes', purpose: 'list notes' },
  ],
  preconditions: ['first session must create one note'],
  rules: ['no empty notes'],
  confidence: 1,
};

test('renderServiceSkill: everything derives from the SpecDoc — fictional service, full shape', () => {
  const r = renderServiceSkill(FICTIONAL, ['POST https://notably.app/v2/notes']);
  assert.equal(r.name, 'notably-service');
  // Frontmatter the loader can parse.
  assert.match(r.markdown, /^---\nname: notably-service\ndescription: .+\nwhen_to_use: .+\nsource: spec-compile\n---\n/);
  // Full sendable endpoint lines, auth placeholder by the service-derived credential id.
  assert.match(r.markdown, /POST https:\/\/notably\.app\/v2\/notes — create note — body\/query fields: title, body/);
  assert.match(r.markdown, /Bearer \{notably-api-key\}/);
  assert.match(r.markdown, /first session must create one note/);
  assert.match(r.markdown, /no empty notes/);
  assert.match(r.markdown, /## Verified working calls/);
  // Machine sidecar round-trips.
  assert.deepEqual(JSON.parse(r.specJson).service.hosts, ['notably.app']);
  // Stays far under the loader's 16KB actionTemplate warning threshold.
  assert.ok(r.markdown.length < 8_000, `markdown too large: ${r.markdown.length}`);
});

test('renderServiceSkill: optional sections vanish when the spec lacks them', () => {
  const bare: SpecDoc = {
    ...FICTIONAL,
    auth: undefined,
    preconditions: [],
    rules: [],
  };
  const r = renderServiceSkill(bare, []);
  assert.ok(!r.markdown.includes('## Preconditions'));
  assert.ok(!r.markdown.includes('## Rules'));
  assert.ok(!r.markdown.includes('## Verified working calls'));
  assert.match(r.markdown, /\{notably-api-key\}/, 'credential convention still documented');
});

test('writeServiceSkill: lands SKILL.md + spec.json under <root>/<name>/', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  try {
    const r = writeServiceSkill(FICTIONAL, [], root);
    const md = readFileSync(join(root, r.name, 'SKILL.md'), 'utf8');
    assert.match(md, /name: notably-service/);
    const spec = JSON.parse(readFileSync(join(root, r.name, 'spec.json'), 'utf8')) as SpecDoc;
    assert.equal(spec.endpoints.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('universality: no service name is hard-coded in the emission or compile modules', () => {
  for (const f of ['../src/service_skill.ts', '../src/spec_compile.ts']) {
    const src = read(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/mycox/i.test(src), `${f} must not mention a concrete service`);
  }
});

test('slug derives from the host, not the LLM-provided name (stable identity + credential-id match)', () => {
  const r = renderServiceSkill({ ...FICTIONAL, service: { name: 'notably-agent-platform', hosts: ['notably.app'] } }, []);
  assert.equal(r.name, 'notably-service', 'LLM name wobble must not change the skill identity');
  assert.match(r.markdown, /\{notably-api-key\}/, 'placeholder must match the capture layer host derivation');
});
