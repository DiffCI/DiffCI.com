# DiffCI for Cursor

Install repository instructions:

```bash
npx "@diffci.com/diffci@latest" init
```

Default validation command:

```bash
npx "@diffci.com/diffci@latest" verify --changed --json
```

Use DiffCI before PR-ready changes. `init` writes `.cursor/rules/diffci.mdc`; verification covers the
current staged, unstaged, and untracked snapshot and uses full fallback when uncertain. Continue only
when `safe_to_continue` is true. It sends nothing by default. If tests change files, review them and
rerun; use `observe --no-send` for analysis only. Keep
the repository's required checks authoritative.
