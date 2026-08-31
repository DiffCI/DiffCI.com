# MECHANISM_PROOF_01 — pre-registration

**A different claim from COMPUTE_PROOF_V1, and deliberately so.**

```
V1 asked:  DiffCI saves compute across relevant external workloads
This asks: ∃ workload where DiffCI safely saves compute
```

V1 tested external applicability under frozen corpus rules and closed `INCONCLUSIVE — NO QUALIFIED
TARGETS`. This gives the current analyser a workload that satisfies its **known assumptions** and asks
whether the mechanism works at all. Easier than V1 on purpose. **Not weaker**: every safety and
accounting rule is carried over unchanged.

## Eligibility

```
MECHANISM_PROOF_01

  analyzerEligible          = true
  mappingDensity           >= 70%
  testFiles                >= 20
  twoGreenBaselines         = required   (existing canonical evidence counts)
  disqualifiedInV1          = excluded   (typescript-eslint, jest)
  fullSuiteCpu              = MEASURED AND REPORTED, not gated

selection:
  highest mappingDensity
  tie: testFiles descending
  tie: repository name ascending
```

**Why ≥70%.** "Naturally high test→production connectivity" is the assumption under test. Below roughly
two-thirds, a null result could be attributed to the analyser not seeing the repository — the same
reasoning that set V1's 30%, applied to a stricter question. This proof is *supposed* to hand the
mechanism a fair workload.

**Why ≥20 and not ≥100.** V1's ≥100 was a scale criterion for an economic-generalisation claim. This is
an existence claim, so the bar is "non-trivial enough that selection can differ from FULL", not "large
enough to be commercially interesting". Lowering it here is a change of question, not a relaxation of
V1 — V1 stays closed at ≥100.

**Why full-suite CPU is measured but not gated.** Introducing a compute threshold now would let me pick
a threshold knowing the candidates' costs. It is reported so the result can be judged, not used to
filter.

**Disclosure:** `density-02` is already committed, so I can see which repository these thresholds
select. They are set on the reasoning above, and both are stated in terms that would have been written
the same way before the survey existed. This cannot be un-known, so it is recorded instead.

## What must not happen

**Do not construct a repository that makes DiffCI win.** The candidate must be a real repository whose
test/source architecture **predates this experiment** and was not shaped by knowledge of what DiffCI
needs. An owned repository would be acceptable on that test; a third-party one is stronger, and is what
the rule selects.

**Do not choose a commit already seen to select well.** Repository first, mechanically. Then changes,
mechanically, by the sealed `select-source-candidate` filter with A1.

**No analyser changes after the candidate and mutations are sealed.** The glob fix (`51ddf74`) and the
project-reference fix (`645c0eb`) are in; nothing further.

## Five mutations, not one

One successful mutant establishes existence but is fragile — a single lucky selection is not a
mechanism. **Five mechanically generated, independently measurable mutations**, each reported in full,
including the ones that go against DiffCI.

## Stop condition, before any mutation

Observation runs first across the pre-registered candidates.

> **If observation yields `0 SELECTIVE-nonempty`, STOP. Mutate nothing.**

That result would say the current analyser cannot generate actionable work even on a repository chosen
to satisfy its own structural assumptions — which puts the core mechanism back under serious question,
and is far more important than any economics that could follow it.

## Proof conditions

```
economic:  CPU_analysis + CPU_selected  <  CPU_full
safety:    Outcome_selected,mutant  =  Outcome_full,mutant  =  FAIL
```

No HIGH/LOW labels, no composite score, no minimum percentage.

- **CPU is the primary economics metric.** Wall time is reported separately — parallel execution lets
  either hide the other.
- **Any full-fail / selected-pass case is a FALSE GREEN** and is reported at the top of the result, not
  in caveats.
- **Every refusal, FULL and empty selection stays in the denominator.**
- **Negative savings are preserved.** If DiffCI costs more on a candidate, the negative number is
  reported as measured.

## Report format

```
repository

full baseline:
  tests / CPU / wall

candidate N
  analysis CPU
  selected / total
  selected CPU
  DiffCI total CPU
  full mutant:      PASS / FAIL
  selected mutant:  PASS / FAIL
  compute reduction (may be negative)

measurable mutations
recall confirmed
false greens

aggregate CPU:
  full strategy / DiffCI strategy / absolute saved / percentage saved
```

## What a success would and would not establish

**Would:** `∃ workload: DiffCI safely saves compute`. One repository, under a sealed protocol, with
failure detection preserved.

**Would not:** anything about how often such workloads occur. That is the 21-repository funnel's
question, and it remains unspent and unprejudiced by this result.

The two claims are separable, and the first is not hostage to the second.
