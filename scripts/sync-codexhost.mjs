// Maintainer only: refreshes vendor/codexhost from a built codex-host checkout. Build, typecheck and tests read the vendored copy.
import { execFileSync } from 'node:child_process';
import { cp, glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const host = resolve(process.argv[2] ?? process.env.CODEXHOST_REFERENCE_ROOT ?? '../../codex-host');
const out = 'vendor/codexhost';
await rm(out, { recursive: true, force: true });

// Contracts: runtime JS and declarations only. Workspace dependencies are dropped; zod comes from this project's devDependencies.
for (const name of ['harness-adapter', 'shared-contracts']) {
  const from = join(host, 'packages', name), to = join(out, name);
  const pkg = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
  for await (const file of glob('dist/**/*.{js,d.ts}', { cwd: from })) {
    await mkdir(dirname(join(to, file)), { recursive: true });
    await cp(join(from, file), join(to, file));
  }
  delete pkg.dependencies; delete pkg.scripts;
  await writeFile(join(to, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}
await cp(join(host, 'packages/host-runtime/dist/plugins/claude-code'), join(out, 'claude-code'), { recursive: true });
await cp(join(host, 'LICENSE'), join(out, 'LICENSE'));
for (const file of ['LICENSE.md', 'README.md']) await cp(join(host, 'node_modules/@anthropic-ai/claude-agent-sdk', file), join(out, 'claude-agent-sdk', file));

const git = (...args) => execFileSync('git', ['-C', host, ...args], { encoding: 'utf8' }).trim();
const source = { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0,
  zod: JSON.parse(await readFile(join(host, 'node_modules/zod/package.json'), 'utf8')).version,
  claudeAgentSdk: JSON.parse(await readFile(join(host, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version };
await writeFile(join(out, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
console.log(`vendored codex-host ${source.commit.slice(0, 8)}${source.dirty ? ' (dirty)' : ''}; zod ${source.zod}`);
