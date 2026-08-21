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

# HOSTNAME is unique per container instance, so this is unique per job without needing a job id passed in.
RUNNER_NAME="cf-${GH_REPO}-${HOSTNAME:-$$}"

./config.sh \
  --url "https://github.com/${GH_OWNER}/${GH_REPO}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --ephemeral \
  --unattended \
  --replace

# --ephemeral means the runner service deregisters itself after exactly one job (success or failure),
# so a crashed or stuck container never lingers as a phantom registered runner blocking future jobs.
# run.sh returning is this container's own signal to exit - the Worker does not need to separately
# deregister on the happy path.
./run.sh
