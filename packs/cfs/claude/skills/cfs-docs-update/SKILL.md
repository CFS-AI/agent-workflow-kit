---
name: cfs-docs-update
description: Keep CFS Docs current after behavior, deploy, env, integration, ownership, runbook, or recurring incident changes. Includes docs-intel MCP usage.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# CFS Docs Update

Use this skill whenever CFS/OpenClaw behavior changes in a way the next operator or agent must know.

## Docs-first rule

Before changing a known workflow, search the docs if docs-intel MCP is available:

1. `search_docs` — find relevant pages.
2. `get_doc` — read the authoritative page.
3. Continue only after noting if docs were unavailable or stale.

Expected MCP servers:

- `docs-intel-team-dev` — internal engineering/operator docs.
- `docs-intel-legal` — isolated legal-facing corpus, if enabled.

## When to update CFS Docs

Update docs when any answer is yes:

- Did user/operator behavior change?
- Did deploy target, service, worker, cron, endpoint, env var or auth model change?
- Did a recurring failure mode get diagnosed?
- Did ownership/status change (`live`, `ready`, `deferred`, `needs-owner-check`)?
- Did a runbook gain a new safe/unsafe step?

## What not to publish

- raw logs, database dumps, postmeet transcripts;
- credentials, tokens, cookies, `.env` values;
- private customer names, phones, emails, addresses, passport/payment data;
- internal security notes that would help an attacker.

Use synthetic examples or internal IDs when possible.

## Suggested update locations

Adapt to your docs repo, but common categories are:

| Change | Page type |
|---|---|
| current project status | status dashboard |
| recurring operational issue | active tracks / incidents |
| deploy/env/health | runtime deploy runbook |
| handoff/rollback | ops handoff |
| legal-facing behavior | legal docs slice |
| new project/service | project index + service page |

## Verification

Run the docs repo's verifier/build. Typical commands:

```bash
python scripts/docs_portal.py verify
python -m mkdocs build --strict -f mkdocs.yml
python -m pytest -q
```

If docs tooling is unavailable, leave an explicit follow-up: which page needs update and why.
