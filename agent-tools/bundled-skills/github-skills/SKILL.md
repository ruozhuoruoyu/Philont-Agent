---
name: github-skills
description: Install skills directly from SKILL.md files in any GitHub repository, covering the long tail beyond ClawHub.
when_to_use: User provides a GitHub repo URL and asks to "install an X skill"; user says "check if there's a skill for X on GitHub"; no suitable skill found locally or on clawhub, need to search the GitHub long tail
version: 2.0.0
---

# GitHub as Skill Source

## When to Use

- clawhub search finds nothing suitable, but I believe GitHub has something
- User gave a GitHub URL to install ("install this repo's skill: https://github.com/foo/bar")
- Looking for "niche but excellent" domain skills (many personal projects only publish to GitHub)

## Install through the marketplace tools

`installSkillFromRegistry({ sourceId: "git", identifier })` handles the whole path: fetch, pin the
commit sha, pull the companion files, scan the bundle, apply the gate, record provenance. Do NOT
hand-assemble a raw URL, fetch it with `http` and write it with `installSkill` — that route silently
installs a single markdown file with no scan, no provenance, and none of the `scripts/` the skill needs.

Accepted identifiers:

| Form | Example |
| --- | --- |
| shorthand | `anthropics/skills:skills/pdf/SKILL.md` |
| shorthand, default path | `owner/repo` (looks for `SKILL.md` at the repo root) |
| pinned ref | `owner/repo:path/SKILL.md@v1.2.0` |
| blob URL | `https://github.com/owner/repo/blob/main/skills/x/SKILL.md` |
| raw URL | `https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md` |

```
installSkillFromRegistry({ sourceId: "git", identifier: "anthropics/skills:skills/pdf/SKILL.md" })
```

## Finding candidates

`searchSkills` cannot keyword-search GitHub (there is no index to query) — it only resolves an
identifier you already have. To hunt, use `webSearch` for the repo, or `gh search code '<topic>
path:**/SKILL.md'` via `shell` if the `gh` CLI is authenticated. Then install through the tool above.

## Reading the result

- `installed` → the reply says how many files were written. Most real skills are bundles: `skills/pdf`
  in anthropics/skills is 12 files including 8 python scripts.
- `PARTIAL` line → those files were **not** installed (over the bundle budget, or a binary type such as
  fonts/images). If the skill's steps reference one of them, say so rather than assuming it works.
- `ask` / `blocked` → scan verdict; see the `skill-marketplace` skill for how to handle each.
- Size error → the SKILL.md is over philont's per-skill limit; the error names the env var that raises it.

## Provenance

The source tag is `github:<owner>/<repo>@<sha7>` when the commit can be resolved. Unauthenticated
GitHub API access is capped at 60 requests/hour; past that the pin degrades to the mutable ref and a
warning is logged. Set `PHILONT_GITHUB_TOKEN` to raise the limit (and to reach private repos).

## Uninstall

```
uninstallSkill({ name: "<name>" })
```

Deletes the whole skill directory, companions included.
