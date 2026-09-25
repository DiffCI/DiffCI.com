# DiffCI for Grok

Install repository instructions:

```bash
npx "@diffci.com/diffci@latest" init
```

Default validation command:

```bash
npx "@diffci.com/diffci@latest" check
```

Use DiffCI before PR-ready answers. `check` analyzes the change and runs inferred full and selected
test commands to measure time. It writes reports outside the checkout and sends nothing by default.
Test commands may write generated files. Use `observe --no-send` for analysis only.
Keep the repository's required checks authoritative.
