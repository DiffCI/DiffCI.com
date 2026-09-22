# DiffCI

**Change-aware CI, with evidence behind every decision.**

DiffCI analyzes code changes, dependency graphs, and CI workflows to identify which work is affected
and explain conservative execution decisions. When analysis is uncertain, the intended safety
behavior is to fall back to running the necessary CI work.

DiffCI has two complementary parts:

- **[DiffCI Core](https://github.com/DiffCI/core):** a public, independently usable engine under
  AGPL-3.0-only. It includes dependency/change analysis, CI graph inference, conservative safety
  decisions, advisory test-selection plans, portable tests, a synthetic benchmark and local compute
  measurement. No DiffCI account or Cloud API key is required.
- **DiffCI Cloud:** a commercial hosted product for managed infrastructure, organization management,
  billing, enterprise dashboards, and managed acceleration. Its implementation remains private.

Optional enterprise capabilities may be offered under separate source-available terms.

The initial Core release produces advisory plans; it does not execute, skip or cancel CI jobs.
Cost, energy and carbon calculations are estimates using explicit assumptions, not verified savings.
See the [Core README](https://github.com/DiffCI/core#readme) for installation, scope and limitations.

[Website](https://diffci.com) · [Open evidence study](https://diffci.com/research/diffci-open-evidence-2026)
