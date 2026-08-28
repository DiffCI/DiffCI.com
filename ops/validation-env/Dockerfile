# The DiffCI validation environment.
#
# ONE canonical, reasonable, modern CI environment. A repository either works in it or it does not,
# and that verdict is the qualification. This image is deliberately NOT a place where per-repository
# accommodations accumulate - the moment it grows a branch for one project's quirk, the corpus stops
# measuring "can DiffCI validate real repositories" and starts measuring "how much archaeology are we
# willing to do".
#
# WHY IT EXISTS. Qualification on the development host (Windows) excluded both monorepos tried and
# admitted both single-package libraries. That is an evidence-selection bias pointing the wrong way:
# monorepos are where the graph-explosion question actually lives, so safety evidence was becoming
# available only from the class of repository where the question matters least. Left unaddressed, a
# future headline of "0 false greens across 50 measurable mutations" would rest mostly on easy
# single-package repositories, which is far weaker than it sounds.
#
# WHAT IS PERMITTED, and this list is the whole contract:
#   - a full git clone with real history (some builds ask git what changed; that is a normal property
#     of those builds, not environment reconstruction)
#   - the repository's own declared package manager, via corepack
#   - the repository's documented install
#   - the repository's documented build
#   - two full baseline runs
#
# WHAT IS NOT, at any point, for any repository:
#   - databases, message queues, or any external service
#   - credentials, tokens, or network access to anything but a package registry and the git remote
#   - historical or per-repository Node versions
#   - bespoke patching of a repository's source or configuration to make its suite pass
#
# A repository that needs anything on the second list is reported as unqualified, with the reason. That
# is a finding about reproducibility, not a task.

FROM node:22.14.0-bookworm-slim

# Native modules are common enough in real repositories that omitting a toolchain would disqualify
# them for a reason that has nothing to do with DiffCI. git is here for the full-history clone.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Corepack ships with Node and provides whichever package manager a repository declares in
# `packageManager`. Enabling it here is what lets a repository's own build script call `pnpm` or `yarn`
# BY NAME - the exact failure that disqualified zod on the development host, where those binaries were
# reachable only through `corepack <manager>`.
RUN corepack enable

# Every child process the harness spawns inherits these. The download prompt is the one that matters:
# corepack asks before fetching an uncached package manager, and with no usable stdin that prompt kills
# the install. It disqualified TanStack/query once already.
ENV CI=1 \
    FORCE_COLOR=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=6144

WORKDIR /work

# The harness itself, its corpus, and the built agent tarball are mounted rather than baked in, so the
# image does not need rebuilding every time a script changes:
#
#   docker run --rm \
#     -v "$PWD:/work" \
#     -v diffci-validation-cache:/root/.cache \
#     diffci-validation \
#     npm run dogfood:qualify -- --only TanStack/query --write
#
# The named cache volume keeps corepack downloads and package-manager stores warm between runs, which
# is the difference between a qualification taking four minutes and taking twenty.

CMD ["bash"]
