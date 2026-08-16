/**
 * The local API's boundary: who may call it, and who may claim to be the user.
 *
 * Context. The HTTP API answers on a port with no authentication and used to send
 * `Access-Control-Allow-Origin: *`, which was survivable until the install endpoint gained an
 * `override` flag that walks a skill past the safety gate. Two shapes of abuse became worth money:
 * a page the owner has open POSTing to the port (drive-by, remote attacker), and philont's own shell
 * tool curling the same endpoint (the model routing around a gate meant to stop it). The second is not
 * fully closable — a local process can do local things — but recording it as `actor: 'user'` would put
 * the owner's name on a decision they never made, which is worse than not logging it at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { isAllowedOrigin, corsHeaders, rejectCrossSite, describeCaller } from '../src/http_origin.js';
import { rejectUnauthenticatedSkillOverride } from '../src/skill_install_boundary.js';

function fakeReq(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

test('origins: loopback is trusted, the open internet is not', () => {
  assert.equal(isAllowedOrigin('http://localhost:20266'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://[::1]:8080'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.example'), false);
  assert.equal(isAllowedOrigin(undefined), false);
});

test('origins: the operator can name additional ones', () => {
  const prev = process.env.PHILONT_ALLOWED_ORIGINS;
  process.env.PHILONT_ALLOWED_ORIGINS = 'https://my.box.example,https://other.example/';
  try {
    assert.equal(isAllowedOrigin('https://my.box.example'), true);
    assert.equal(isAllowedOrigin('https://other.example'), true);
    assert.equal(isAllowedOrigin('https://evil.example'), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_ALLOWED_ORIGINS;
    else process.env.PHILONT_ALLOWED_ORIGINS = prev;
  }
});

test('CORS: a trusted origin is echoed; an untrusted one gets no header at all', () => {
  const ok = corsHeaders(fakeReq('GET', { origin: 'http://localhost:5173' }));
  assert.equal(ok['Access-Control-Allow-Origin'], 'http://localhost:5173');
  assert.equal(ok.Vary, 'Origin');
  // Never '*': that is what made every page on the internet a client of this port.
  assert.notEqual(ok['Access-Control-Allow-Origin'], '*');
  assert.deepEqual(corsHeaders(fakeReq('GET', { origin: 'https://evil.example' })), {});
  assert.deepEqual(corsHeaders(fakeReq('GET')), {});
});

test('cross-site guard: blocks foreign POSTs, allows the UI and local scripts', () => {
  assert.match(String(rejectCrossSite(fakeReq('POST', { origin: 'https://evil.example' }))), /origin not allowed/);
  assert.match(String(rejectCrossSite(fakeReq('POST', { 'sec-fetch-site': 'cross-site' }))), /cross-site/);
  assert.equal(rejectCrossSite(fakeReq('POST', { origin: 'http://localhost:5173' })), null);
  assert.equal(rejectCrossSite(fakeReq('POST', {})), null, 'a local script has no Origin and stays usable');
  // Reads are untouched — the guard is about state changes.
  assert.equal(rejectCrossSite(fakeReq('GET', { origin: 'https://evil.example' })), null);
});

test('caller description records the evidence, not an assumption', () => {
  assert.equal(describeCaller(fakeReq('POST', { origin: 'http://localhost:5173' })), 'origin=http://localhost:5173');
  assert.match(describeCaller(fakeReq('POST', { 'user-agent': 'curl/8.0' })), /^local\(no-origin\) ua=curl/);
});

test('anonymous HTTP callers cannot turn themselves into a user with an override token', () => {
  assert.match(String(rejectUnauthenticatedSkillOverride({ override: true })), /authenticated user approval/);
  assert.match(String(rejectUnauthenticatedSkillOverride({ overrideNonce: 'self-minted' })), /authenticated user approval/);
  assert.equal(rejectUnauthenticatedSkillOverride({ confirm: true }), null);
});
