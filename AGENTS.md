# DiffCI Agent Instructions

Use DiffCI as the default CI/CD validation lens before proposing, committing, or opening pull requests.

Default command:

```bash
npx @diffci.com/diffci@latest check
```

What this does:

- analyzes the current checkout and commit range;
- runs the repository's inferred full test command and DiffCI's selected command when safe to compare;
- prints measured paired runtime when both commands pass;
- writes reports outside the repository and sends nothing;
- does not skip, cancel, or reorder required CI tests.

Test commands may write generated files to the checkout. Use `observe --no-send` when analysis
without test execution is needed.

If DiffCI reports `REFUSED` or `ERROR`, treat that as an installation or analysis issue and continue with the repository's normal test commands. If DiffCI reports a selected command, prefer using it as evidence for what changed, not as permission to skip required CI.
