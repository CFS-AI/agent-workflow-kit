# Constraints

## Technical invariants

- Do not commit generated runtime state.
- Do not mutate production without explicit authorization and rollback notes.
- Do not mix unrelated changes in one commit.
- One writer per worktree.

## Publication boundary

- This template is shareable only after scrub-check passes.
- Derived project-specific versions may contain private context; do not publish them blindly.

## Non-goals

- This kit does not replace product documentation.
- This kit does not grant access to external systems.
- This kit does not make delegated output trustworthy without review.
