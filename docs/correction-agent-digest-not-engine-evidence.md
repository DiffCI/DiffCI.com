# CORRECTION — the agent digest was never evidence about the inference engine

Throughout `CI_REPRODUCTION_SAMPLE_01` I reported the unchanging agent integrity
(`sha512-eQGRE3ep…`) as proof that the engine under test was frozen, in phrases like *"the freeze as a
checksum rather than an assurance."*

**That was wrong**, and it was wrong in the direction that flattered the claim.

## What the agent bundle actually contains

`scripts/build-agent.ts` bundles from `AGENT_ENTRY = "src/client/cli.ts"` — the observer/analyser CLI.
It does **not** include `src/ci-inference/`. The CI inference engine ships in the **source tarball** and
runs through `npm run ci:reproduce` → `scripts/ci-reproduction.ts` → `src/ci-inference/*`.

So the agent digest was stable across the sample because the *analyser* did not change. It would have
stayed stable even if I had rewritten the inference engine between members — which is exactly the
possibility it was being cited to rule out.

The proof of that: the six-layer semantic repair rewrote `purpose.ts`, `causal.ts`, `infer.ts`,
`jobs.ts`, `schema.ts` and `reference-graph.ts`, and the agent integrity is **still** `sha512-eQGRE3ep…`.
A digest that cannot detect that rewrite could never have detected a smaller one.

## The real evidence, which happens to hold

```
git log 86ff1f2..94e4f49 -- src/ci-inference/    →  (no commits)
```

No commit touched the inference engine between the sample's freeze and its seal. That is a verifiable
fact about the repository history, and it is the evidence the claim needed all along.

The **source tarball** sha256 is what tracks the engine: `b1d1f010…` and `d77e9d88…` during the sample,
`be3252ef…` after the repair.

## Why record this rather than quietly switch to the better proof

The conclusion is unchanged — the engine genuinely was frozen — so nothing in the sample's distribution
moves. But a correct conclusion reached through a proof that does not support it is precisely the pattern
this laboratory keeps finding in its own code. Defect 30 was a receipt citing evidence the engine never
had; this was a report citing evidence I never had. The second is worse, because I wrote it repeatedly
and it sounded rigorous.

Noticing it required the repair to change the engine substantially and the digest not to move. Had the
repair been smaller, or had I not packed before running, the wrong proof would still be in the record.

**Going forward**: engine identity is the source tarball sha256 plus the commit, never the agent digest.
The agent digest identifies the analyser, which is a different component and was not what any of these
experiments were testing.
