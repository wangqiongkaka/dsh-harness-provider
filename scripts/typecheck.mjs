import ts from 'typescript';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const dsh = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
// The host ships the React type packages from its root node_modules in newer checkouts and from the client package that
// declared them in older ones; the first layout that exists wins so one script covers both host source trees.
const firstExisting = (...paths) => paths.find(path => existsSync(path)) ?? paths[0];
const reactTypes = firstExisting(
  resolve(dsh, 'node_modules/@types/react/index.d.ts'),
  resolve(dsh, 'packages/client/ui-agent-preset/node_modules/@types/react/index.d.ts'),
);
const reactDomTypes = firstExisting(
  resolve(dsh, 'node_modules/@types/react-dom/index.d.ts'),
  resolve(dsh, 'packages/client/ui-chat/node_modules/@types/react-dom/index.d.ts'),
);
const options = {
  jsx: ts.JsxEmit.ReactJSX, noEmit: true, resolveJsonModule: true, strict: true, skipLibCheck: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ['node'],
  paths: {
    react: [reactTypes],
    'react/*': [`${dirname(reactTypes)}/*.d.ts`],
    'react-dom': [reactDomTypes],
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
