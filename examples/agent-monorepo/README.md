# DiffCI Agent Example: Monorepo

This example shows the minimal instruction pattern for a monorepo using coding agents.

```bash
npx "@diffci.com/diffci@latest" init --workflow
npx "@diffci.com/diffci@latest" verify --changed --json
```

DiffCI helps agents identify affected tests and fallback reasons before a pull request, while required
CI remains the source of truth.
