import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slash = (value) => value.replaceAll("\\", "/");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

export function inspectArchitecture(projectRoot = root) {
  const violations = [];
  const edges = new Map();
  const files = ["src", "server"].flatMap((dir) => walk(path.join(projectRoot, dir))).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const modules = new Set(fs.readdirSync(path.join(projectRoot, "src/modules"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const moduleOf = (file) => slash(path.relative(projectRoot, file)).match(/^src\/modules\/([^/]+)\//)?.[1];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const owner = moduleOf(file);
    const visit = (node) => {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
      if (specifier) {
        const target = specifier.startsWith("@/") ? path.resolve(projectRoot, "src", specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
        if (target) {
          const relative = slash(path.relative(projectRoot, target));
          const match = relative.match(/^src\/modules\/([^/]+)\/(public|internal)\//);
          const at = `${slash(path.relative(projectRoot, file))}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          if (/^src\/lib\/(market|auth|kyb|notifications)(\/|$)/.test(relative)) violations.push(`${at}: legacy domain import ${specifier}`);
          if (relative.startsWith("src/modules/") && !match) violations.push(`${at}: use a public or internal module entry point`);
          if (match) {
            const [, destination, visibility] = match;
            if (!modules.has(destination)) violations.push(`${at}: unknown module ${destination}`);
            if (owner !== destination && visibility !== "public") violations.push(`${at}: private import into ${destination}`);
            if (!["", ".ts", ".tsx", ".js", ".mjs"].some((extension) => fs.existsSync(target + extension))) violations.push(`${at}: unresolved module entry ${specifier}`);
            if (owner && owner !== destination) {
              if (!edges.has(owner)) edges.set(owner, new Set());
              edges.get(owner).add(destination);
              if (owner === "shared") violations.push(`${at}: shared contracts must not depend on business modules`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Reject dependency cycles so modules remain extractable behind their contracts.
  const visited = new Set();
  const active = [];
  const visitModule = (name) => {
    if (active.includes(name)) {
      violations.push('Module dependency cycle: ' + [...active.slice(active.indexOf(name)), name].join(' -> '));
      return;
    }
    if (visited.has(name)) return;
    active.push(name);
    for (const next of edges.get(name) ?? []) visitModule(next);
    active.pop();
    visited.add(name);
  };
  for (const name of modules) visitModule(name);
  return { violations, modules: [...modules].sort(), dependencies: Object.fromEntries([...edges].sort().map(([name, targets]) => [name, [...targets].sort()])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectArchitecture();
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Architecture PASS: ${result.modules.length} modules; public boundaries and shared contracts verified.`);
    console.log(JSON.stringify(result.dependencies, null, 2));
  }
}
