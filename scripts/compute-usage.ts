/**
 * CPU actually consumed by a child process, not wall time.
 *
 * WHY WALL TIME IS THE WRONG UNIT. A 20-second test run can consume more compute than a 30-second one:
 * a suite that saturates four workers for 20 seconds costs ~80 CPU-seconds, while a serial suite that
 * spends 30 seconds mostly waiting on I/O costs a fraction of that. CI is billed by machine time, and
 * machine time tracks utilisation, not the clock. Every savings claim built on wall time is a claim
 * about how long someone waited, not about what anyone paid.
 *
 * HOW. Linux accounts REAPED children's CPU to their parent in `/proc/self/stat`: `cutime` (field 16)
 * and `cstime` (field 17), in clock ticks. Those fields are cumulative and recursive - a reaped child's
 * own children are included - so the delta across a `spawnSync` is the CPU consumed by that process
 * tree. `spawnSync` reaps, so the delta is complete by the time it returns.
 *
 * This deliberately does NOT use `process.resourceUsage()` or `process.cpuUsage()`: both report the
 * CURRENT process only, which for a harness that spawns test runners is almost entirely idle
 * bookkeeping and measures nothing of interest.
 *
 * LINUX ONLY, and honestly so. `/proc` does not exist on the Windows developer host, where this returns
 * undefined rather than a fabricated number. Compute evidence is therefore producible only in the
 * canonical environment, which is where it belongs anyway.
 */
import { readFileSync } from "node:fs";

/**
 * Clock ticks per second. 100 on every mainstream Linux configuration (`getconf CLK_TCK`), which Node
 * exposes no binding for.
 *
 * If it were ever wrong, it would scale EVERY measurement identically - so ratios between the four
 * components, and the sign of the incremental figure, are unaffected. Only absolute CPU-seconds would
 * be misstated, and the recorded tick count below lets any reader re-derive them.
 */
export const CLOCK_TICKS_PER_SECOND = 100;

export interface ChildCpuTicks {
  /** Cumulative user-mode ticks of all reaped children. */
  cutime: number;
  /** Cumulative kernel-mode ticks of all reaped children. */
  cstime: number;
}

/**
 * Reads cumulative reaped-children CPU for this process, or undefined where /proc is unavailable.
 *
 * The `comm` field can contain spaces and parentheses, so fields are indexed from the LAST `)` rather
 * than by splitting the whole line - the classic /proc/stat parsing trap.
 */
export function readChildCpuTicks(): ChildCpuTicks | undefined {
  let stat: string;
  try {
    stat = readFileSync("/proc/self/stat", "utf8");
  } catch {
    return undefined;
  }

  const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  // After `pid (comm)` the next field is `state`, which is index 0 here and field 3 overall. cutime is
  // field 16 and cstime field 17, so they sit at indices 13 and 14 of this remainder.
  const cutime = Number(afterComm[13]);
  const cstime = Number(afterComm[14]);
  if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return undefined;
  return { cutime, cstime };
}

/**
 * CPU-seconds consumed between two snapshots, or undefined if either is unavailable.
 *
 * Returns undefined rather than 0 when it cannot measure, for the same reason the test-output parsers
 * return undefined rather than 0: "could not tell" and "consumed nothing" are different facts, and a
 * savings calculation that silently treats the first as the second understates cost in exactly the
 * direction that flatters DiffCI.
 */
export function cpuSecondsBetween(before: ChildCpuTicks | undefined, after: ChildCpuTicks | undefined): number | undefined {
  if (!before || !after) return undefined;
  const ticks = after.cutime - before.cutime + (after.cstime - before.cstime);
  // A negative delta is impossible from monotonic counters and means the reading is untrustworthy.
  if (ticks < 0) return undefined;
  return ticks / CLOCK_TICKS_PER_SECOND;
}
