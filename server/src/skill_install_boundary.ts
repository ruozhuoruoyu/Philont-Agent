/**
 * The local HTTP API has no authenticated user identity and is reachable by the agent's shell.
 * A nonce issued by the same anonymous API only adds a second request; it does not prove a person
 * approved anything. Keep safety-gate overrides closed until an out-of-band authenticated approval
 * channel can supply that identity.
 */
export function rejectUnauthenticatedSkillOverride(body: Record<string, unknown>): string | null {
  if (body.override === true || body.overrideNonce != null) {
    return 'safety-gate override requires an authenticated user approval channel';
  }
  return null;
}
