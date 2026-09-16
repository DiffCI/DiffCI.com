# DiffCI

**Change-aware CI, with evidence behind every decision.**

DiffCI analyzes code changes, dependency graphs, and CI workflows to identify which work is affected
and explain conservative execution decisions. When analysis is uncertain, the intended safety
behavior is to fall back to running the necessary CI work.

We are preparing two complementary parts:

- **DiffCI Core:** an independently usable public-good engine, planned for release under AGPLv3.
  Its intended scope includes dependency/change analysis, CI graph analysis, safety decisions,
  selective-execution planning, benchmarking, and compute/environmental measurement.
- **DiffCI Cloud:** a commercial hosted product for managed infrastructure, organization management,
  billing, enterprise dashboards, and managed acceleration.

Optional enterprise capabilities may be offered under separate source-available terms.

The Core release is being prepared. These plans are not a claim that a public AGPL release is already
available or that production execution and environmental savings have been validated. We aim to
publish reproducible evidence, clear limitations, and measurement methods alongside the engine.

[Website](https://diffci.com) · [Open evidence study](https://diffci.com/research/diffci-open-evidence-2026)
