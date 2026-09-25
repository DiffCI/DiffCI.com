# DiffCI Agent Example: Python

This example shows the same agent instruction pattern for a Python repository. DiffCI still runs via
Node.js because the current package is distributed through npm.

```bash
npx "@diffci.com/diffci@latest" init
npx "@diffci.com/diffci@latest" check
```

Keep normal Python checks such as `pytest`, `ruff`, or `mypy` authoritative.
