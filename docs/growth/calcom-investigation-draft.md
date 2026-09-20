# Our test filter silently ran the whole suite

Draft for review; not published by this task.

DiffCI initially identified two affected test files in a graph containing 424 test files in Cal.com.
The execution still covered essentially the workspace. A small selection in a report had not proved
that the test runner honored it.

The investigation found that the command's extra `--` caused argument forwarding to lose the intended
filter. We added an execution check comparing selected files against files actually run. Passing a
filter is not evidence that a runner applied it.

Later controlled runs, with the corrected harness, did honor selection. On one measured comparison,
the full test stage took 320.9 seconds and the selected stage 20.0 seconds. But installation took
319.7 seconds and pretest setup another 17.1 seconds. Those fixed costs remained in both paths.

The reconstructed install + pretest + test totals were 657.7 seconds and 356.9 seconds before analysis
overhead. After charging DiffCI's analysis overhead, the reduction was 44.2%, rather than the 90.6%
net reduction obtained when comparing only the test stage.

Five additional merges were selected using a rule written before timing them. Their test-stage net
reductions ranged from 86.0% to 91.6%. Those runs used approximately 249–250 discovered test files;
that is a different experimental scope from the initial 424-file graph. We do not combine the two
denominators or claim the later measurements validate every initially discovered file.

These are sandbox experiments on public source. Cal.com did not install DiffCI for this work, and
the numbers are not savings in its production CI. Three unique measurable mutation cases were caught;
that small sample does not establish general safety. Cases where the full suite detected no regression
do not count as successful recall checks.

The practical lesson is to measure three separate things: the proposed selection, what actually
executes, and the complete workload cost including setup and analysis. Each answers a different question.

Try observation mode in a supported checkout with Node.js 22.5+:

```sh
npx @diffci.com/diffci@0.1.3 observe --no-send
```

The command reports a proposed selection; it does not run the selected tests or measure savings.

## Evidence

- [Execution verification and initial file counts](../research/2026-08-24-calcom-execution-observability/03-controlled-rerun-and-runtime-selection-verification.md)
- [Job-equivalent timing and predeclared sampling](../research/2026-08-24-calcom-execution-observability/11-frozen-identity-and-complete-job-savings.md)
- [Five-merge results](../research/2026-08-24-calcom-execution-observability/13-five-merge-batch-results.md)
- [Case study and limitations](../website/case-studies/01-calcom.md)
