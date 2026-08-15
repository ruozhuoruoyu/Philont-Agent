/**
 * Agent-facing skill marketplace tools: searchSkills + installSkillFromRegistry.
 *
 * These let the agent self-serve capability mid-conversation (philont's existing model), but routed
 * through the typed aggregator + safety gate instead of shelling out to an external CLI. Trust × scan
 * verdict gating still applies: community + dangerous is hard-blocked; community + caution requires
 * explicit confirm (the agent must get the user's go-ahead first).
 *
 * installSkillFromRegistry writes via the same primitive as installSkill; the SERVER must wrap this tool
 * with reloadSkillsFromDisk (like installSkill) so the new skill is usable in the same turn.
 */

import type { Tool } from '@agent/policy';
import { searchAll, installFromSource } from './registry/index.js';
import type { NotInstalledReport, ScanHit } from './registry/index.js';

/**
 * Render scan findings WITH the file they came from.
 *
 * The scanner has always attributed each hit to a file, and nothing printed it: a hit inside
 * `skills/observability/SKILL.md` was shown as "(line 153)" next to the entry SKILL.md the reader was
 * looking at, so they would reasonably conclude the line was in the file on screen. The user's consent
 * to override the gate is built on this text.
 */
function formatHits(hits: ScanHit[] | undefined): string {
  if (!hits?.length) return 'none';
  return hits.map((h) => `${h.category}: ${h.pattern} (${h.file ?? 'SKILL.md'}:${h.line})`).join('; ');
}

/**
 * Render what the install left behind. philont writes a single SKILL.md, but most real skills are
 * bundles (scripts/, reference/, sub-skills). Reporting "installed" while silently dropping the files
 * the SKILL.md itself tells the agent to run produces a skill that looks present and cannot work —
 * so the omission is always stated, and the agent is told to verify before relying on it.
 */
function partialInstallNotice(report: NotInstalledReport | undefined, installedFiles?: number): string {
  const wrote = installedFiles && installedFiles > 1 ? `\nInstalled ${installedFiles} files (SKILL.md + companions).` : '';
  if (!report || report.total <= 0) return wrote;
  const shown = report.sample.join(', ');
  const more = report.total > report.sample.length ? `, …(+${report.total - report.sample.length})` : '';
  return (
    `${wrote}\n⚠ PARTIAL: ${report.total} file(s) from the source were NOT installed (${shown}${more}). ` +
    `If the skill's instructions reference those files or scripts, they are missing — say so instead of ` +
    `assuming the skill is fully functional.`
  );
}

export const searchSkillsTool: Tool = {
  name: 'searchSkills',
  description:
    'Search the skill marketplace (aggregator over git/URL + clawhub) for installable skills. ' +
    'Returns candidates with their sourceId + identifier to pass to installSkillFromRegistry. ' +
    'For git, the identifier is a GitHub "owner/repo[:path][@ref]", a github blob URL, or a raw SKILL.md URL.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query. For clawhub: keywords. For git: a GitHub "owner/repo[:path]", a github.com blob URL, ' +
          'or a raw SKILL.md URL (returned as a single candidate).',
      },
      limit: { type: 'number', description: 'Max results per source (default 10).' },
    },
    required: ['query'],
  },
  capability: 'read',
  domain: 'network',

  async execute(params) {
    try {
      const query = String(params.query ?? '').trim();
      if (!query) return { success: false, output: '', error: 'searchSkills: query is required' };
      const limit = typeof params.limit === 'number' ? params.limit : 10;
      const { results, warnings } = await searchAll(query, limit);

      if (results.length === 0) {
        const warn = warnings.length ? `\n(warnings: ${warnings.join('; ')})` : '';
        return { success: true, output: `No skills found for "${query}".${warn}` };
      }

      const lines = results.map((m) => {
        const v = m.version ? ` v${m.version}` : '';
        return `• ${m.name}${v} [${m.sourceId}/${m.trust}] — ${m.description}\n  install: installSkillFromRegistry({ sourceId: "${m.sourceId}", identifier: "${m.slug}" })`;
      });
      const warn = warnings.length ? `\n\n⚠ source warnings: ${warnings.join('; ')}` : '';
      return { success: true, output: `Found ${results.length} skill(s):\n\n${lines.join('\n\n')}${warn}` };
    } catch (e) {
      return { success: false, output: '', error: `searchSkills failed: ${(e as Error).message}` };
    }
  },
};

export const installSkillFromRegistryTool: Tool = {
  name: 'installSkillFromRegistry',
  description:
    'Install a skill found via searchSkills into the local library (.philont/skills/). Runs a safety scan ' +
    'and a trust×verdict gate first. If the result is "ask" (a community skill with a caution-level scan), ' +
    'get the user\'s explicit confirmation, then call again with confirm:true. Community skills with a ' +
    'dangerous scan are blocked and cannot be installed. After install the skill is usable immediately.',
  schema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source id from searchSkills (e.g. "git" or "clawhub").' },
      identifier: { type: 'string', description: 'Identifier/slug from searchSkills.' },
      name: { type: 'string', description: 'Optional install name override ([a-z0-9_-]).' },
      confirm: { type: 'boolean', description: 'Set true ONLY after the user has confirmed an "ask"-gated install.' },
    },
    required: ['sourceId', 'identifier'],
  },
  capability: 'write',
  domain: 'self',

  async execute(params) {
    try {
      const sourceId = String(params.sourceId ?? '');
      const identifier = String(params.identifier ?? '');
      if (!sourceId || !identifier) {
        return { success: false, output: '', error: 'installSkillFromRegistry: sourceId and identifier are required' };
      }
      const outcome = await installFromSource({
        sourceId,
        identifier,
        name: params.name ? String(params.name) : undefined,
        confirm: params.confirm === true,
        actor: 'agent',
        now: new Date().toISOString(),
      });

      switch (outcome.status) {
        case 'installed':
          return {
            success: true,
            output:
              `📥 Installed "${outcome.name}" (${outcome.sourceTag}, scan: ${outcome.verdict}). It is usable now.` +
              partialInstallNotice(outcome.notInstalled, outcome.installedFiles),
          };
        case 'ask': {
          const hits = formatHits(outcome.report?.hits);
          return {
            success: true,
            output:
              `⚠ "${outcome.name}" is a community skill with a ${outcome.verdict} scan and needs confirmation before install.\n` +
              `Scan findings: ${hits}` +
              partialInstallNotice(outcome.notInstalled) +
              `\nAsk the user to confirm, then call installSkillFromRegistry again with confirm:true.`,
          };
        }
        case 'blocked': {
          const hits = formatHits(outcome.report?.hits);
          return { success: false, output: '', error: `Blocked: "${outcome.name}" failed the safety gate (${outcome.verdict}). Findings: ${hits}` };
        }
        default:
          return { success: false, output: '', error: outcome.error ?? 'install failed' };
      }
    } catch (e) {
      return { success: false, output: '', error: `installSkillFromRegistry failed: ${(e as Error).message}` };
    }
  },
};
