#!/usr/bin/env bash
# Registers this container as a single ephemeral GitHub Actions runner, waits for exactly one job,
# runs it, deregisters, and exits. All config arrives as env vars set by the Worker when it starts this
# container instance (github-runner-worker.ts) - nothing repo-specific is baked into the image, so the
# same image serves both DiffCI.com and DentalPresence.in.
set -euo pipefail

: "${GH_OWNER:?must be set, e.g. adityankale190895}"
: "${GH_REPO:?must be set, e.g. DiffCI.com or DentalPresence.in}"
: "${RUNNER_TOKEN:?must be set - short-lived (1hr, single-use) registration token minted by the Worker via the GitHub API}"
RUNNER_LABELS="${RUNNER_LABELS:-cloudflare,ephemeral}"

# ---------------------------------------------------------------------------------------------
# Container-stdout exfiltration (2026-08-21). wrangler tail only surfaces the WORKER's own console
# output, never what config.sh/run.sh print inside the container - the sixth debugging trigger died
# invisibly because of exactly that gap ("container exited normally, job never picked up, no error
# anywhere"). Everything this script prints is teed to a logfile and POSTed to the Worker's
# /container-log route (which console.logs it, making it tail-visible): once on every exit path
# (including set -e failures and SIGTERM from the platform's activity timeout), and every 20s as a
# heartbeat so even a hard-killed container leaves its partial output behind.
# LOG_SINK_URL/LOG_SINK_TOKEN/LOG_TAG are optional - absent (e.g. local docker run), pure no-ops.
# ---------------------------------------------------------------------------------------------
LOGFILE=/tmp/runner-container.log
: > "$LOGFILE"
upload_log() {
  if [ -n "${LOG_SINK_URL:-}" ] && [ -n "${LOG_SINK_TOKEN:-}" ]; then
    curl -fsS -m 15 -X POST -H "Authorization: Bearer ${LOG_SINK_TOKEN}" \
      -H "Content-Type: text/plain" --data-binary @"$LOGFILE" \
      "${LOG_SINK_URL}?tag=${LOG_TAG:-untagged}" >/dev/null 2>&1 || true
  fi
}
( while true; do sleep 20; upload_log; done ) &
HEARTBEAT_PID=$!
on_exit() {
  status=$?
  kill "$HEARTBEAT_PID" 2>/dev/null || true
  echo "entrypoint: exiting with status ${status}" >> "$LOGFILE" 2>/dev/null || true
  upload_log
}
trap on_exit EXIT
trap 'echo "entrypoint: received SIGTERM (platform stop - activity timeout or teardown)" >> "$LOGFILE"; upload_log; exit 143' TERM
exec > >(tee -a "$LOGFILE") 2>&1

# HOSTNAME is NOT unique per container instance - every Cloudflare Container reports the literal
# hostname "cloudchamber", so the original "cf-${GH_REPO}-${HOSTNAME}" collided across ALL instances.
# Combined with --replace, each new container replaced the previous one's registration: the earlier
# runner's session died mid-listen ("Runner connect error: The signature is not valid"), siblings got
# "Error: Conflict", and at most one runner existed at a time - THE root cause of jobs sitting queued
# while containers "exited normally" (exfiltrated-log finding, 2026-08-21). LOG_TAG (job-<id> or
# drain-<uuid>) is genuinely unique per instance; timestamp+PID+RANDOM covers a missing tag.
RUNNER_NAME="cf-${GH_REPO}-${LOG_TAG:-$(date +%s)-$$-${RANDOM}}"

echo "entrypoint: runner agent ${RUNNER_VERSION_MARKER:-unknown-version}, registering ${RUNNER_NAME} for ${GH_OWNER}/${GH_REPO} labels=${RUNNER_LABELS}"

# --disableupdate: an ephemeral one-job runner must never spend its life self-updating - we pin the
# agent version in the Dockerfile and bump it there deliberately. (Also removes a silent failure
# mode: a stale agent that decides to self-update inside a throwaway container can exit without ever
# taking the job, which is indistinguishable from success at the Worker layer.)
./config.sh \
  --url "https://github.com/${GH_OWNER}/${GH_REPO}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --ephemeral \
  --disableupdate \
  --unattended
# --replace deliberately REMOVED: with unique names it can never match, and keeping it would silently
# mask any future name-collision regression instead of failing loudly at config time.

echo "entrypoint: config.sh succeeded, starting run.sh"

# --ephemeral means the runner service deregisters itself after exactly one job (success or failure),
# so a crashed or stuck container never lingers as a phantom registered runner blocking future jobs.
# run.sh returning is this container's own signal to exit - the Worker does not need to separately
# deregister on the happy path.
./run.sh

echo "entrypoint: run.sh completed"
