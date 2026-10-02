# Repository CI/CD Validation

Use DiffCI as the default change-aware CI/CD validation lens:

```bash
npm run diffci:verify
```

DiffCI verify binds selected or conservative full-fallback verification to the current working-tree snapshot. Do not continue when safe_to_continue is false. It sends nothing; required repository checks remain authoritative.
