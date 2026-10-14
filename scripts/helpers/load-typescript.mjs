import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);

// Execute the actual module, substituting only explicit external boundaries.
export function loadTypeScript(file, dependencies = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const resolve = (id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith('@/modules/')) return loadTypeScript(path.resolve('src', id.slice(2)) + '.ts', dependencies);
    if (id.startsWith('.')) {
      const target = path.resolve(path.dirname(file), id);
      return loadTypeScript(`${target}.ts`, dependencies);
    }
    if (id.startsWith('node:') || id === 'zod') return require(id);
    throw new Error(`Test dependency must be explicit: ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: file })(resolve, module, module.exports);
  return module.exports;
}
export function serverFunctionStub() {
  return { middleware() { return this; }, validator(schema) { this.schema = schema; return this; }, handler(fn) {
    const schema = this.schema;
    return (input) => fn({ ...input, data: schema ? schema.parse(input.data) : input.data });
  } };
}
