import { extname } from "node:path";
import type { CommandSpec } from "./types.js";

export interface SelectiveTestCommandGroup {
  runnerId: string;
  label: string;
  commandSpec: CommandSpec;
  paths: string[];
}

function shellEscape(arg: string): string {
  return arg.replace(/([\s'"\\$|&;<>(){}\[\]*?#~`])/g, "\\$1");
}

export function commandSpecToString(spec: CommandSpec): string {
  return [spec.executable, ...spec.args.map(shellEscape)].join(" ");
}

export function groupTestPaths(paths: string[]): SelectiveTestCommandGroup[] {
  const groups = new Map<string, string[]>();

  for (const p of paths) {
    const ext = extname(p).toLowerCase();
    let runner = p.startsWith("ops/") ? "ops" : p.startsWith("scripts/") ? "scripts" : "tsx";

    if (ext === ".mjs" || ext === ".js") {
      runner = runner === "ops" ? "node-ops" : runner === "scripts" ? "node-scripts" : "node";
    }

    const arr = groups.get(runner) ?? [];
    arr.push(p);
    groups.set(runner, arr);
  }

  return Array.from(groups.entries()).map(([runner, runnerPaths]) => {
    if (runner === "tsx") {
      return {
        runnerId: runner,
        label: "colocated source tests (tsx)",
        commandSpec: {
          executable: "tsx",
          args: ["--conditions", "react-server", "--test", ...runnerPaths],
        },
        paths: runnerPaths,
      };
    }

    if (runner === "node" || runner === "node-scripts" || runner === "node-ops") {
      return {
        runnerId: runner,
        label: runner === "node-ops" ? "ops tests (node)" : "script tests (node)",
        commandSpec: {
          executable: "node",
          args: [...runnerPaths],
        },
        paths: runnerPaths,
      };
    }

    if (runner === "ops") {
      return {
        runnerId: runner,
        label: "ops tests",
        commandSpec: {
          executable: "tsx",
          args: ["--test", ...runnerPaths],
        },
        paths: runnerPaths,
      };
    }

    return {
      runnerId: runner,
      label: "script tests",
      commandSpec: {
        executable: "tsx",
        args: ["--test", ...runnerPaths],
      },
      paths: runnerPaths,
    };
  });
}

export function generateSelectiveTestCommandSpecs(paths: string[]): CommandSpec[] {
  return groupTestPaths(paths).map((g) => g.commandSpec);
}
