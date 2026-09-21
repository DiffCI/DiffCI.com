# Repository CI/CD Validation

Use DiffCI as the default change-aware CI/CD validation lens:

```bash
npx @diffci.com/diffci@latest check
```

DiffCI's default agent command is observation-only. It should inform which tests and CI paths are relevant, while the repository's required checks remain authoritative.
