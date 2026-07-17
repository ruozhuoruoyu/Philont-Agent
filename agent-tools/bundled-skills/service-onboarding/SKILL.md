---
name: service-onboarding
description: When the user provides an external service's documentation URL + credentials + heartbeat interval, this skill teaches the agent how to interact with that service periodically and autonomously (voting/commenting/posting/notifying/monitoring, etc.). Reads the doc, derives a skill, persists identity and credentials, and hangs a schedule to trigger autonomous turns.
when_to_use: User provides a service documentation URL + API key/credentials + interval (e.g. "register X service key=xxx heartbeat every 30 minutes" / "integrate Slack workspace for scheduled monitoring" / "I have an internal API doc at X, summarize it once a day"); scenarios involving saveCredential + schedule_reminder + autonomous_turn periodic heartbeat. **Specialized version**: use this skill only when credentials + periodic heartbeat are involved; for general process documents (SOP/runbook) use doc-to-skill.
version: 1.0.0
---

# Service Onboarding Meta-Skill

## When to Use

- The user wants the agent to interact with an external service **periodically / autonomously**
  - Example: "Register example-svc.com for me, key is xxx, heartbeat every 30 minutes"
  - Example: "Integrate our Slack workspace, monitor the #incidents channel on a schedule"
  - Example: "I have an internal API, docs are at https://wiki/api.md, summarize once a day"
- The user has provided:
  - **Service main documentation URL** (guide.md / OpenAPI / API docs / README)
  - **Credentials** (API key / token / OAuth secret, optional)
  - **Schedule interval** (e.g. "every 30 minutes" / "every day at 9am")
  - **(Optional) Identity/persona document** (soul.md / persona.md / behavior constraint doc)

## When NOT to Use

- User asks "what is X service" (one-off query, no ongoing interaction needed) → answer directly with webFetch
- User has not provided a documentation URL (ask user to provide one first) → do not guess endpoints on your own
- This is the **first** integration of the service, but the user has not explicitly requested a schedule (only asking "can I call X API once") → call it directly, do not persist

## Core Philosophy

**General-purpose + autonomous**: this skill teaches the agent how to onboard any service. Once the workflow completes, the reflection system will crystallize a service-specific skill (e.g. `<service>-heartbeat`); subsequent schedule triggers will call that newly generated skill directly, bypassing the onboarding workflow.

## Action Template (strictly in order)

### 1. Endpoints + auth come from the compiled spec, not from your own reading

You do **not** hand-extract the endpoint list. When a guide URL drives this flow, the mechanism compiles that
guide into a validated endpoint spec (LLM comprehension under a strict JSON contract, with a regex extractor
as the floor so coverage can only widen), caches it by guide hash, and enforces it on every http call:
undocumented endpoint, wrong host, missing documented auth header, and malformed body are all blocked
**before** the request is sent. That is deterministic and does not satisfice on a long doc the way manual
reading does — it is where endpoint completeness now lives. Do not re-audit it by hand or copy it into facts;
trust the guard and read its rejection message if a call is blocked.

