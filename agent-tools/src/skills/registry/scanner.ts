/**
 * SKILL.md content safety scanner (heuristic, regex-based; ported from the hermes skills-guard categories).
 *
 * Purpose: the "trusted" half of the marketplace. installSkill itself does NO content audit — it only
 * validates name/size/path-traversal. This scanner gives the install gate a verdict so unvetted skills
 * from community sources can't silently land code that exfiltrates secrets, runs arbitrary commands, or
 * persists itself.
 *
 * IMPORTANT — this is a HEURISTIC, not a sandbox. A SKILL.md legitimately contains shell snippets as
 * instructions, so this WILL false-positive on devops/automation skills. That is why it feeds a gate
 * that defaults to `ask` (not silent block) for community-caution; the real safety net remains the
 * runtime capability/policy layer (agent-policy + e-stop) when the skill actually executes anything.
 */

import type { ScanHit, ScanReport, Verdict } from './types.js';

/** Category union, derived from ScanHit so it stays in sync with types.ts. */
type Category = ScanHit['category'];

interface Rule {
  category: Category;
  re: RegExp;
  /** Human-readable label for the report. */
  label: string;
}

// Patterns are intentionally conservative-leaning toward detection. Case-insensitive where sensible.
const RULES: Rule[] = [
  // ── exfiltration ──────────────────────────────────────────────
  { category: 'exfiltration', re: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i, label: 'pipe remote script to shell' },
  { category: 'exfiltration', re: /\b(curl|wget|fetch)\b[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i, label: 'send credential env var over network' },
  { category: 'exfiltration', re: /(printenv|env)\b[^\n|]*\|\s*(curl|wget|nc|ncat)/i, label: 'dump environment to network' },
  { category: 'exfiltration', re: /\b(curl|wget)\b[^\n]*(~\/\.ssh|\/etc\/passwd|~\/\.aws|id_rsa)/i, label: 'upload sensitive file' },
  { category: 'exfiltration', re: /\b(nc|ncat|netcat)\b\s+(-[a-z]*\s+)*[\w.-]+\s+\d+/i, label: 'raw netcat connection' },

  // ── rce ───────────────────────────────────────────────────────
  { category: 'rce', re: /\brm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i, label: 'destructive rm -rf on root/home' },
  { category: 'rce', re: /:\(\)\s*\{\s*:\s*\|\s*:&?\s*\}\s*;:/i, label: 'fork bomb' },
  { category: 'rce', re: /\bos\.system\s*\(/i, label: 'os.system() shell exec' },
  { category: 'rce', re: /\bsubprocess\.(Popen|call|run|check_output)\s*\(/i, label: 'subprocess exec' },
  { category: 'rce', re: /\bchild_process\b|\b(exec|execSync|spawn|spawnSync)\s*\(/i, label: 'node child_process exec' },
  { category: 'rce', re: /\beval\s*\(|\bnew\s+Function\s*\(/i, label: 'dynamic eval' },

  // ── persistence ───────────────────────────────────────────────
  { category: 'persistence', re: /\bcrontab\b|\/etc\/cron|\bcron\.d\b/i, label: 'cron persistence' },
  { category: 'persistence', re: />>?\s*~?\/?\.?(bashrc|zshrc|profile|bash_profile)\b/i, label: 'shell rc file write' },
  { category: 'persistence', re: /\b(launchctl|systemctl\s+enable|systemd)\b/i, label: 'service/daemon registration' },
  { category: 'persistence', re: />>?\s*[^\n]*authorized_keys/i, label: 'authorized_keys write' },

  // ── obfuscation ───────────────────────────────────────────────
  { category: 'obfuscation', re: /[A-Za-z0-9+/]{200,}={0,2}/, label: 'long base64 blob' },
  { category: 'obfuscation', re: /\batob\s*\(|\bfromCharCode\b|\bbase64\.b64decode\b/i, label: 'base64 decode-and-run pattern' },
  { category: 'obfuscation', re: /(\\x[0-9a-f]{2}){8,}|(\\u[0-9a-f]{4}){6,}/i, label: 'hex/unicode escape run' },

  // ── secret_access ─────────────────────────────────────────────
  { category: 'secret_access', re: /\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)\b/, label: 'AWS credential reference' },
  { category: 'secret_access', re: /(~\/\.aws\/credentials|~\/\.npmrc|~\/\.netrc|\.git-credentials)\b/i, label: 'credential file read' },
  { category: 'secret_access', re: /\bsecurity\s+find-generic-password\b|\bkeychain\b/i, label: 'keychain access' },
  { category: 'secret_access', re: /process\.env\.[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD)/i, label: 'read secret env var' },
];

/** Severity weight per category for verdict mapping. */
const DANGEROUS: ReadonlySet<Category> = new Set<Category>(['exfiltration', 'rce', 'persistence']);

/**
 * Scan a SKILL.md content string and return a verdict + hits.
 *
 * Verdict mapping:
 *   - any exfiltration / rce / persistence hit → 'dangerous'
 *   - only obfuscation / secret_access hits   → 'caution'
 *   - no hits                                 → 'safe'
 */
export function scanSkillContent(content: string): ScanReport {
  const hits: ScanHit[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      // RegExp without the global flag → test from the start each time; safe to reuse.
      if (rule.re.test(line)) {
        hits.push({
          category: rule.category,
          pattern: rule.label,
          line: i + 1,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }

  let verdict: Verdict = 'safe';
  if (hits.some((h) => DANGEROUS.has(h.category))) verdict = 'dangerous';
  else if (hits.length > 0) verdict = 'caution';

  return { verdict, hits };
}
