import type { TaskCategory } from "./types.js";

export type CITaskCategory = TaskCategory;

export interface CITaskDefinition {
  id: string;
  command: string;
  category: CITaskCategory;
  alwaysRun?: boolean;
  description?: string;
  npmScript?: string;
  inputPatterns?: string[];
  globalRiskTriggers?: string[];
}

export interface TaskRegistry {
  all(): CITaskDefinition[];
  get(id: string): CITaskDefinition | undefined;
  tasksByCategory(category: CITaskCategory): CITaskDefinition[];
  alwaysRunTasks(): CITaskDefinition[];
}

function wildcardToRegex(pattern: string): RegExp {
  let escaped = pattern
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\0GLOBSTAR\0")
    .replace(/\*/g, "[^/]*");
  escaped = escaped.replace(/\0GLOBSTAR\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

class InMemoryTaskRegistry implements TaskRegistry {
  private readonly definitions: Map<string, CITaskDefinition>;

  constructor(definitions: CITaskDefinition[]) {
    this.definitions = new Map();
    for (const def of definitions) {
      this.definitions.set(def.id, def);
    }
  }

  all(): CITaskDefinition[] {
    return Array.from(this.definitions.values());
  }

  get(id: string): CITaskDefinition | undefined {
    return this.definitions.get(id);
  }

  tasksByCategory(category: CITaskCategory): CITaskDefinition[] {
    return this.all().filter((t) => t.category === category);
  }

  alwaysRunTasks(): CITaskDefinition[] {
    return this.all().filter((t) => t.alwaysRun === true);
  }

  matchesInputPattern(taskId: string, paths: string[]): boolean {
    const task = this.definitions.get(taskId);
    if (!task || !task.inputPatterns || task.inputPatterns.length === 0) return false;
    const regexes = task.inputPatterns.map(wildcardToRegex);
    return paths.some((p) => regexes.some((re) => re.test(p)));
  }
}

export function createTaskRegistry(definitions: CITaskDefinition[]): TaskRegistry {
  return new InMemoryTaskRegistry(definitions);
}

const DENTAL_PRESENCE_TASK_DEFINITIONS: CITaskDefinition[] = [
  {
    id: "typecheck",
    command: "tsc --noEmit --pretty false",
    npmScript: "typecheck",
    category: "typecheck",
    description: "TypeScript type checking for the entire codebase.",
    alwaysRun: false,
    inputPatterns: [
      "src/**/*.{ts,tsx}",
      "scripts/**/*.{ts,tsx,mjs,js}",
      "ops/**/*.{ts,tsx,mjs,js}",
      "database/**/*.ts",
      "tsconfig*.json",
      "package*.json",
      "next.config.*",
    ],
    globalRiskTriggers: [
      "CONFIG_GLOBAL",
      "DEPENDENCY_MANIFEST",
      "LOCKFILE_GLOBAL",
      "NEXT_CONFIG_GLOBAL",
    ],
  },
  {
    id: "lint",
    command: "eslint \"src/**/*.{ts,tsx}\"",
    npmScript: "lint",
    category: "lint",
    description: "ESLint over source files.",
    alwaysRun: false,
    inputPatterns: ["src/**/*.{ts,tsx}", "eslint.config.*", ".eslintrc*"],
    globalRiskTriggers: ["CONFIG_GLOBAL"],
  },
  {
    id: "lint:wordpress",
    command: "node scripts/lint-wordpress-plugins.mjs",
    npmScript: "lint:wordpress",
    category: "lint",
    description: "WordPress plugin lint rules.",
    alwaysRun: false,
    inputPatterns: ["src/**/*.ts", "src/**/*.tsx", "scripts/lint-wordpress-plugins.mjs"],
    globalRiskTriggers: [],
  },
  {
    id: "check:unused",
    command: "node scripts/check-unused-source.js",
    npmScript: "check:unused",
    category: "validation",
    description: "Detect unused source files.",
    alwaysRun: false,
    inputPatterns: ["src/**/*", "scripts/check-unused-source.js"],
    globalRiskTriggers: [],
  },
  {
    id: "check:links",
    command: "npm run check:links",
    npmScript: "check:links",
    category: "validation",
    description: "Markdown and documented link validation.",
    alwaysRun: false,
    inputPatterns: ["**/*.md", "**/*.mdx", "docs/**/*", "scripts/check-links.js"],
    globalRiskTriggers: ["CONFIG_GLOBAL"],
  },
  {
    id: "check:social-utm",
    command: "npm run check:social-utm",
    npmScript: "check:social-utm",
    category: "validation",
    description: "Validate social media UTM parameters.",
    alwaysRun: false,
    inputPatterns: [
      "ops/marketing/social-publishing-tracker.csv",
      "scripts/social-utm.mjs",
      "ops/marketing/**/*",
    ],
    globalRiskTriggers: [],
  },
  {
    id: "check:routes",
    command: "node scripts/find-unused-pages.js",
    npmScript: "check:routes",
    category: "validation",
    description: "Detect stale or unused Next.js routes.",
    alwaysRun: false,
    inputPatterns: [
      "src/app/**/*",
      "src/app/**/page.tsx",
      "src/app/**/route.ts",
      "scripts/find-unused-pages.js",
    ],
    globalRiskTriggers: [],
  },
  {
    id: "check:cloudflare-api-shield",
    command: "npm run check:cloudflare-api-shield",
    npmScript: "check:cloudflare-api-shield",
    category: "security",
    description: "Validate Cloudflare API Shield schema.",
    alwaysRun: true,
    inputPatterns: [
      "scripts/generate-cloudflare-api-shield-schema.mjs",
      "src/app/api/**/*",
      "src/lib/api/**/*",
      "openapi/**/*",
    ],
    globalRiskTriggers: ["CONFIG_GLOBAL"],
  },
  {
    id: "validate:portability",
    command: "npm run validate:portability",
    npmScript: "validate:portability",
    category: "validation",
    description: "Container and deployment portability validation.",
    alwaysRun: false,
    inputPatterns: [
      "ops/**/*",
      "Dockerfile*",
      "docker/**/*",
      "scripts/validate-portable*.mjs",
      "scripts/validate-infrastructure-portability.mjs",
    ],
    globalRiskTriggers: ["INFRASTRUCTURE_GLOBAL"],
  },
  {
    id: "validate:aws:components",
    command: "npm run validate:aws",
    npmScript: "validate:aws",
    category: "infrastructure",
    description: "AWS deployment component validation.",
    alwaysRun: false,
    inputPatterns: [
      "ops/aws/**/*",
      "ops/cloudflare/**/*",
      "scripts/validate-aws*.mjs",
      "scripts/validate-production-drift.test.mjs",
    ],
    globalRiskTriggers: ["INFRASTRUCTURE_GLOBAL"],
  },
  {
    id: "validate:aws:production-account",
    command: "npm run validate:aws:production-account",
    npmScript: "validate:aws:production-account",
    category: "infrastructure",
    description: "AWS production account safety checks.",
    alwaysRun: true,
    inputPatterns: ["scripts/validate-aws-production-account.mjs", "ops/aws/**/*"],
    globalRiskTriggers: ["INFRASTRUCTURE_GLOBAL", "WORKFLOW_GLOBAL"],
  },
  {
    id: "test:source",
    command: "npm run test:source",
    npmScript: "test:source",
    category: "test",
    description: "Colocated source tests.",
    alwaysRun: false,
    inputPatterns: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
    globalRiskTriggers: ["CONFIG_GLOBAL", "LOCKFILE_GLOBAL"],
  },
  {
    id: "test:scripts",
    command: "npm run test:scripts",
    npmScript: "test:scripts",
    category: "test",
    description: "Operational script tests.",
    alwaysRun: false,
    inputPatterns: ["scripts/**/*.test.{js,mjs,ts}", "scripts/**/*.test.mjs"],
    globalRiskTriggers: ["CONFIG_GLOBAL", "LOCKFILE_GLOBAL"],
  },
  {
    id: "test:ops",
    command: "npm run test:ops",
    npmScript: "test:ops",
    category: "test",
    description: "Ops/infrastructure tests.",
    alwaysRun: false,
    inputPatterns: ["ops/**/*.test.{js,mjs,ts}", "ops/**/*.test.mjs"],
    globalRiskTriggers: ["INFRASTRUCTURE_GLOBAL"],
  },
  {
    id: "test:security",
    command: "npm run test:security",
    npmScript: "test:security",
    category: "security",
    description: "Security guardrail tests.",
    alwaysRun: true,
    inputPatterns: ["scripts/test-security.js", "src/lib/security/**/*", "ops/security/**/*"],
    globalRiskTriggers: ["CONFIG_GLOBAL", "WORKFLOW_GLOBAL", "INFRASTRUCTURE_GLOBAL"],
  },
  {
    id: "test:api-guardrails",
    command: "npm run test:api-guardrails",
    npmScript: "test:api-guardrails",
    category: "security",
    description: "API guardrail simulations.",
    alwaysRun: true,
    inputPatterns: [
      "scripts/test-api-guardrails.ts",
      "src/lib/api/**/*",
      "src/app/api/**/*",
    ],
    globalRiskTriggers: ["CONFIG_GLOBAL"],
  },
  {
    id: "build:next",
    command: "npm run build",
    npmScript: "build",
    category: "build",
    description: "Next.js production build.",
    alwaysRun: false,
    inputPatterns: [
      "src/**/*",
      "next.config.*",
      "tailwind.config.*",
      "postcss.config.*",
      "tsconfig*.json",
    ],
    globalRiskTriggers: [
      "CONFIG_GLOBAL",
      "DEPENDENCY_MANIFEST",
      "LOCKFILE_GLOBAL",
      "NEXT_CONFIG_GLOBAL",
    ],
  },
  {
    id: "build:cloudflare-dry-run",
    command: "npm run cloudflare:build:dry",
    npmScript: "cloudflare:build:dry",
    category: "build",
    description: "Cloudflare dry-run build validation.",
    alwaysRun: false,
    inputPatterns: ["src/**/*", "next.config.*", "ops/cloudflare/**/*", "wrangler.toml"],
    globalRiskTriggers: ["CONFIG_GLOBAL", "INFRASTRUCTURE_GLOBAL"],
  },
  {
    id: "check:migrations",
    command: "npm run db:check-parity",
    npmScript: "db:check-parity",
    category: "infrastructure",
    description: "Database migration parity check.",
    alwaysRun: true,
    inputPatterns: [
      "database/migrations/**/*.sql",
      "scripts/check-migration-parity.mjs",
      "database/README.md",
    ],
    globalRiskTriggers: ["DATABASE_GLOBAL"],
  },
];

export function buildDentalPresenceTaskRegistry(): TaskRegistry {
  return createTaskRegistry(DENTAL_PRESENCE_TASK_DEFINITIONS);
}
