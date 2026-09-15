import { createRequire } from 'node:module';
import { mkdir, cp, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const reference = resolve(process.env.CODEXHOST_REFERENCE_ROOT ?? '../../codex-host');
const require = createRequire(resolve(reference, 'package.json'));
const { build } = require('esbuild');
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/codex-rpc.ts', 'src/codex-adapter.ts', 'src/dsh.ts', 'src/dsh-runner.ts', 'src/bindings.ts'],
  external: ['@deepseek-ai/*', './claude-code/plugin.mjs'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  nodePaths: [resolve(reference, 'node_modules')],
});

await cp(resolve(reference, 'packages/host-runtime/dist/plugins/claude-code'), 'dist/claude-code', { recursive: true });

await build({
  entryPoints: ['src/client.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], nodePaths: [resolve(reference, 'node_modules')],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-harness-plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});

await mkdir('dist/licenses', { recursive: true });
for (const [source, target] of [
  ['node_modules/zod/LICENSE', 'zod.txt'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'claude-agent-sdk.md'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/README.md', 'claude-agent-sdk-README.md'],
  ['LICENSE', 'codexhost.txt'],
]) await copyFile(resolve(reference, source), resolve('dist/licenses', target));
