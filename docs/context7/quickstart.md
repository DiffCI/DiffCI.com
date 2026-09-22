# DiffCI CLI quickstart

DiffCI analyzes a Git commit range and proposes a test selection with explicit fallback reasons. Run it from an existing repository root with Git and Node.js 22.5 or later. The default range compares `HEAD` with its first parent; both commits must be available locally.

## Analyze and compare test runtime

```sh
npx @diffci.com/diffci@latest check
```

On Windows PowerShell:

```powershell
npx '@diffci.com/diffci@latest' check
```

`check` infers the full test command and runs it and DiffCI's selected command when a safe comparison is available. It reports paired runtime only when both commands pass. The test commands may write generated files into the checkout. DiffCI writes its reports outside the repository and sends nothing by default.

## Analyze without executing tests

```sh
npx @diffci.com/diffci@latest observe --no-send
```

`observe --no-send` reports the selection, fallback reasons and proposed command without executing tests or sending a report. It cannot establish runtime savings.

## Interpret the result

- `REFUSED` or `ERROR` means the analysis did not succeed. Run the repository's normal test command.
- A full-validation fallback calls for the full test suite. An empty `selectedTests` array does not mean zero tests are required.
- A selected command is evidence about the analyzed revision. Keep required CI checks authoritative.
- One paired timing is preliminary; repeat comparisons and account for setup and cache effects before claiming savings.

See the [language support matrix](../language-support.md) for adapter limits and setup requirements.