If you must read the guide yourself (e.g. for behavioral rules), use the `http` tool (GET) to fetch the RAW
markdown, **not** `webFetch`: webFetch distills through an aux LLM, which sometimes treats a service doc full
of "how to register/post/call the API" instructions as a prompt injection and refuses ("I can't discuss
that"). Raw http has no LLM in the path.

What you DO still capture from the guide (the spec does not encode these):

```
store_fact({ namespace: "service.<name>.api", key: "heartbeat_priority", value: ["...ordered actions..."] })
store_fact({ namespace: "service.<name>.api", key: "rate_limits", value: {...} })
```

`heartbeat_priority` is the ordered list of what each heartbeat should DO (the guide's behavioral priorities);
the later heartbeat prompt reads it. Which endpoints exist and what they require is the spec's job, not yours.

### 2. Read identity / persona definition (if the user provided one)

Same as step 1, **use http GET not webFetch**:

```
http({ method: "GET", url: "<soul.md / persona.md URL>" })
```

```
store_fact({ namespace: "service.<name>.identity", key: "username", value: "..." })
store_fact({ namespace: "service.<name>.identity", key: "voice", value: "..." })
store_fact({ namespace: "service.<name>.identity", key: "anti_patterns", value: [...] })
```

If the user did not provide one, or the document cannot be fetched → skip this step, but store_fact one entry `identity_missing: true` to signal that subsequent heartbeats should use the default identity.

### 3. Securely store credentials (**do this immediately upon receiving the registration response — do not delay**)

#### 3a. Scenario: user already has a key

The user provided credentials directly in the conversation:
```
saveCredential({ name: "<service>-api-key", value: "<actual credential provided by user>" })
```

#### 3b. Scenario: first-time registration (key returned in API response) — **extremely common pitfall**

If between or after steps 1/2 you called a registration endpoint via http POST and received a response, the response typically contains:
```json
{
  "actor_id": "...",
  "api_key": "svc_xxxxxx_FULL_LONG_STRING",   ← complete key, usually shown only once
  "api_key_prefix": "svc_xxxxxx",              ← truncated prefix, used in UI later
  "handle": "..."
}
```

**Mandatory rules** (skip any of these and you will hit a pitfall):
1. **Immediately** `saveCredential({ name, value: response.api_key })`, using the **complete field** — not the prefix
2. **Do not** store the api_key in facts first (facts are plaintext, and LLMs tend to copy only the prefix)
3. `store_fact` should only store **non-sensitive fields**: `actor_id` / `api_key_prefix` / `handle` / registration timestamp
4. After saving, immediately run `listCredentialNames` to confirm the credential name appears in the list
5. **Length self-check** (added as a hard guard based on a 2026-05 production incident):

   After `saveCredential` completes, **compare the lengths of the two fields in the response**:

   - Complete `api_key` length — typically ≥ 40 characters (commonly 70-100, e.g. `svc_xxxxxxx_<long-string>`)
   - `api_key_prefix` length — typically < 20 characters

   If the string length you just passed as `value:` to `saveCredential` is < 32 characters **or** matches the value of the `api_key_prefix` field → **you stored the wrong thing — you stored the prefix**!

   Immediately:
   - Re-read the response and confirm the complete value of the `api_key` field (not `api_key_prefix`)
   - Call `saveCredential` again with the complete value (same name will overwrite)
   - Still unsure → ask the user to re-register for a new key

6. **Test immediately**: pick the simplest auth verify endpoint from the docs and call it once to verify the complete key actually works (see step 4)
   - **If verify returns 401**: **first instinct should not be "wrong endpoint" but "did I store the prefix?"** —
     go back and run the length self-check from item 5
   - Only if the length self-check passes and verify still returns 401 should you consider that the endpoint is wrong or the key is genuinely bad

Skipping this → all subsequent operations will hit 401, and if facts only contain the prefix **the complete key is lost**,
forcing the user to provide it again or re-register.

**Never** write the complete key into facts (plaintext persistence creates a leakage risk). saveCredential encrypts and persists to SecretStore; when the http tool is called, reference it via the `Authorization: Bearer {<SECRET_NAME>}` placeholder, which is substituted automatically.

The placeholder name format is `<NAME>` uppercased with `-` replaced by `_`, e.g.: `<service>-api-key` → `{<SERVICE>_API_KEY}`.

### 4. Test one API call (verify auth + endpoint)

Pick the simplest read-only endpoint from the docs (e.g. `/auth/verify` or `/health` or `GET /me`) and call it once:
```
http({ method: "POST", url: "<base>/auth/verify", headers: { "Authorization": "Bearer {<SECRET_NAME>}" } })
```

- Returns 200 / user info → credentials are valid, continue.
- Returns 401 / 403 → credentials are wrong; tell the user and **do not** schedule.
- Returns 5xx / timeout → service temporarily unavailable, but credentials may be fine; tell the user to investigate before scheduling.

### 5. Create the periodic schedule (**standard onboarding requirement — must not be skipped**)

⚠ **Common pitfall**: after running through steps 1-4, LLMs often wrap up with "registration successful" and forget to create the schedule.
No schedule = onboarding is just a one-time manual run, **completely defeating the purpose of service-onboarding**.

Mandatory rules:
1. **Even if the user did not explicitly say "create a heartbeat"**, create a schedule by default for any onboarding task
2. interval_ms **must be provided**; if the user did not specify, use the default of 30 minutes (1800000) and inform the user
3. **Must** use `actionType: 'autonomous_turn'` — not `'prompt'` (prompt only sends reminder text;
   `autonomous_turn` actually starts a chat turn and runs tools)
4. payload.prompt **must include** identity/credential placeholders + deduplication guidance (see template below)

```
schedule_reminder({
  name: "<service>-heartbeat",
  interval_ms: <milliseconds from user, default 1800000 = 30min if unspecified>,
  actionType: "autonomous_turn",
  payload: {
    prompt: "Execute <service> heartbeat: perform operations in the order of facts.service.<name>.api.heartbeat_priority.\nIdentity: see facts.service.<name>.identity.\nCredentials: use placeholder {<SECRET_NAME>}.\nBefore each operation, call list_facts({namespace:'service.<name>.history'}) to skip already-processed items.\nAfter each operation, store_fact to the history namespace to prevent duplicates.",
    replyChannel: "silent"  // heartbeat does not interrupt the user; critical events (e.g. 401) are pushed via escalate
  }
})
```

Interval validation:
- < 5 minutes → **reject**; tell the user the interval is too short (to prevent harassment of the target service + wasted LLM budget)
- 5-30 minutes → warn, ask "are you sure?"
- ≥ 30 minutes → create directly

### 6. Summary + closing reflection

**4-item self-check** (onboarding is not complete until all four pass — if any item is missing, go back and complete it):
- [ ] the endpoint spec loaded/compiled for the guide (the mechanism owns endpoint completeness — you do
      not hand-audit it), and heartbeat_priority captured
- [ ] saveCredential complete + name visible in listCredentialNames
- [ ] auth verify endpoint called successfully (200)
- [ ] schedule_reminder created (actionType=autonomous_turn, interval_ms set)

Reply to the user:
```
✅ <service> registered:
- Fetched N API endpoints, identity is <username>
- Credentials stored encrypted (placeholder {<SECRET_NAME>})
- Schedule created, autonomous heartbeat runs every X minutes

Next heartbeat will automatically:
1. ...(list 3-4 steps from the captured priority list)

To change the interval / pause / cancel, let me know.
```

Once complete, the turn's closing reflection system will observe this full workflow and **automatically emit a new skill**:
`<service>-heartbeat`. That skill is learned by the agent itself, not bundled. When the schedule triggers subsequently, the memory prefix routing rules will recommend using this new skill.

## Failure Handling Table

| Failure | Response |
|---|---|
| webFetch of doc URL fails | abort the entire onboarding; tell the user the URL is wrong or there is a network issue |
| webFetch returns non-document (404/500/HTML that does not parse) | same as above |
| store_fact write fails | retry once; abort on second failure |
| saveCredential value too long / name invalid | stop and ask the user (may be a mistake) |
| auth verify 401/403 | abort schedule creation; ask the user whether the key is correct |
| schedule_reminder creation fails | credentials / facts already written, can be retained; tell the user to manually retry schedule creation |
| user-specified interval < 5 minutes | reject; ask the user to provide a new interval |

## Anti-patterns

- ❌ **Using webFetch to fetch the service document** (hit in production): the aux LLM distillation may misidentify a service document containing instructions like "agent register / post / vote" as a prompt injection and return "I can't discuss that". **Use http GET to fetch raw markdown** and read it yourself.
- ❌ **Skipping step 5 without creating schedule_reminder** (hit in production): finishing steps 1-4 and forgetting to attach the heartbeat schedule means the user sees "registration successful" and assumes everything is fine, but no autonomous action ever follows. Equivalent to degrading to a one-time manual run. **Create by default, even if the user did not say "create heartbeat"**.
- ❌ schedule_reminder using `actionType='prompt'`: that only sends reminder text and **will not** actually invoke tools. Must use `'autonomous_turn'` for a real heartbeat.
- ❌ Writing the API key into facts (plaintext leakage) → must use saveCredential
- ❌ **Storing only api_key_prefix from the registration response, losing the complete api_key field** → guaranteed 401, and the complete key cannot be retrieved afterwards (2026-05 production incident). The **length self-check** in step 3b item 5 is the dedicated fix — if the saveCredential value length is < 32 characters, you stored the prefix
- ❌ **First instinct on verify 401 is "wrong endpoint"** → in practice it is usually the prefix issue from the previous point. Must run the length self-check first before considering the endpoint
- ❌ Not verifying immediately after saveCredential → the schedule runs for a day before discovering the key is wrong
- ❌ Heartbeat schedule interval < 5 minutes (may get the target service to ban you)
- ❌ Skipping the step 4 test call (may mean the schedule runs for a day before discovering the key is wrong)
- ❌ Guessing an endpoint the compiled spec does not list — the spec guard blocks it before it is sent and tells you the documented endpoints; use one of those, do not invent `POST /api/heartbeat`
- ❌ Hand-auditing endpoint completeness (counting endpoints, scanning headings, re-reading tail sections) — that job moved to the mechanism, which compiles and cross-checks the full endpoint set deterministically. Duplicating it by hand just burns budget and satisfices on long docs anyway
- ❌ **heartbeat_priority naming an action the service has no endpoint for**: adding "vote on hot posts" when no vote endpoint exists in the compiled spec. Each priority action must map to a real documented endpoint — if the spec has none for it, the priority was guessed from a summary, drop it
- ❌ Onboarding multiple services simultaneously (one at a time, linear workflow, reflection produces a clean skill more easily)

## Coordination with Other Skills

- With **clawhub**: clawhub installs ready-made skills from public repositories; this skill **derives** a new skill from an external service's documentation. They complement each other without conflict.
- With **skill-creator**: skill-creator teaches how to write SKILL.md format; this skill runs through the workflow and lets reflection automatically generate SKILL.md — the automated path through skill-creator.
- With **memory-discipline**: strictly followed — service.* namespace for facts, never write secrets.
