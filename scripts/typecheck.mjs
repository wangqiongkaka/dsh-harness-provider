import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const reference = resolve(process.env.CODEXHOST_REFERENCE_ROOT ?? '../../codex-host');
const dsh = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const require = createRequire(resolve(reference, 'package.json'));
const ts = require('typescript');
const options = {
  jsx: ts.JsxEmit.ReactJSX, noEmit: true, resolveJsonModule: true, strict: true, skipLibCheck: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  typeRoots: [resolve(reference, 'node_modules/@types')], types: ['node'],
  paths: {
    '@codexhost/*': [resolve(reference, 'packages/*/dist/index.d.ts')],
    zod: [resolve(reference, 'node_modules/zod/index.d.ts')],
    react: [resolve(dsh, 'packages/client/ui-agent-preset/node_modules/@types/react/index.d.ts')],
    'react/*': [resolve(dsh, 'packages/client/ui-agent-preset/node_modules/@types/react/*.d.ts')],
  },
};
// Host and browser augment the same Cordis keys with different services.
for (const entries of [ts.sys.readDirectory('src', ['.ts']), ['src/client.tsx']]) {
  const program = ts.createProgram(entries, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }));
    process.exitCode = 1;
  }
}
