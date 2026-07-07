/**
 * Service skill emission (spec_regime.md increment 3) — a compiled SpecDoc lands as a normal
 * FS skill, managed by the existing skill lifecycle. UNIVERSAL BY CONSTRUCTION: every string in
 * the emitted skill derives from the SpecDoc (itself compiled from whatever guide the task named)
 * plus this run's verified calls. No service name appears in this module.
 *
 * What this buys, for any service with a guide:
 *   - recurring/scheduled routines can use_skill(<service>-service) and read the compiled contract
 *     instead of re-fetching and re-parsing the guide every fire;
 *   - "清除 <service>" finally has a boundary object: the skill name contains the service slug, so
 *     the existing contains-matching cleanup (uninstallSkill / forget_skill) removes it with the
 *     credentials and schedules;
 *   - the verified-calls section is the cookbook, persisted where skill recall can find it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpecDoc } from './spec_compile.js';

/** Frontmatter-safe, dir-safe slug. */
function slug(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) ||
    'service'
  );
}

export interface RenderedServiceSkill {
  /** Skill directory / frontmatter name, e.g. `<service>-service`. */
  name: string;
  markdown: string;
  specJson: string;
}

/** Pure render — no I/O. Deterministic from (spec, verifiedCalls). */
export function renderServiceSkill(spec: SpecDoc, verifiedCalls: readonly string[]): RenderedServiceSkill {
  const service = slug(spec.service.name);
  const name = `${service}-service`;
  const host = spec.service.hosts[0] ?? '';
  const credId = `${service}-api-key`;
  const lines: string[] = [
    '---',
    `name: ${name}`,
    `description: Operate the ${service} service (${host}) per its compiled spec — endpoints, auth, preconditions.`,
    `when_to_use: any task touching ${service} / ${host} (API calls, routines, check-ins, posting) — read this before improvising a request.`,
    'source: spec-compile',
    '---',
    '',
    `# ${service} service`,
    '',
    `Compiled from the service guide (content hash ${spec.source.contentHash}). Endpoints below are`,
    'the FULL sendable paths — do not invent hosts, prefixes, or /v1/* variants.',
    '',
    '## Auth',
    spec.auth?.header || spec.auth?.scheme
      ? `- ${spec.auth?.header ?? 'Authorization'}: ${spec.auth?.scheme === 'bearer' ? 'Bearer ' : ''}{${credId}} (credential placeholder — the host injects the real value; never paste key material)`
      : `- If the service issued an api key it is stored as {${credId}} — use the placeholder in http calls.`,
    '',
    '## Endpoints',
    `Host: ${spec.service.hosts.join(', ')}`,
    '',
  ];
  for (const e of spec.endpoints.slice(0, 40)) {
    const fields = e.requiredFields?.length ? ` — body/query fields: ${e.requiredFields.join(', ')}` : '';
    lines.push(`- ${e.method} https://${host}${e.path}${e.purpose ? ` — ${e.purpose}` : ''}${fields}`);
  }
  if (spec.preconditions.length) {
    lines.push('', '## Preconditions (mandatory)');
    for (const p of spec.preconditions.slice(0, 12)) lines.push(`- ${p}`);
  }
  if (spec.rules.length) {
    lines.push('', '## Rules (obey; these are constraints, not tasks)');
    for (const r of spec.rules.slice(0, 12)) lines.push(`- ${r}`);
  }
  if (verifiedCalls.length) {
    lines.push('', '## Verified working calls (from a real successful run)');
    for (const c of [...new Set(verifiedCalls)].slice(0, 20)) lines.push(`- ${c}`);
  }
  lines.push(
    '',
    '## Machine-readable spec',
    'The full compiled SpecDoc sits next to this file as `spec.json` (readFile it for field-level detail).',
    '',
  );
  return {
    name,
    markdown: lines.join('\n'),
    specJson: JSON.stringify(spec, null, 2),
  };
}

/**
 * Write (or overwrite — the spec hash moved or a fresh run re-verified) the skill under
 * `<skillsRoot>/<name>/`. The skills fs-watcher hot-reloads it. Throws on I/O failure; callers
 * treat emission as best-effort.
 */
export function writeServiceSkill(
  spec: SpecDoc,
  verifiedCalls: readonly string[],
  skillsRoot: string,
): RenderedServiceSkill {
  const rendered = renderServiceSkill(spec, verifiedCalls);
  const dir = join(skillsRoot, rendered.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), rendered.markdown, 'utf8');
  writeFileSync(join(dir, 'spec.json'), rendered.specJson, 'utf8');
  return rendered;
}
