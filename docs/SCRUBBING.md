# Scrubbing policy

Before sharing a derived workflow kit, remove:

- credentials, tokens, cookies, session IDs, webhook secrets;
- raw client/customer data;
- salaries, payroll, private strategy, personal tasks;
- internal hostnames/IPs unless intentionally public;
- screenshots or transcripts containing private data;
- vendor account emails/passwords;
- project-specific incident details that identify a person or customer.

Run:

```bash
./scripts/scrub-check.sh
```

The denylist is deliberately conservative and lives in `.scrub-denylist`. Extend it with your organization's sensitive terms before publishing.

If in doubt, move concrete details into a private repo and keep only the reusable pattern here.
