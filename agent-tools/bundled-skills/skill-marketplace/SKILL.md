---
name: skill-marketplace
description: Find and install new skills from the marketplace (git/URL + clawhub) using searchSkills and installSkillFromRegistry.
when_to_use: When you lack a capability for the current task and want to find and install a ready-made skill, or when the user asks to add/install a skill.
metadata:
  category: meta
---

# Skill Marketplace

The marketplace is an aggregator client over external sources (git/raw-URL and clawhub). Every install
is safety-scanned and passed through a trust × verdict gate. There is no hosted platform — you are pulling
skills from sources you (or the user) point at.

## When to Use
- You hit a task you can't do well and a ready-made skill likely exists.
- The user asks to install / add a skill, or gives you a GitHub repo or SKILL.md URL.

## Instructions

1. **Search** with `searchSkills({ query })`:
   - clawhub keywords, e.g. `searchSkills({ query: "kubernetes yaml lint" })` — results come back as
     `@publisher/slug` identifiers.
   - a GitHub identifier `owner/repo[:path][@ref]`, a `github.com/.../blob/...` URL, or a raw `SKILL.md` URL —
     these resolve to a single candidate.
   Each result shows `sourceId`, an identifier, a trust level, and a description.

2. **Install** with `installSkillFromRegistry({ sourceId, identifier })` using the values from a search result.
   - `installed` → the skill is usable immediately (it appears in your skill index next turn).
   - `ask` → it is a community skill with a caution-level scan. **Show the user the scan findings and get their
     explicit confirmation**, then call again with `confirm: true`.
   - `blocked` → the scan found dangerous patterns (exfiltration / RCE / persistence) somewhere in the bundle.
     You cannot install it and you cannot override the gate — only the user can, from the Skills page in the
     web UI, after reading the findings. Report the findings and let them decide; do not look for a way around.

3. **Check what actually landed.** A skill is usually a bundle (SKILL.md plus `scripts/`, `reference/`, …).
   The install result says how many files were written and lists anything it did **not** install (over the
   bundle budget, or not an installable file type). If the skill's steps reference a file that was not
   installed, say so plainly instead of pretending the skill works.

4. **Use** the new skill via `use_skill(name)`. Its output ends with a `## Files` section naming the absolute
   install directory and every companion file — read or run those by absolute path.

## Notes
- Trust: marketplace skills from git/URL and clawhub are all `community` — review them. Never paste secrets
  into a skill you fetched.
- To remove a skill, use `uninstallSkill({ name })` (this deletes the whole skill directory).
- The clawhub source needs the `clawhub` CLI installed; if it is missing, clawhub results are simply omitted
  and `searchSkills` says so in its warnings.
