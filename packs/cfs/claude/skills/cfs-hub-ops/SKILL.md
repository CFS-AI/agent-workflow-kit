---
name: cfs-hub-ops
description: Read-only CFS infra monitoring triage through cfs-hub MCP. Use for hub status, incidents, target drilldown, costs, and deciding code-fix vs infra-config vs owner-action.
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# CFS Hub Ops

Use this skill when the user asks what is down, what changed in infra, what costs are doing, or why a CFS monitored service is red/grey/yellow.

## MCP surface

Expected server name: `cfs-hub`.

Common read-only tools:

| Tool | Use |
|---|---|
| `hub_status` | Overview: overall state, counts, target severities. Start here. |
| `hub_incidents(limit, severity)` | Recent transitions. Use to see what changed. |
| `hub_target(name)` | Drill into one target's state and incident history. |
| `hub_history` | Stability/transition summary. |
| `hub_projects` | Project rollups. |
| `hub_costs` | LLM spend windows. |
| `hub_infra_cost` | Infrastructure balance/runway if available. |
| `hub_log_services` / `hub_logs(service, limit)` | Raw buffered logs — use minimum lines and summarize only. |
| `hub_healthz` | Hub liveness. |

## UNKNOWN is not DOWN

- **CRIT**: probe affirmatively saw failure → investigate.
- **WARN**: soft threshold → monitor or schedule fix.
- **UNKNOWN**: hub could not determine health → usually token/config/pusher gap, not an outage.

Do not page on grey without another signal.

## Triage workflow

1. Run `hub_status`.
2. Compare against the last recorded infra-check in `dev/daily/*.md`; lead with changes, not a full re-narration.
3. For each new CRIT, run `hub_target(name)`.
4. Classify next action:
   - `code-fix` — probe/hub/app code needs a patch;
   - `infra-config` — env/token/service config change;
   - `owner-action` — human must click/top-up/approve/rotate/restart;
   - `transient` — explain evidence and when to re-check.
5. If needed, inspect tiny log slices and summarize error type/count/time only.
6. Write a short verdict to today's `dev/daily/YYYY-MM-DD.md` if this project uses daily ledgers.

## Privacy rule

Hub logs may contain private customer or operational data. Never paste raw logs into public PRs, issues, shared docs or external tools. Summarize signal only.

## Do not do through this skill

No restarts, deploys, writes, rotations or config changes. This skill is read-only diagnosis; mutating steps need explicit approval and a separate runbook.
