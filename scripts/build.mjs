import { createRequire } from 'node:module';
import { mkdir, cp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const reference = resolve(process.env.CODEXHOST_REFERENCE_ROOT ?? '../../codex-host');
const require = createRequire(resolve(reference, 'package.json'));
const { build } = require('esbuild');
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/codex-rpc.ts', 'src/codex-adapter.ts', 'src/dsh.ts', 'src/dsh-runner.ts', 'src/bindings.ts', 'src/native-quota.ts'],
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

// The vendored adapter probes the user's login environment with a synchronous interactive shell (`zsh -ilc`).
// An interactive shell with a controlling terminal takes over the terminal's foreground process group and leaves
// it pointing at its own dead group when it exits, after which Ctrl+C never reaches DSH again. Detaching the probe
// (setsid) gives it no controlling terminal, so it cannot touch the foreground group; it still reads the same rc files.
{
  const file = 'dist/claude-code/plugin.mjs';
  const source = await readFile(file, 'utf8');
  const probe = 'stdio: ["ignore", "pipe", "ignore"]';
  if (source.split(probe).length !== 2) throw new Error(`build: expected exactly one shell-environment probe in ${file}`);
  await writeFile(file, source.replace(probe, `${probe},\n    detached: process.platform !== "win32"`));
}

await build({
  entryPoints: ['src/client.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], nodePaths: [resolve(reference, 'node_modules')],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-harness-provider",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});

await mkdir('dist/licenses', { recursive: true });
for (const [source, target] of [
  ['node_modules/zod/LICENSE', 'zod.txt'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'claude-agent-sdk.md'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/README.md', 'claude-agent-sdk-README.md'],
  ['LICENSE', 'codexhost.txt'],
]) await copyFile(resolve(reference, source), resolve('dist/licenses', target));
