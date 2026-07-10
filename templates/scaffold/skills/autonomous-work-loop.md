# Autonomous Work Loop

Use the smallest autonomy level that fits the task:

1. Turn — agent verifies one result.
2. Goal — independent evaluator checks a quantitative DoD; cap attempts and stop after repeated no-progress.
3. Time — scheduler triggers idempotent work with a concurrency cap.
4. Proactive — event/schedule supplies the prompt; start read-only and add a kill switch.

Every loop needs objective, scope/forbidden actions, evidence, evaluator, attempt/time/token limits, no-progress rule, idempotency key for scheduled work and a terminal state (`achieved`, `exhausted`, `blocked`, `cancelled`).
