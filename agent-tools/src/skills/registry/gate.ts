/**
 * Install-time trust × verdict gate.
 *
 * Maps (source trust level) × (scanner verdict) → an install decision. This encodes the v1 product
 * rule: agent self-serve is allowed, but community + scan-dangerous is hard-blocked.
 *
 *   trust \ verdict | safe  | caution | dangerous
 *   ----------------|-------|---------|----------
 *   official        | allow | allow   | ask
 *   community        | allow | ask     | block
 *
 * - allow : install proceeds.
 * - ask   : caller must re-submit with confirm:true (web-ui confirm / agent askUserQuestion in
 *           interactive turns; treated as block in non-interactive sub-loops / autonomous turns).
 * - block : install refused, scan report returned.
 */

import type { GateDecision, TrustLevel, Verdict } from './types.js';

export function gateDecision(trust: TrustLevel, verdict: Verdict): GateDecision {
  if (trust === 'official') {
    return verdict === 'dangerous' ? 'ask' : 'allow';
  }
  // community
  if (verdict === 'safe') return 'allow';
  if (verdict === 'caution') return 'ask';
  return 'block';
}
