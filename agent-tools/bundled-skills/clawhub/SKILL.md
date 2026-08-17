---
name: clawhub
description: Discover, install, and uninstall skills from the ClawHub public skill registry (clawhub.ai), internalizing community knowledge as my own capabilities.
when_to_use: User mentions ClawHub / the public skill registry / community skills; agent notices "no local skill available but the community might have one" and wants to search; user says "check if ClawHub has X" / "install a skill to handle X"
version: 2.0.0
---

# ClawHub Skill Registry

## When to Use

- The user's request has no ready-made skill available to me, but it matches a publicly reusable pattern ("k8s manifest validation" / "Postgres backup" / "GitHub PR review", etc.)
- User explicitly says: "find/install/uninstall a ClawHub skill" / "see if ClawHub has X"
- I've repeatedly run into the same type of problem and realize I need more systematic domain guidance

## What ClawHub Is

ClawHub is OpenClaw's public skill registry (clawhub.ai). All skills are public, versioned bundles.
philont reaches it through the `clawhub` CLI, installed with `npm i -g clawhub`.

## Go through the marketplace tools, not the CLI

Use `searchSkills` / `installSkillFromRegistry` (see the `skill-marketplace` skill). They shell out to
the same CLI, but they also:

- run the safety scanner over **every file in the bundle** and apply the trust × verdict gate;
- record provenance (source tag, content hash, who confirmed) in `.philont/skills.lock.json` plus an
  audit line;
- report which files of the bundle were **not** installed.

Calling `clawhub install` yourself through `shell` skips all three. That is the same mistake as calling
a CLI directly to get around a native tool's guardrails: do not do it. If a user explicitly asks to run
the raw CLI, say what protection they are giving up first.

```
searchSkills({ query: "k8s yaml validate" })
installSkillFromRegistry({ sourceId: "clawhub", identifier: "@publisher/slug" })
```

Identifiers are `@publisher/slug` (clawhub's canonical form), optionally with `@version` appended.

## Results

- `installed` → usable immediately. Check the reported file count and the "PARTIAL" line: a clawhub
  package is usually ~25 files and the install budget may have left some out.
- `ask` → community skill with a caution-level scan. Show the user the findings, get explicit
  confirmation, call again with `confirm: true`.
- `blocked` → dangerous patterns somewhere in the bundle. The current UI and local API cannot safely
  prove human presence, so neither exposes an override. Report the findings; do not look for a
  workaround or direct the user to a button that does not exist.

## Uninstall

```
uninstallSkill({ name: "<name>" })
```

Deletes the whole `.philont/skills/<name>/` directory; the reload-prune path clears the SkillStore row.
Do not call `clawhub uninstall` (it edits `.clawhub/lock.json`, which philont does not read).

## If the CLI is missing

`searchSkills` will say so in its warnings. Tell the user to run `npm i -g clawhub`, or to set
`PHILONT_CLAWHUB_BIN` to its absolute path if it is installed somewhere off PATH. Note that philont
detects the CLI by looking for the executable itself, so an error saying "not found on PATH" means
exactly that — it is not a version-flag problem.
