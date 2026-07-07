# Install

## Apply to a project

```bash
git clone <this-repo-url> agent-workflow-kit
cd agent-workflow-kit
./scripts/apply-kit.sh /path/to/project
```

The script creates:

- `CLAUDE.md`
- `AGENTS.md`
- `.claude/hooks/*`
- `.claude/skills/codex-delegate/SKILL.md`
- `.scaffold/context.md`
- `.scaffold/rules.md`
- `.scaffold/constraints.md`
- `.scaffold/done-criteria.md`
- `.scaffold/skills/*`
- `scripts/dev/codex-exec.sh`
- `dev/status.md`
- `dev/daily/.gitkeep`

Existing files are not overwritten unless you pass `--force`.

## Customize after install

1. Replace `TODO:` placeholders in `CLAUDE.md`, `.scaffold/context.md` and `.scaffold/rules.md`.
2. Add project-specific denylist patterns to `.scrub-denylist`.
3. Remove unused skills from `.claude/skills/skill-rules.json`.
4. Run:

```bash
./scripts/scrub-check.sh
./scripts/smoke-test.sh
```

## Updating a project

Re-run `apply-kit.sh` into a temporary directory and diff manually. Do not blindly overwrite project-specific rules.
