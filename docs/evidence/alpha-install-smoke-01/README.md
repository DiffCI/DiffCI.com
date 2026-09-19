# Alpha install smoke 01

This folder is reserved for the first external or disposable-repository install-to-report smoke test.

Capture:

- repository name;
- workflow file used;
- `diffci verify-workflow` output;
- GitHub Actions run URL;
- report artifact name and digest;
- hosted ingest response, if configured;
- hosted report URL, if configured;
- notes on whether existing CI jobs and required checks were unchanged.

The smoke test should prove the user-facing path:

```bash
npx @diffci.com/diffci@latest verify-workflow
npx @diffci.com/diffci@latest observe
```

If hosted ingest is enabled, the observation must appear only in the owning organization.
