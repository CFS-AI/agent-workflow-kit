# CFS Pack

Optional Agent Workflow Kit layer for CFS/OpenClaw-style ops work.

It adds shareable, sanitized workflow pieces for:

- **cfs-hub MCP** — read-only infra monitoring triage;
- **CFS Docs / docs-intel MCP** — docs-first lookup and docs-update contract;
- Scaffold skill cards for the same workflows;
- `.mcp.cfs.example.json` with placeholders.

It intentionally does **not** include personal `/eod`, CEO private rollups, raw daily/status files, client data, credentials, live IPs, SSH keys or private hostnames.

## Install with core kit

```bash
./scripts/apply-kit.sh --pack cfs /path/to/project
```

Then fill placeholders in `.mcp.cfs.example.json` and merge into your local `.mcp.json` / Claude settings.
