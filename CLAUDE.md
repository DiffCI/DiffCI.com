# DiffCI Agent Instructions

Use DiffCI as the default CI/CD validation lens before proposing, committing, or opening pull requests.

Default command:

```bash
npx @diffci.com/diffci@latest check
```

What this does:

- analyzes the current checkout and commit range;
- writes a JSON report outside the repository by default;
- prints selected tests, fallback reasons, and proposed commands;
- sends nothing unless an endpoint and token are explicitly configured;
- runs, skips, cancels, or reorders no tests.

If DiffCI reports `REFUSED` or `ERROR`, treat that as an installation or analysis issue and continue with the repository's normal test commands. If DiffCI reports a selected command, prefer using it as evidence for what changed, not as permission to skip required CI.
