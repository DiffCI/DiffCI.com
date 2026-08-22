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

# Globalization-invariant mode: harmless belt-and-suspenders (the runner only shells out to
# git/npm/tsc, none of which need locale-aware culture formatting), but NOT sufficient on its own -
# see the libicu74 install below for why.
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# Pin explicitly and bump deliberately - GitHub periodically deprecates old runner versions and will
# refuse to register with a stale one.
ARG RUNNER_VERSION=2.336.0
ARG RUNNER_ARCH=x64
# Runtime-visible copy of the pinned version (ARG is build-time only) - entrypoint.sh logs it so the
# exfiltrated container log always states which agent version actually ran.
ENV RUNNER_VERSION_MARKER=${RUNNER_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq \
      # Build toolchain covers this repo's own npm scripts (tsc, tsx --test). Extend per-repo if
      # DentalPresence.in's workflows need more (e.g. a different language runtime) - this image is
      # shared across both repos via the GH_OWNER/GH_REPO env vars, not baked per-repo.
      build-essential \
      # The runner agent's bundled .NET runtime needs these at startup, checked by a static shell
      # preflight in the runner's own scripts (NOT bypassed by DOTNET_SYSTEM_GLOBALIZATION_INVARIANT -
      # that env var only affects actual runtime globalization calls, not this check). Installed
      # explicitly because the runner's bundled bin/installdependencies.sh (still below) only knows
      # package names up to libicu72/libssl1.1 and silently fails to install anything on Ubuntu 24.04
      # "noble", which ships libicu74/libssl3 - found live 2026-08-21 as "Libicu's dependencies is
      # missing for Dotnet Core 6.0" when the runner agent actually started.
      libicu74 libssl3 libkrb5-3 zlib1g liblttng-ust1 \
    && rm -rf /var/lib/apt/lists/*

# Node 22, matching this repo's package.json engines.node requirement (bumped 2026-08-22: the SaaS
# foundation build's test suite (tests/**/store.test.ts) uses node:sqlite's DatabaseSync, which is only
# available from Node 22.5.0 onward - the previous Node 20 pin here caused every real CI run to fail with
# ERR_UNKNOWN_BUILTIN_MODULE from the moment those tests were first committed, invisibly, because local
# development happened on a newer Node version where the module IS available. This exact gap is Case
# Study #1 in docs/research/2026-08-22-preflight-p0-historical-failure-study.md - a config/environment-
# parity mismatch a deterministic Preflight check could have caught before any CI minutes were spent.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m runner
WORKDIR /home/runner

RUN curl -fsSL -o actions-runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
    && tar xzf actions-runner.tar.gz \
    && rm actions-runner.tar.gz \
    # Best-effort only (`|| true`) - the explicit apt-get install above already covers what this repo's
    # jobs actually need; this script's own package list is stale for Ubuntu 24.04 and would otherwise
    # fail the whole build over dependencies (old libssl/liblttng names) we don't rely on it for.
    && (./bin/installdependencies.sh || true) \
    && chown -R runner:runner /home/runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
# Strip any CRLF line endings before chmod - a CRLF shebang ("#!/usr/bin/env bash\r") makes the kernel
# look for a binary literally named "bash\r", which doesn't exist, and the container exits 127 with no
# other clue. .gitattributes normalizes this at checkout, but this line makes the image correct
# regardless of how/where it was built (found live 2026-08-21 on a Windows checkout that predated
# .gitattributes).
RUN sed -i 's/\r$//' /home/runner/entrypoint.sh && chmod +x /home/runner/entrypoint.sh

USER runner

# No exposed port and no HTTP server - this container is driven purely by env vars at start time
# (see Container.start({ envVars }) in github-runner-worker.ts), not by container.fetch(). The Worker
# must call the non-port-waiting `start()`, not `startAndWaitForPorts()`.
ENTRYPOINT ["/home/runner/entrypoint.sh"]
