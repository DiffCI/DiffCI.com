import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";

/** Only direct imports registered in a literal component options object are provable. */
function registeredComponents(source: string): Set<string> {
  const file = ts.createSourceFile("component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  const factories = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    if (clause?.name) imports.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if (binding.isTypeOnly) continue;
        imports.add(binding.name.text);
        if (ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "vue" && (binding.propertyName ?? binding.name).text === "defineComponent") factories.add(binding.name.text);
      }
    }
  }
  const names = new Set<string>();
  const exp = file.statements.find(ts.isExportAssignment);
  if (!exp || exp.isExportEquals) return names;
  let value = exp.expression;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && factories.has(value.expression.text) && value.arguments.length === 1) value = value.arguments[0];
  if (!ts.isObjectLiteralExpression(value) || value.properties.some(p => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) return names;
  const registrations = value.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "components");
  if (registrations.length !== 1 || !ts.isPropertyAssignment(registrations[0]) || !ts.isObjectLiteralExpression(registrations[0].initializer)) return names;
  for (const property of registrations[0].initializer.properties) {
    if (ts.isShorthandPropertyAssignment(property) && imports.has(property.name.text)) names.add(property.name.text);
    else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && ts.isIdentifier(property.initializer) && imports.has(property.initializer.text)) names.add(property.name.text);
    else return new Set();
  }
  return new Set([...names].flatMap(name => [name, name.replace(/\B([A-Z])/g, "-$1").toLowerCase()]));
}
import { contribution, type RepositoryAdapter } from "./types.js";

/** Explicit Vue SFC imports. Runtime component registries and preprocessors require full CI. */
export const vueAdapter: RepositoryAdapter = {
  id: "vue", version: "3", kind: "framework",
  detect: ({ files }) => files.some((file) => file.endsWith(".vue")),
  analyze(context) {
    const result = contribution(this);
    const dependencies = [...context.profile.packageJson.dependencies, ...context.profile.packageJson.devDependencies];
    if (dependencies.includes("nuxt") || context.files.some((file) => /(?:^|\/)nuxt\.config\./.test(file))) {
      result.blockers.push("Nuxt implicit routes and auto-imports require a dedicated framework adapter");
    }
    for (const path of context.files.filter((file) => file.endsWith(".vue"))) {
      result.sourcePaths.push(path);
      const block = (reason: string) => result.blockers.push(`Vue ${path}: ${reason}`);
      try {
        const raw = readFileSync(join(context.repoPath, path), "utf8");
        // compiler-sfc discards an empty script block then reports a missing block.
        // Recognize only this exact dependency-free SFC shape, not arbitrary parse errors.
        if (/^\s*<script(?:\s+setup)?(?:\s+lang=["'](?:ts|js)["'])?\s*>\s*<\/script>\s*$/.test(raw)) {
          result.virtualSources.push({ path, source: "export default {};" });
          continue;
        }
        const { descriptor, errors } = parse(raw, { filename: join(context.repoPath, path) });
        if (errors.length) block("component parse failed");
        if (descriptor.customBlocks.length) block("custom blocks require a framework plugin");
        const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template, ...descriptor.styles].filter((b) => b !== null);
        for (const b of blocks) {
          if (b.src) block("external SFC blocks are not yet modeled");
          if (b.lang && !["js", "ts", "jsx", "tsx", "html", "css"].includes(b.lang)) block(`unsupported preprocessor ${b.lang}`);
        }
        const typeDependencies = new Set<string>();
        const script = descriptor.script || descriptor.scriptSetup
          ? compileScript(descriptor, { id: path, fs: {
            fileExists: existsSync,
            readFile(file) {
              const dependency = relative(context.repoPath, resolve(file)).replace(/\\/g, "/");
              if (dependency === ".." || dependency.startsWith("../") || isAbsolute(dependency)) throw new Error("Vue type dependency escapes repository");
              typeDependencies.add(dependency);
              return readFileSync(file, "utf8");
            },
          } }) : undefined;
        // Imported macro types affect generated runtime props. Retain the files read
        // by the compiler even when the generated script erases their imports.
        for (const dependency of typeDependencies) {
          if (/\.[cm]?[jt]sx?$/.test(dependency)) result.sourcePaths.push(dependency);
          else result.assetPaths.push(dependency);
          result.edges.push({ from: path, to: dependency, kind: "asset" });
        }
        let source = script?.content ?? "";
        if (/\bimport\.meta\.glob(?:Eager)?\s*\(/.test(source)) block("glob imports require bundler dependency expansion");
        if (descriptor.template && !descriptor.template.src && !descriptor.template.lang) {
          const template = compileTemplate({
            source: descriptor.template.content, filename: path, id: path,
            compilerOptions: { bindingMetadata: script?.bindings },
          });
          if (template.errors.length) block("template compilation failed");
          // These calls represent dependencies supplied at runtime, outside the import graph.
          const registrations = registeredComponents(source);
          const unresolved = [...template.code.matchAll(/\b_resolveComponent\s*\(\s*(["'])(.*?)\1/g)].some(match => !registrations.has(match[2]));
          if (unresolved || /\b_resolve(?:DynamicComponent|Directive)\s*\(/.test(template.code)) block("runtime component/directive resolution requires full validation");
          source += `\n${template.code}`;
        } else if (descriptor.template) block("external or preprocessed template requires full validation");
        for (const style of descriptor.styles) {
          // CSS imports/URLs may be rewritten by arbitrary bundler plugins. Do not guess.
          if (/@import\b|url\s*\(/i.test(style.content)) block("style imports or URLs require full validation");
        }
        result.virtualSources.push({ path, source });
      } catch {
        block("component could not be analyzed");
      }
    }
    return result;
  },
};
