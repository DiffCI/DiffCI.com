# R2.1 Part C.15 — pre-registered interpretation, `basic` diagnostic

Written before the `basic` (1 GiB memory, 1/4 vCPU, 4 GB disk) run against the SAME command that
exited 137 on `lite` (0.25→ actually 1/16 vCPU per real Cloudflare docs, 256 MiB memory, 2 GB disk):
`deepseek-ai/deepseek-harness` @ HEAD `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`,
`pnpm install --filter @deepseek-ai/dsh-timeout... --ignore-scripts`.

- **If `basic` succeeds**: evidence strongly supports insufficient `lite` resources as a major cause
  (H1). Not conclusive on its own — `basic` changes BOTH memory and vCPU simultaneously, not an
  isolated single variable, so this strengthens rather than proves H1.
- **If `basic` also exits 137**: resource pressure likely requires more than 1 GiB, or another kill
  mechanism exists (Cloudflare-side wall-clock/egress policy, not visible from this side). Escalate to
  one `standard-1` run per Part C.17.
- **If `basic` fails because of registry connectivity** (repeated `registry.npmjs.org` errors, not a
  kill signal): treat network/package-acquisition reliability as a first-class blocker independent of
  instance shape (H2), regardless of what happens to H1.
- **If `basic` succeeds but remains extremely slow** (order of minutes): the architecture still needs
  dependency-state reuse (Part D) even though memory was sufficient — right-sizing alone doesn't solve
  the commercial problem.

This interpretation is not rewritten after seeing the result.
