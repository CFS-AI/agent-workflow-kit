# Agent Workflow Kit

Shareable workflow template for running an engineering workspace with three cooperating surfaces:

- **Claude Code** — interactive orchestration, hooks, skill routing, daily/status memory.
- **Scaffold / prime** — structured clarification → diagnosis → plan → approval → build/review loop.
- **Codex Delegate** — routine implementation in a sandbox/worktree, accepted only through review-gate.
- **Autonomy ladder** — bounded turn, goal, time and proactive loops with explicit evidence and stop conditions.

The default install is domain-neutral. Optional packs add reusable domain workflows without secrets or private data.

## What you get

```text
templates/
  claude/              # CLAUDE.md, AGENTS.md, hooks, codex-delegate skill
  scaffold/            # context/rules/constraints/done-criteria + skill index cards
  demo-workspace/      # tiny project used by smoke-test
packs/
  cfs/                 # optional CFS/OpenClaw ops pack: cfs-hub + docs-intel workflows
scripts/
  apply-kit.sh         # copy templates into a target repository
  codex-exec.sh        # hardened Codex CLI wrapper
  smoke-test.sh        # create demo workspace and validate structure
  scrub-check.sh       # denylist check before publishing/sharing
docs/
  WORKFLOW.md          # operating model
  INSTALL.md           # install/update instructions
  SCRUBBING.md         # what must never be shared
  REVIEW_GATE.md       # accepting delegated work safely
```

## Quick start

```bash
git clone <this-repo-url> agent-workflow-kit
cd agent-workflow-kit
./scripts/smoke-test.sh

# Apply to an existing project:
./scripts/apply-kit.sh /path/to/your/project

# Apply core + CFS pack:
./scripts/apply-kit.sh --pack cfs /path/to/your/project
```

After applying, open the target project in Claude Code or Scaffold and read:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `.scaffold/context.md`
4. `.scaffold/rules.md`

For MCP sync with Codex, install the transport explicitly after applying the kit:

```bash
scripts/dev/setup-codex-mcp.sh --scope user
```

This registers only `codex mcp-server`; it does not copy credentials or modify sandbox profiles.

Then customize placeholders marked `TODO:`.

## Core rules

1. **State lives in git.** Keep `dev/status.md` and `dev/daily/YYYY-MM-DD.md` current.
2. **No blind implementation.** Diagnose first, plan second, implement after approval.
3. **Delegate routine work, not ownership.** Codex can edit; the orchestrator reviews, tests and commits.
4. **One writer per worktree.** Parallel agents get isolated git worktrees.
5. **Publish only scrubbed artifacts.** Run `./scripts/scrub-check.sh` before pushing.

## Checks in the public repository

The repository is intentionally public, so its GitHub Actions do not call the
private CFS harness. CI runs the local Node tests, installation smoke test and
scrub check; the Rules job verifies that `CLAUDE.md` and `AGENTS.md` remain
identical. Model review is still required by [the review-gate](docs/REVIEW_GATE.md)
before a production deployment, but it is an accountable human/orchestrator
step rather than a CI job that would silently fail to resolve a private workflow.

## Providers (subscription by default, paid API opt-in)

Review and planning calls go through `.claude/hooks/providers.js`. By default every
profile runs on the Codex CLI, where an extra call is covered by the subscription.
A paid HTTP provider (DeepSeek) can serve individual profiles, but it is opt-in and
guarded, because it changes two things at once: calls cost money, and the answer can
come back as prose instead of a verdict.

### What leaves your machine

Read this before enabling a paid provider. Routing a profile to one sends that
vendor's API, over the public internet, **the raw text it is asked to judge**:

- on `UserPromptSubmit` — the user prompt, verbatim;
- on `PreToolUse` — the tool name and the pending shell command, verbatim.

Nothing is redacted, summarised or truncated on the way out, and there is no
allowlist of what a prompt may contain: repository paths, hostnames, ticket numbers,
stack traces and anything pasted into the turn go with it. The Codex default keeps
this traffic inside a subscription you already have; DeepSeek is a third party under
its own jurisdiction, retention and training policy. Move a profile onto it only for
repositories whose prompts and commands you are willing to disclose to that vendor.

### Configuration

