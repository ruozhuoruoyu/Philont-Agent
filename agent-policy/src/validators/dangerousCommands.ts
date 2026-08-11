/**
 * DangerousCommandValidator — dangerous shell command detection
 *
 * Regex-based pattern matching: a hit either denies the command or requires a grant.
 * Applies to the command field of shell / process tools.
 *
 * Reference: Hermes-Agent project tools/approval.py::DANGEROUS_PATTERNS
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny, requireGrant } from './types.js';

export interface DangerousCommandPattern {
  /** Identifier (used in audit logs) */
  id: string;
  /** Pattern regex */
  regex: RegExp;
  /** Description (used in error messages) */
  description: string;
  /** Default action: deny = hard reject, grant = require a temporary authorisation */
  defaultAction: 'deny' | 'grant';
}

/** Default dangerous patterns (extended from the hermes list) */
export const DEFAULT_DANGEROUS_PATTERNS: DangerousCommandPattern[] = [
  // Recursive delete on root path
  {
    id: 'rm_recursive_root',
    regex: /\brm\s+(-[a-zA-Z]*)*[rRf]+[a-zA-Z]*\s+(-[^\s]*\s+)*(\/|~|\$HOME|\*)(\s|$)/,
    description: 'recursive delete on root/home/wildcard',
    defaultAction: 'deny',
  },
  {
    id: 'rm_rf_dotall',
    regex: /\brm\s+-rf\s+\.\*/,
    description: 'delete dotfiles with wildcard',
    defaultAction: 'grant',
  },

  // Overly permissive chmod
  {
    id: 'chmod_world_write',
    regex: /\bchmod\s+(-[^\s]*\s+)*(777|666|a\+[rwx]*w|o\+[rwx]*w)\b/,
    description: 'world/other-writable permissions',
    defaultAction: 'grant',
  },
  {
    id: 'chmod_recursive_777',
    regex: /\bchmod\s+-R\s+[0-7]*7[0-7]*\b/,
    description: 'recursive chmod 7xx',
    defaultAction: 'grant',
  },

  // Filesystem format / block device
  {
    id: 'mkfs',
    regex: /\bmkfs(\.\w+)?\s+/,
    description: 'filesystem format',
    defaultAction: 'deny',
  },
  {
    id: 'dd_device',
    regex: /\bdd\s+(if|of)=\/dev\//,
    description: 'dd on block device',
    defaultAction: 'deny',
  },

  // Remote code execution (pipe-to-shell)
  {
    id: 'curl_pipe_shell',
    regex: /\bcurl\b[^|\n]*\|\s*(ba)?sh\b/,
    description: 'curl ... | sh',
    defaultAction: 'grant',
  },
  {
    id: 'wget_pipe_shell',
    regex: /\bwget\b[^|\n]*\|\s*(ba)?sh\b/,
    description: 'wget ... | sh',
    defaultAction: 'grant',
  },
  {
    id: 'base64_pipe_shell',
    regex: /\bbase64\b[^|\n]*-[dD][^|\n]*\|\s*(ba)?sh\b/,
    description: 'base64 decode | sh',
    defaultAction: 'deny',
  },
  {
    id: 'eval_curl',
    regex: /\beval\s+["'`]?\$?\(\s*curl\b/,
    description: 'eval $(curl ...)',
    defaultAction: 'deny',
  },

  // fork bomb
  {
    id: 'fork_bomb',
    regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    description: 'fork bomb',
    defaultAction: 'deny',
  },

  // System halt / reboot
  {
    id: 'kill_all',
    regex: /\bkill\s+-9\s+-1\b/,
    description: 'kill all processes',
    defaultAction: 'deny',
  },
  {
    id: 'shutdown',
    regex: /\b(shutdown|halt|poweroff|reboot)\s+/,
    description: 'shutdown/reboot',
    defaultAction: 'grant',
  },
  {
    id: 'systemctl_stop',
    regex: /\bsystemctl\s+(stop|disable|mask)\s+/,
    description: 'disable system services',
    defaultAction: 'grant',
  },

  // Writes to sensitive paths
  {
    id: 'write_etc',
    regex: /(>|tee\b[^|]*)\s*\/etc\//,
    description: 'write to /etc/',
    defaultAction: 'deny',
  },
  {
    id: 'write_ssh',
    regex: /(>|tee\b[^|]*)\s*[~$][^\/]*\/\.ssh\//,
    description: 'write to ~/.ssh/',
    defaultAction: 'deny',
  },
  {
    id: 'write_boot',
    regex: /(>|tee\b[^|]*)\s*\/boot\//,
    description: 'write to /boot/',
    defaultAction: 'deny',
  },

  // Credential exfiltration (common patterns)
  {
    id: 'cat_env_to_network',
    regex: /\bcat\s+[^|]*\.env[^|]*\|\s*(curl|nc|wget)\b/,
    description: 'cat .env | curl (exfil)',
    defaultAction: 'deny',
  },
  {
    id: 'ssh_key_to_network',
    regex: /\bcat\s+[^|]*\.ssh\/[^|]*\|\s*(curl|nc|wget)\b/,
    description: 'cat .ssh/... | curl (exfil)',
    defaultAction: 'deny',
  },

  // sudo privilege escalation
  {
    id: 'sudo_destructive',
    regex: /\bsudo\s+(rm|dd|mkfs|chmod|chown)\b/,
    description: 'sudo + destructive command',
    defaultAction: 'grant',
  },

  // User account management
  {
    id: 'user_management',
    regex: /\b(userdel|passwd|usermod)\s+/,
    description: 'user account manipulation',
    defaultAction: 'grant',
  },

  // Filesystem mount / unmount
  {
    id: 'mount_unmount',
    regex: /\b(mount|umount)\s+/,
    description: 'filesystem mount/unmount',
    defaultAction: 'grant',
  },

  // Network tools
  {
    id: 'nc_listen',
    regex: /\bnc\s+(-[^\s]*\s+)*-l\s/,
    description: 'netcat listen',
    defaultAction: 'grant',
  },

  // Kernel parameters
  {
    id: 'sysctl_write',
    regex: /\bsysctl\s+-w\b/,
    description: 'kernel parameter modification',
    defaultAction: 'grant',
  },

  // Destructive Git operations
  {
    id: 'git_force_push',
    regex: /\bgit\s+push\s+(-[^\s]*\s+)*(--force|-f)\b/,
    description: 'git force push',
    defaultAction: 'grant',
  },
  // PUBLISHING IS ITS OWN DECISION, AND ORDINARY `git push` IS THE ONE THAT PUBLISHES.
  //
  // Only force-push was listed here, as if the risk were losing history. On 2026-08-10 a plain
  // `git push` put 902 files on a public repository in one commit: a GitHub token, the agent's
  // private journals, page captures, the owner's documents and a run's whole output tree. Nothing
  // was overwritten and nothing was forced. The act that could not be taken back was the ordinary
  // one — and it ran under a shell approval given for something else half an hour earlier.
  //
  // Local git stays free: staging, committing, branching, rebasing are all reversible and none of
  // them leave the machine. What needs its own yes is the step that does. A compound
  // `git add -A && git commit && git push` matches here too, since the pattern is tested against
  // the whole command line.
  {
    id: 'git_push',
    regex: /\bgit\s+(?:-[^\s]+\s+)*push\b/,
    description: 'git push — publishes commits to a remote',
    defaultAction: 'grant',
  },
  // pathAcl already refuses these paths to the FILE tools; `cat` is not a file tool. Only the piped
  // form (cat .env | curl) was covered, as though the danger were the pipe. Reading a credential into
  // the context window is the same disclosure with a slower second step.
  {
    id: 'credential_file_read',
    regex: /\b(?:cat|less|more|head|tail|base64|xxd|strings)\s+[^|&;]*(?:\btokens?\b|\bcredentials?\b|\.netrc\b|id_(?:rsa|ed25519|ecdsa)\b|\.pem\b)/i,
    description: 'reading a credential file into context',
    defaultAction: 'grant',
  },
  {
    id: 'git_remote_write',
    regex: /\bgit\s+(?:-[^\s]+\s+)*remote\s+(?:add|set-url)\b/,
    description: 'git remote add/set-url — changes where a push would go',
    defaultAction: 'grant',
  },
  {
    id: 'git_credential_config',
    regex: /\bgit\s+config\b[^\n]*credential/i,
    description: 'git credential configuration — stores or redirects push credentials',
    defaultAction: 'grant',
  },
  {
    id: 'git_reset_hard',
    regex: /\bgit\s+reset\s+(-[^\s]*\s+)*--hard\b/,
    description: 'git reset --hard',
    defaultAction: 'grant',
  },
  {
    id: 'git_clean_fdx',
    regex: /\bgit\s+clean\s+(-[^\s]*\s+)*[fdxFDX]{2,}\b/,
    description: 'git clean -fdx',
    defaultAction: 'grant',
  },
];

const DEFAULT_COMMAND_TOOLS = new Set(['shell', 'process']);
const DEFAULT_COMMAND_FIELDS = ['command'];

/**
 * The same match the validator makes, available to whoever has to ACT on it.
 *
 * A require-grant answer is only half a mechanism: something must then issue a grant of the right
 * shape, and a tool-scope grant deliberately does not satisfy a command-scope requirement. Exporting
 * the predicate keeps the authorization path and the validator reading one list instead of two.
 */
export function findDangerousPattern(
  command: string,
  patterns: DangerousCommandPattern[] = DEFAULT_DANGEROUS_PATTERNS,
): DangerousCommandPattern | null {
  if (!command) return null;
  for (const p of patterns) {
    if (p.regex.test(command)) return p;
  }
  return null;
}

export interface DangerousCommandConfig {
  patterns?: DangerousCommandPattern[];
  toolNames?: Set<string>;
  commandFields?: string[];
  /** When true, any pattern match results in an immediate deny (grant action is ignored) */
  strict?: boolean;
}

/**
 * Create a dangerous command validator
 */
export function createDangerousCommandValidator(config: DangerousCommandConfig = {}): Validator {
  const patterns = config.patterns ?? DEFAULT_DANGEROUS_PATTERNS;
  const toolNames = config.toolNames ?? DEFAULT_COMMAND_TOOLS;
  const commandFields = config.commandFields ?? DEFAULT_COMMAND_FIELDS;
  const strict = config.strict ?? false;

  return (ctx: ValidatorContext) => {
    if (!toolNames.has(ctx.toolName)) return pass();

    for (const field of commandFields) {
      const cmd = ctx.params[field];
      if (typeof cmd !== 'string') continue;

      for (const p of patterns) {
        if (p.regex.test(cmd)) {
          const action = strict ? 'deny' : p.defaultAction;

          // deny: hard reject; cannot be bypassed by a grant
          if (action === 'deny') {
            return deny(
              `DANGEROUS_CMD_${p.id.toUpperCase()}`,
              `Dangerous command pattern "${p.description}" matched: ${cmd.slice(0, 100)}`,
            );
          }

          // grant: only a command-scope grant is accepted (tool-scope is insufficient)
          const hasGrant = ctx.grants?.isGranted(ctx.toolName, ctx.params, 'command');
          if (hasGrant) continue;

          return requireGrant(
            'command',
            p.regex.source,
            `Dangerous pattern "${p.description}" needs approval`,
          );
        }
      }
    }

    return pass();
  };
}
