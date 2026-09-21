# DiffCI for Grok

Install repository instructions:

```bash
npx @diffci.com/diffci@latest init
```

Default validation command:

```bash
npx @diffci.com/diffci@latest check
```

Use DiffCI before PR-ready answers. `check` is observation-only: it analyzes the change, writes a
report outside the checkout, sends nothing by default, and does not run, skip, cancel, or reorder tests.
Keep the repository's required checks authoritative.