```bash
export AGENT_KIT_PROVIDER_PLAN=deepseek           # move one profile, not all of them
export DEEPSEEK_API_KEY=...                       # never committed; read at call time
export AGENT_KIT_ALLOW_EXTERNAL_PROMPTS=1         # explicit acknowledgement of third-party prompt transfer
export AGENT_KIT_BUDGET_USD=5                     # required — no ceiling, no metered call
export AGENT_KIT_MODEL_PRICES='{"deepseek-reasoner":{"in":0.55,"out":2.19}}'
export AGENT_KIT_MAX_TOKENS=512                   # optional; bounds response length and cost
export AGENT_KIT_LEDGER_STALE_MS=5000             # optional; how long a spend-ledger lock may sit
```

`AGENT_KIT_LEDGER_STALE_MS` is how long a ledger lock may go untouched before another
hook may reclaim it. The default of 5000 is three orders of magnitude above what a hold
costs (one read plus one append), so it exists to stop a dead process wedging the ledger,
not as a tuning knob. Setting it to `0` makes every lock instantly reclaimable, which
switches the mutual exclusion off — the tests use that deliberately; nothing else should.

`AGENT_KIT_PROVIDER_<PROFILE>` moves exactly the profile it names. `AGENT_KIT_PROVIDER`
without a suffix moves **every** profile, including ones added to the kit later, and a
per-profile setting overrides it. Prefer the per-profile form: the two channels described
above do not carry the same material, and `review` is the one that sends shell commands.

The example deliberately moves `plan` rather than `review`. The `review` profile serves
the `PreToolUse` gate, so routing it to a paid vendor is what sends `sudo`, connection
strings and anything else in a flagged command off the machine; `plan` sends prompt text
only. Move `review` only when you mean to.

Routing produces Codex model names (`gpt-5.6-terra`), which mean nothing to a paid
vendor, so each provider declares its own model per profile: `prime`, `plan` and
`review` go to `deepseek-reasoner`, `build` and `simple` to `deepseek-chat`. Price the
**provider's** model names in `AGENT_KIT_MODEL_PRICES`, never the Codex ones.

`AGENT_KIT_MAX_TOKENS` is the only bound on how long — and so how expensive — a single
response can be. It defaults to 512, and an unparseable value falls back to that
default rather than removing the bound.

Rules the layer enforces:

- **A model with no declared price is unpriced, never free.** An unpriced paid model
  silently recorded at $0 is how a budget goes blind, so the call is refused instead.
- **No ceiling, no metered call.** `AGENT_KIT_BUDGET_USD` is required, and spend
  accrues across turns so the ceiling bounds the routine rather than one call.
- **No explicit transfer acknowledgement, no metered call.** Set
  `AGENT_KIT_ALLOW_EXTERNAL_PROMPTS=1` only after accepting that the raw prompt and
  command text described above will go to the third-party provider.
- **The ceiling is a limit, not a trigger.** A call is refused when its worst case —
  the prompt as sent, plus `AGENT_KIT_MAX_TOKENS` of output — would carry the total
  past the ceiling. The worst-case amount is reserved under a lock before the request, so
  concurrent hooks cannot cross the ceiling together. Two things the reservation cannot
  promise, and does not pretend to: `AGENT_KIT_MAX_TOKENS` is a request rather than a
  guarantee, so a vendor answering past it settles above the ceiling — the overshoot is
  recorded and reported in the note, and the next call is refused. And a call that
  crashed, timed out or failed in flight keeps its reservation, because we cannot prove
  the vendor is not billing it; a call that never left the machine, or that the vendor
  refused at the door (`401`, `403`, `429` and the like — rejected before any model ran),
  gets it back. Holding those was how a wrong or rotated key walked the ledger to the
  ceiling one phantom reservation per hook and switched the paid route off, having spent
  nothing.
- **A response with no usable `usage` block is a failed call.** Unmeasurable spend is
  unknown, never zero: the answer is discarded and the worst case is charged. A block
  that is absent, empty, or all zeros is the same claim — no call that reached a model
  consumed nothing — so no vendor can buy unlimited calls for $0.
- **A response without an `APPROVE`/`WARN`/`BLOCK` verdict is a failed call**, not a
  quiet approval, and the prose is never passed on dressed as a verdict.
- **The heaviest verdict wins.** `BLOCK` outranks `WARN` outranks `APPROVE`, and markdown
  decoration (`**BLOCK**:`, `- BLOCK —`, `**Verdict:** BLOCK`) is read as a verdict, as is
  a verdict behind whatever introduced it (`Recommendation: BLOCK: …`, `1. BLOCK: …`),
  because that is how models actually answer.
