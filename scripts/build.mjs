import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
await copyFile('src/delegate-cli.mjs', 'dist/delegate-cli.mjs');

// The Claude adapter pairs canUseTool (questions, plan approval) with every permission mode, so the SDK's
// bypassPermissions shadowing notice would land on DSH's stderr as a process warning on each native query.
// Only that bypass notice is dropped; the allowedTools variant is kept. A missing match fails the build.
const quietBypassNotice = {
  name: 'quiet-bypass-notice',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /claude-agent-sdk[\\/]sdk\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const notice = /return"canUseTool will not be invoked: permissionMode 'bypassPermissions'[^"]*";/g;
      const hits = source.match(notice)?.length ?? 0;
      if (hits !== 1) throw new Error(`build: expected one bypassPermissions canUseTool notice in the Claude Agent SDK, found ${hits}`);
      return { contents: source.replace(notice, 'return;'), loader: 'js' };
    });
  },
};
await build({
  entryPoints: ['src/contracts.ts', 'src/codex-rpc.ts', 'src/codex-adapter.ts', 'src/claude-adapter.ts', 'src/dsh.ts', 'src/dsh-runner.ts', 'src/bindings.ts', 'src/native-quota.ts', 'src/delegation.ts'],
  external: ['@deepseek-ai/*'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  plugins: [quietBypassNotice],
});

await build({
  entryPoints: ['src/client.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-harness-provider",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});

await mkdir('dist/licenses', { recursive: true });
for (const [source, target] of [
  ['node_modules/zod/LICENSE', 'zod.txt'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'claude-agent-sdk.md'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/README.md', 'claude-agent-sdk-README.md'],
  ['licenses/codexhost.txt', 'codexhost.txt'],
]) await copyFile(source, resolve('dist/licenses', target));
