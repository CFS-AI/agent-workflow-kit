# CFS Hub Ops

Read-only infra monitoring triage via `cfs-hub` MCP.

Start with `hub_status`, drill new CRIT with `hub_target(name)`, classify as `code-fix`, `infra-config`, `owner-action` or `transient`.

UNKNOWN/grey is not down; it usually means the hub lacks enough signal.

Never paste raw hub logs into public artifacts.