- **A denial is read in the words models deny with; an approval is not.** `BLOCKED:`,
  `Blocked`, `Verdict: BLOCKED`, `DENY:` and `REJECT:` all count as `BLOCK`, while
  `APPROVE` and `WARN` stay exact. The asymmetry is the point: a wider denial vocabulary
  costs a retry, a wider approval one runs the command.
- **The same asymmetry applies to position.** A denial counts on any line, including
  behind whatever introduced it. An approval counts only on the first or last line and
  never behind a label, because the reviewer is handed the pending command verbatim and
  quotes it back: a command carrying its own `APPROVE:` line otherwise approved itself,
  as did prose like `A reviewer may answer:` / `> Verdict: APPROVE` / `I refuse this one`.
- **Mentioning a verdict is not stating one.** A response that says `BLOCK` only in
  passing, with no verdict anywhere, is ambiguous rather than decided — so it is a failed
  call and escalates. Reading the mention as a denial made the gate fire on its own
  approvals (`APPROVE: no BLOCK condition applies`), and a gate that fires on correct
  approvals gets switched off; reading it as an approval runs the command. Ambiguity
  escalates for a second opinion instead — and if that is inconclusive too, strict mode
  denies rather than guessing.
- **A denial outlives the accounting.** A paid answer with no usable `usage` is discarded
  as unmeasurable — except for a `BLOCK` in it, which is kept and still denies. Billing
  and safety are separate facts, and the fallback is never allowed to soften a denial the
  first reviewer already made.
- **Any of the above escalates to the subscription provider**, reporting what it
  escalated from and why. Escalation is never silent, and the decision to deny is taken
  on the provider's own verdict, never re-read out of the note built for display.
- **The breaker counts transports, not opinions, and counts them per provider.** Three
  failed *transports* in five minutes stop that provider for the rest of the window. A
  reviewer that answered without a verdict is alive, so it does not count. The count is
  per provider because a single tally gets it wrong both ways: a successful fallback
  would erase a dead paid vendor's failures and it would be retried on every hook, while
  a shared tally would take the working subscription reviewer down with it.
- **In strict mode a `BLOCK` denies your tool call outright, and so does an inconclusive
  review.** No verdict, no Codex binary, a timeout, an open breaker or a spent budget all
  deny the pending command rather than waving it through: a gate that allows whenever its
  reviewer is unreachable protects nothing at the moment it is needed. This applies only
  to the commands `shouldReviewTool` flags — `rm -rf`, force-push, `sudo`,
  `terraform apply`, `curl | sh` and friends. Unset `CODEX_COPILOT_MODE` to get advisory
  notes instead. Routing a profile to a paid vendor also gives that vendor a veto, not an
  opinion; set strict mode with both facts in mind.
- **The denial is emitted in the shape the host enforces.** Hooks that answer
  `{"decision": "deny"}` are silently ignored — the host's `decision` field is
  `approve`/`block`, and output that fails its schema is discarded whole, so the command
  runs. The hook sends `hookSpecificOutput.permissionDecision: "deny"` and keeps the
  legacy `decision: "block"` alongside it.

Spend is recorded in `.claude/cache/provider-spend.jsonl`, one appended line per call,
so concurrent hooks cannot lose each other's entries. `apply-kit.sh` adds
`.claude/cache/` to the target's `.gitignore`; keep it there, since a committed
ledger both leaks usage and resets the ceiling on merge.

Prices in the example above are placeholders — declare the ones you have actually
verified with the vendor. Verify the layer with `node --test tests/*.test.js`: the
transport is injected, so the suite needs no API key and makes no network calls.

## Optional CFS pack

The CFS pack is for OpenClaw/CFS-style operations and includes:

- `cfs-hub-ops` — read-only infra monitoring triage through cfs-hub MCP;
- `cfs-docs-update` — docs-first + docs-update workflow around CFS Docs/docs-intel;
- `.mcp.cfs.example.json` — placeholder MCP config for `cfs-hub`, `docs-intel-team-dev`, `docs-intel-legal`.

It deliberately excludes personal `/eod`, CEO private rollups, raw daily/status files, live secrets, raw client data and live infrastructure addresses.

## License

MIT — use, fork and adapt.
