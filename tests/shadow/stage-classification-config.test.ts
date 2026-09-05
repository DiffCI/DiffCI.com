/**
 * stage-classification-config.ts (2026-09-05, repair step 3): explicit job/step rules with provenance,
 * conservative inference only without config, inseparable work kept but never estimated. Pinned on the
 * two real shapes: DiffCI.com's single "check" job (typecheck AND test in one `npm run check` step) and
 * DentalPresence.in's tests inside "Build and deploy exact commit to Cloudflare".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRunJobs, inferStageConservatively, isInseparable, parseStageClassificationConfig } from "../../src/shadow/stage-classification-config.js";
import type { BaselineJobInfo } from "../../src/shadow/types.js";

const DP_DEPLOY_JOB = "Build and deploy exact commit to Cloudflare";
const DP_CHECK_JOB = "Typecheck, lint, and portability";

function dpJobs(): BaselineJobInfo[] {
  return [
    { jobId: 1, jobName: DP_CHECK_JOB, status: "completed", conclusion: "success", durationMs: 104_000, steps: [{ name: "Run checks", status: "completed", durationMs: 90_000 }] },
    {
      jobId: 2, jobName: DP_DEPLOY_JOB, status: "completed", conclusion: "success", durationMs: 672_000,
      steps: [
        { name: "Install and test", status: "completed", durationMs: 240_000 },
        { name: "Validate Cloudflare deployment plan", status: "completed", durationMs: 30_000 },
        { name: "Deploy Cloudflare staging", status: "completed", durationMs: 390_000 },
      ],
    },
  ];
}

const DP_CONFIG = parseStageClassificationConfig({
  version: 1,
  jobs: [
    { job: DP_CHECK_JOB, stage: "typecheck", inseparable: true },
    { job: DP_DEPLOY_JOB, stage: "build" },
  ],
  steps: [{ job: DP_DEPLOY_JOB, step: "Install and test", stage: "test", inseparable: true }],
}).config!;

describe("parseStageClassificationConfig", () => {
  it("accepts a well-formed config and rejects every malformed shape with a reason", () => {
    assert.ok(DP_CONFIG);
    assert.equal(parseStageClassificationConfig(null).error, "config must be an object");
    assert.equal(parseStageClassificationConfig({ version: 2, jobs: [] }).error, "version must be 1");
    assert.equal(parseStageClassificationConfig({ version: 1, jobs: [], steps: [] }).error, "config must contain at least one job or step rule");
    assert.match(parseStageClassificationConfig({ version: 1, jobs: [{ job: "check", stage: "deploy" }] }).error!, /unknown stage/);
    assert.match(parseStageClassificationConfig({ version: 1, jobs: [{ job: "check", stage: "test" }, { job: "check", stage: "lint" }] }).error!, /duplicate job rule/);
    assert.match(parseStageClassificationConfig({ version: 1, steps: [{ job: "a", step: "s", stage: "test" }, { job: "a", step: "s", stage: "test" }] }).error!, /duplicate step rule/);
    assert.match(parseStageClassificationConfig({ version: 1, jobs: [{ job: "check", stage: "test", inseparable: "yes" }] }).error!, /inseparable/);
  });
});

describe("classifyRunJobs - explicit configuration", () => {
  it("DentalPresence.in: the test step is attributed as inseparable test work, the deploy remainder as build, the check job as inseparable typecheck", () => {
    const buckets = classifyRunJobs(dpJobs(), DP_CONFIG);
    const by = Object.fromEntries(buckets.map((b) => [`${b.stage}|${b.basis}`, b]));
    assert.equal(by["test|explicit_step_inseparable"]!.durationMs, 240_000);
    assert.deepEqual(by["test|explicit_step_inseparable"]!.stepRefs, [`${DP_DEPLOY_JOB} :: Install and test`]);
    assert.equal(by["build|explicit_job"]!.durationMs, 672_000 - 240_000, "the job rule gets the job minus what its step rules took");
    assert.equal(by["typecheck|explicit_job_inseparable"]!.durationMs, 104_000);
    assert.equal(buckets.length, 3);
  });

  it("DiffCI.com today: one 'check' job, one mixed step -> the job rule applies, inseparable; no test figure is invented", () => {
    const config = parseStageClassificationConfig({
      version: 1,
      jobs: [{ job: "check", stage: "test", inseparable: true }],
      steps: [
        { job: "check", step: "Typecheck", stage: "typecheck" },
        { job: "check", step: "Test", stage: "test" },
      ],
    }).config!;
    const mixed: BaselineJobInfo[] = [{ jobId: 9, jobName: "check", status: "completed", conclusion: "success", durationMs: 150_000, steps: [{ name: "Run npm run check", status: "completed", durationMs: 140_000 }] }];
    const buckets = classifyRunJobs(mixed, config);
    assert.deepEqual(buckets.map((b) => [b.stage, b.basis, b.durationMs]), [["test", "explicit_job_inseparable", 150_000]]);
    assert.equal(isInseparable(buckets[0]!.basis), true);
  });

  it("DiffCI.com after splitting the step: step rules attribute typecheck and test separably, the remainder (checkout, npm ci) is the inseparable job rule", () => {
    const config = parseStageClassificationConfig({
      version: 1,
      jobs: [{ job: "check", stage: "test", inseparable: true }],
      steps: [
        { job: "check", step: "Typecheck", stage: "typecheck" },
        { job: "check", step: "Test", stage: "test" },
      ],
    }).config!;
    const split: BaselineJobInfo[] = [{ jobId: 9, jobName: "check", status: "completed", conclusion: "success", durationMs: 150_000, steps: [
      { name: "Set up job", status: "completed", durationMs: 5_000 },
      { name: "Run npm ci", status: "completed", durationMs: 40_000 },
      { name: "Typecheck", status: "completed", durationMs: 25_000 },
      { name: "Test", status: "completed", durationMs: 75_000 },
    ] }];
    const by = Object.fromEntries(classifyRunJobs(split, config).map((b) => [`${b.stage}|${b.basis}`, b.durationMs]));
    assert.equal(by["test|explicit_step"], 75_000);
    assert.equal(by["typecheck|explicit_step"], 25_000);
    assert.equal(by["test|explicit_job_inseparable"], 50_000, "remainder = 150 - 25 - 75");
  });

  it("a configured repository never infers: an unmatched job is 'other'/'unclassified' even if its name says test", () => {
    const buckets = classifyRunJobs([{ jobId: 1, jobName: "unit tests", status: "completed", durationMs: 1_000 }], DP_CONFIG);
    assert.deepEqual(buckets.map((b) => [b.stage, b.basis]), [["other", "unclassified"]]);
  });

  it("jobs and steps without a positive duration attribute nothing", () => {
    assert.deepEqual(classifyRunJobs([{ jobId: 1, jobName: DP_CHECK_JOB, status: "completed" }], DP_CONFIG), []);
  });
});

describe("classifyRunJobs - conservative inference without configuration", () => {
  it("infers only when exactly one stage's keywords match", () => {
    assert.equal(inferStageConservatively("unit tests"), "test");
    assert.equal(inferStageConservatively("lint"), "lint");
    assert.equal(inferStageConservatively("check"), undefined, "the DiffCI.com job name matches nothing - not guessed");
    assert.equal(inferStageConservatively("build and test"), undefined, "two stages match - ambiguous, not guessed");
  });

  it("labels inferred buckets 'inferred_job' and everything else 'unclassified'", () => {
    const jobs: BaselineJobInfo[] = [
      { jobId: 1, jobName: "unit tests", status: "completed", durationMs: 10 },
      { jobId: 2, jobName: "check", status: "completed", durationMs: 20 },
    ];
    assert.deepEqual(classifyRunJobs(jobs, undefined).map((b) => [b.stage, b.basis, b.durationMs]), [["test", "inferred_job", 10], ["other", "unclassified", 20]]);
  });
});
