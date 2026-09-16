# Licensing direction and release boundaries

Status: proposed architecture; no repository-wide relicensing in this change.

## DiffCI Core

Release the independently usable engine under GNU AGPL version 3. Core's intended scope is dependency
and change analysis, CI graph analysis, conservative safety/fallback decisions, selective-execution
planning, reproducible benchmarks, and compute/environmental measurement with disclosed methodology.
Funded functionality must be usable without proprietary services or credentials for DiffCI Cloud.

Initial extraction candidates are `src/git/`, `src/repo/`, `src/planner/`, `src/ci-inference/`, and
portable graph-cache, measurement, benchmark, and safety utilities. These are candidates, not a
file-level license declaration. Trace imports, runtime dependencies, fixtures, and build inputs
before choosing the release boundary.

AGPL allows commercial use, redistribution, and competing hosting. Section 13 requires a modified
version supporting remote network interaction to prominently offer its Corresponding Source to
the users interacting with it remotely. It does not prohibit competitors from providing a service.
Independent works may have separate licenses; a repository boundary, process boundary, or API alone
does not settle whether components form one combined work.

## DiffCI Cloud and enterprise capabilities

Keep hosted infrastructure, billing, tenant/organization management, enterprise dashboards,
proprietary data/services, and managed acceleration in a private repository under proprietary terms.
Initial Cloud candidates include `src/product/`, `src/billing/`, `src/auth/`, hosted ingestion and
installation services, deployment configuration, and service infrastructure.

Review `src/client/`, `src/runner/`, `src/research/`, `src/shadow/`, measurement code, and agent bundles
individually: these may combine portable engine functions with hosted operations. Public-good
measurement methodology and reproducible benchmarks belong with Core, even when Cloud also uses them.

Optional source-available enterprise code needs its own explicit terms and a reviewed integration
boundary. Visibility of source does not make a license FOSS. Do not distribute an AGPL combined work
under restrictive enterprise terms without the necessary rights and a compatible licensing route.

## Existing notices and release gates

- `ops/agent/LICENSE` contains a proprietary observer-license draft with unresolved entity placeholders.
  Reconcile its scope with the extracted Core and the actual agent bundle before distribution.
- `site/research/2026/LICENSE.txt` covers designated study materials under CC BY 4.0, not the engine.
  Preserve its scope and third-party attribution.
- Audit authorship and provenance, including inherited monorepo history, third-party source, generated
  code, fixtures, and dependency notices. GitHub contributor counts do not establish copyright ownership.
- Include the full AGPLv3 text, accurate copyright/third-party notices, package license metadata,
  build instructions, and a usable source-offer mechanism in the released Core.
- Decide explicitly whether the release is `AGPL-3.0-only` or `AGPL-3.0-or-later` before setting SPDX metadata.
- Check each grant's license, ownership, publication, deliverable, and commercial-use terms. This
  architecture does not itself establish eligibility, funding, or grant compliance.

References: [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html),
[GNU FAQ on separate and combined works](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).
