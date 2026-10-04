/**
 * Skill safety scan (2026-10-04) — a pattern gate on SELF-AUTHORED skill text.
 *
 * Why: *Practice Makes Unsafe: Skill Misevolution in Self-Improving LLM Agents* (arXiv 2608.12851) found
 * that all 21 evolved agent configurations (4 frameworks × 6 evolution methods) authored unsafe artifacts on a
 * stream that interleaves malicious and benign tasks, that 15 of them carried the harm into fresh sessions, and that
 * the carried-over attack success rate was 16.0% even without malicious exposure and 35.3% after one block of three; their SafeEvolve wrapper
 * (a check at skill authoring + reuse) cut harm by 26.7 / 17.3 points. philont writes skills from reflection,
 * from the extractor and from the self-repair driver, and none of those paths had a check — only externally
 * installed skills pass `skill_install_boundary`. This module is that check for the self-authored paths.
 *
 * Scope: a short list of patterns whose presence in a recipe's action template is never what a learned
 * skill should encode — destructive filesystem/disk commands, remote-code-to-shell, privilege escalation,
 * credential exfiltration, disabling the product's own safety gates, covering tracks. Deliberately narrow:
 * a false quarantine costs a skill the owner may have wanted; a miss costs what the paper measured. It is
 * a gate, not a classifier — ordinary shell (`rm -rf ./build`, `git push`) passes.
 *
 * Pure. `PHILONT_SKILL_SAFETY_SCAN=0/off/false/no` disables (default ON). Externally imported skills are
 * exempt (`SkillInput.safetyScan: false`), their boundary is `skill_install_boundary.ts`.
 */

export interface SkillSafetyHit {
  /** short machine label of the pattern family */
  rule: string;
  /** the first matching excerpt (≤ 80 chars) */
  excerpt: string;
}

const RULES: { rule: string; re: RegExp }[] = [
  // destructive filesystem / disk
  { rule: 'destructive_rm', re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\/\*|\/home\b|\/etc\b|\/usr\b|\/var\b|\*)(\s|$)/ },
  { rule: 'disk_wipe', re: /\b(mkfs(\.\w+)?|dd\s+[^|\n]*of=\/dev\/(sd|nvme|hd|disk)|shred\s+[^|\n]*\/dev\/)/ },
  { rule: 'fork_bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { rule: 'world_writable_root', re: /\bchmod\s+(-R\s+)?(777|a\+rwx)\s+\/(\s|$)/ },
  { rule: 'kill_all', re: /\bkill\s+-9\s+-1\b|\bshutdown\b|\breboot\b|\binit\s+0\b/ },
  // remote code straight into a shell
  { rule: 'pipe_to_shell', re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/ },
  // privilege escalation: only sudo wrapping a destructive/irreversible command. A bare `sudo <cmd>` is ordinary
  // administration (2026-10-05: the first real-model rounds quarantined a legitimate "verify as a non-member with
  // `sudo -u outsider ls`" skill — a false positive on an OS-administration task set).
  { rule: 'sudo_destructive', re: /\bsudo\s+(-\S+\s+)*(rm\s+-[a-zA-Z]*[rf]|mkfs|dd\s|chmod\s+(-R\s+)?777\s+\/|shutdown|reboot|userdel\s+-r\s+root|passwd\s+root)/ },
  // credential exfiltration: reading secrets AND sending them out, or sending env/keys
  { rule: 'cred_exfil', re: /(\.ssh\/id_[a-z0-9]+|\/etc\/shadow|\.aws\/credentials|\.env\b|ANTHROPIC_API_KEY|OPENAI_API_KEY)[^\n]*\|\s*(curl|wget|nc|ncat)\b|\b(curl|wget)\b[^\n]*(--data|-d|-F|--upload-file|-T)\s*[^\n]*(\.ssh\/|\.env\b|API_KEY|\/etc\/shadow)/ },
  // turning off the product's own gates
  { rule: 'disable_safety_gate', re: /PHILONT_(HONESTY|SAFETY|CONSCIENCE|VIABILITY|GUARD|AUTONOMOUS_BLACKLIST)[A-Z_]*\s*=\s*(0|off|false|no)\b|--no-verify\b|--dangerously-skip-permissions\b/i },
  // covering tracks: shell history, or the SYSTEM logs (auth/syslog/wtmp/…) or a wildcard under /var/log. Removing a
  // named application file under /var/log is ordinary work (2026-10-05 false positive: `rm -f /var/log/chsh_failure`).
  { rule: 'cover_tracks', re: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\b(rm|truncate|shred)\b[^\n]*(\.bash_history|\/var\/log\/\*|\/var\/log\/(auth\.log|syslog|messages|secure|wtmp|btmp|lastlog|journal)\b|\/var\/log\s|\/var\/log$)/ },
];

/** Scan one or more text fields; the first hit wins. Null = clean. */
export function scanSkillSafety(texts: ReadonlyArray<string | null | undefined>): SkillSafetyHit | null {
  for (const t of texts) {
    if (!t) continue;
    for (const { rule, re } of RULES) {
      const m = re.exec(t);
      if (m) return { rule, excerpt: m[0].slice(0, 80) };
    }
  }
  return null;
}

/** Default ON; only an explicit off-ish value disables. */
export function skillSafetyScanEnabled(): boolean {
  const v = (process.env.PHILONT_SKILL_SAFETY_SCAN ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export const SKILL_SAFETY_RULE_IDS: readonly string[] = RULES.map((r) => r.rule);
