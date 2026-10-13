# DiffCI public plugin

This is the portable public-directory package for DiffCI's hosted Streamable
HTTP MCP endpoint. It plans local validation commands, interprets DiffCI
observation reports, and checks submitted GitHub Actions observer workflow
text. The hosted service is stateless: it cannot read a caller's checkout, run
tests, or replace required CI. Use the separately distributed local stdio
plugin when an agent needs checkout-aware analysis or verification.

The package is intended for OpenAI's public plugin submission flow. See
[`SUBMISSION.md`](SUBMISSION.md) for release gating, review cases, and the
remaining portal-only steps.
