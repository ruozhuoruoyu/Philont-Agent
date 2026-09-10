/**
 * The draft cap is decided BEFORE the reflector's LLM call, and the model is told.
 *
 * Prod 2026-09-10: "[reflector] not minting 22 new draft(s): 44 untested draft(s) already at cap 40" —
 * the model had written twenty-two skills that were then discarded unread, and at 06:53 that same
 * over-long output ran the aux ladder to 16384 tokens and truncated, which failed the WHOLE reflection
 * including the updates it would have kept. The waste is generating what was already decided to be
 * thrown away; the fix is to say so in the prompt and to bound new names to the real headroom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// MAX_DRAFT_SKILLS is captured at module load (min 5) → set a tiny cap BEFORE importing.
process.env.PHILONT_MAX_DRAFT_SKILLS = '5';
const { openMemoryDb, SessionReflector } = await import('../src/index.js');
import type { ExtractorLlmClient } from '../src/index.js';

class MockLlm implements ExtractorLlmClient {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async complete(prompt: string) {
    this.lastPrompt = prompt;
    return { text: this.response, tokensUsed: 100 };
  }
}

const WORDS: Record<string, string> = {
  'deploy-rust': 'compile cargo release binary', 'rotate-logs': 'archive syslog weekly',
  'warm-cache': 'prefill redis keys', 'trim-video': 'cut ffmpeg segment', 'sign-pdf': 'stamp certificate onto document',
  'export-docx': 'convert markdown document', 'ocr-scan': 'extract characters photo',
  'lint-python': 'ruff package check', 'sync-wiki': 'publish pages github',
};
// Names and descriptions share no vocabulary: the reflector's word-overlap dedup merges lexical
// neighbours into existing drafts — correct, and not what these tests measure.
const spec = (name: string) => ({
  name, description: WORDS[name], trigger_keywords: [name], action_template: `1. ${WORDS[name]}`,
});

function seed(draftNames: string[]) {
  const mem = openMemoryDb(':memory:');
  for (const n of draftNames) mem.skills.createSkill({ name: n, description: WORDS[n], triggerKeywords: [n], actionTemplate: `1. ${WORDS[n]}` });
  const session = mem.raw.startSession();
  mem.raw.appendMessage({ sessionId: session.id, role: 'user', content: 'deploy it the usual way' });
  mem.raw.appendMessage({ sessionId: session.id, role: 'assistant', content: 'done: built, tested, pushed' });
  return { mem, sessionId: session.id };
}

test('a full pool is announced before the call, and new names are not minted', async () => {
  const { mem, sessionId } = seed(['deploy-rust', 'rotate-logs', 'warm-cache', 'trim-video', 'sign-pdf']);
  assert.equal(mem.skills.untestedDraftCount(), 5);
  const llm = new MockLlm(JSON.stringify([
    { ...spec('deploy-rust'), description: 'compile cargo release binary with lto' }, // existing → update
    spec('export-docx'),                                                                 // new → must be dropped
  ]));
  const r = await new SessionReflector(llm, mem.skills, mem.actions, mem.raw).reflectFromSession(sessionId);
  assert.match(llm.lastPrompt, /Draft capacity — FULL \(5\/5/, 'the model is told the pool is full BEFORE it writes');
  assert.match(llm.lastPrompt, /Do NOT propose any new skill name/);
  assert.equal(r.skillsCreated, 0);
  assert.equal(r.skillsUpdated, 1, 'updates to existing names still land — they add evidence, not volume');
  assert.equal(mem.skills.getByName('export-docx'), null);
  assert.equal(mem.skills.untestedDraftCount(), 5);
});

test('headroom is a number the model is told, and a bound the store enforces', async () => {
  const { mem, sessionId } = seed(['deploy-rust', 'rotate-logs', 'warm-cache']);
  const llm = new MockLlm(JSON.stringify([spec('export-docx'), spec('ocr-scan'), spec('lint-python'), spec('sync-wiki')]));
  const r = await new SessionReflector(llm, mem.skills, mem.actions, mem.raw).reflectFromSession(sessionId);
  assert.match(llm.lastPrompt, /Draft capacity — 2 new skill\(s\) at most \(3\/5/);
  assert.equal(r.skillsCreated, 2, 'the model proposed four; only the headroom it was told is kept');
  assert.equal(mem.skills.untestedDraftCount(), 5);
});
