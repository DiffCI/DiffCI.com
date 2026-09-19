# Security policy

## Supported project

This policy covers the DiffCI open-source core package, published as `@diffci.com/diffci`.

Covered surfaces:

- `diffci observe`
- `diffci verify-workflow`
- the basic GitHub Action in `action.yml`
- local report generation
- optional report submission to a configured endpoint and token

Commercial DiffCI, including DiffCI Cloud, hosted dashboards, managed runners, billing, organization
management, private report access, and enterprise policy features, is separate proprietary software and
is handled through commercial support channels.

## Supported versions

The supported OSS package line is the latest published npm release. Security fixes are released as a
new npm version and Git tag.

DiffCI Core requires Node.js `>=22.5.0`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report security issues by email to:

```text
security@diffci.com
```

Include:

- affected package/version;
- affected command or GitHub Action path;
- reproduction steps;
- expected impact;
- whether any token, report, repository data, or CI behavior is exposed or modified.

## Response target

For the OSS package:

- acknowledge within 3 business days;
- provide an initial assessment within 7 business days;
- publish a fix or mitigation plan when the issue is confirmed.

## Security boundaries

DiffCI Core is observation-only. A security issue is especially important if it causes the observer to:

- modify the repository checkout without reporting it;
- affect another CI job's conclusion;
- expose tokens or report submission credentials;
- submit a report to the wrong repository or organization;
- include source file contents when the report schema says it does not;
- bypass the OSS package boundary and include commercial/control-plane code.
