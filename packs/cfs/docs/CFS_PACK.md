# CFS Pack Guide

The CFS pack adds operational workflows that are useful for OpenClaw/CFS-style projects but are not personal to one operator.

## Included

- `cfs-hub-ops` skill: read-only infra status/incident/cost triage.
- `cfs-docs-update` skill: docs-first lookup and docs-update contract.
- `.mcp.cfs.example.json`: placeholder MCP definitions for cfs-hub and docs-intel corpora.
- Scaffold cards for both workflows.

## Excluded on purpose

- personal `/eod` rollups;
- CEO/private personal task summaries;
- raw `dev/status.md` or `dev/daily/*.md` from any real workspace;
- credentials, live tokens, cookies, SSH keys;
- raw customer/client/person data;
- live IPs or private hostnames.

## Configure MCP

Copy `.mcp.cfs.example.json` into your project and replace placeholders:

```text
${CFS_HUB_REPO}   -> local path to cfs-hub repo
${CFS_DOCS_REPO}  -> local path to cfs-docs repo
```

Then merge wanted servers into `.mcp.json` or your Claude Code MCP settings.

Keep credentials in env/local settings only.
