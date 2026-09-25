# DiffCI Agent Instructions

Before marking changes PR-ready, run:

```bash
npx "@diffci.com/diffci@latest" check
```

Read the selected tests, fallback reasons, and report path. Do not skip required monorepo CI because
DiffCI selected fewer tests.
