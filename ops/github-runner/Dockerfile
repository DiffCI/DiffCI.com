# syntax=docker/dockerfile:1
#
# Ephemeral GitHub Actions self-hosted runner image, run as a Cloudflare Container instance (see
# wrangler.github-runner.jsonc + src/research/cloudflare/github-runner-worker.ts). One container
# instance = one job: the entrypoint registers a single `--ephemeral` runner against a specific repo,
# runs exactly one queued job, deregisters itself, and the process exits - at which point the container
# instance is torn down. There is no long-lived polling runner here, so idle compute is never billed;
# the Worker starts a fresh instance per `workflow_job.queued` webhook.
#
# Uses GitHub-hosted runner minutes for NOTHING - this compute is entirely Cloudflare Containers.
# GitHub only sees a normal self-hosted runner registration, which it does not bill for.
#
# glibc (not musl/Alpine) is required: the actions/runner agent is a .NET-based binary that doesn't
# support Alpine out of the box. This is why this image is Ubuntu-based while
# Dockerfile.research-sandbox (a different container, for the Stage 0/2 research pipeline) is Alpine.
FROM ubuntu:24.04

# Pin explicitly and bump deliberately - GitHub periodically deprecates old runner versions and will
# refuse to register with a stale one.
ARG RUNNER_VERSION=2.321.0
ARG RUNNER_ARCH=x64

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq \
      # Build toolchain covers this repo's own npm scripts (tsc, tsx --test). Extend per-repo if
      # DentalPresence.in's workflows need more (e.g. a different language runtime) - this image is
      # shared across both repos via the GH_OWNER/GH_REPO env vars, not baked per-repo.
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node 20, matching this repo's package.json engines.node requirement.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m runner
WORKDIR /home/runner

RUN curl -fsSL -o actions-runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
    && tar xzf actions-runner.tar.gz \
    && rm actions-runner.tar.gz \
    && ./bin/installdependencies.sh \
    && chown -R runner:runner /home/runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh

USER runner

# No exposed port and no HTTP server - this container is driven purely by env vars at start time
# (see Container.start({ envVars }) in github-runner-worker.ts), not by container.fetch(). The Worker
# must call the non-port-waiting `start()`, not `startAndWaitForPorts()`.
ENTRYPOINT ["/home/runner/entrypoint.sh"]
