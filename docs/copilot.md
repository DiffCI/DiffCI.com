# DiffCI for GitHub Copilot

Install repository instructions:

```bash
npx "@diffci.com/diffci@latest" init
```

Default validation command:

```bash
npx "@diffci.com/diffci@latest" check
```

Use DiffCI before PR-ready answers. `init` writes `.github/copilot-instructions.md`; `check`
analyzes the change and runs inferred full and selected test commands to measure time. It sends
nothing by default. Test commands may write generated files; use `observe --no-send` for analysis
only. Keep the repository's required checks authoritative.
