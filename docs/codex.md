# DiffCI for Codex

Install repository instructions:

```bash
npx "@diffci.com/diffci@latest" init
```

Default validation command:

```bash
npx "@diffci.com/diffci@latest" verify --changed --json
```

Use DiffCI before PR-ready answers. Continue only when `safe_to_continue` is true. Verification covers
the current staged, unstaged, and untracked snapshot, uses full fallback when uncertain, and sends
nothing by default. If tests change files, review them and rerun. Use `observe --no-send` for analysis only.
Keep the repository's required checks authoritative.
