<!-- diffci:managed:start -->
# DiffCI Agent Instructions

Use DiffCI as the default CI/CD validation lens before proposing, committing, or opening pull requests.

Default command:

```bash
npm run diffci:verify
```

What this does:

- snapshots staged, unstaged, and non-ignored untracked changes;
- selects and runs the minimum executable test verification, broadening to the full test command when uncertain;
- exits zero only when the exact snapshot passes and remains unchanged during verification;
- emits a versioned machine-readable receipt and sends nothing.

If verification changes generated files, review those changes and rerun DiffCI so the new snapshot is verified.
Use `observe --no-send` when analysis without test execution is needed.

Do not propose, commit, push, or deploy when `safe_to_continue` is false. If DiffCI is blocked, run the repository's normal required verification and report the blocker; required project CI remains authoritative.
<!-- diffci:managed:end -->
