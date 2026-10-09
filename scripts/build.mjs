import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { discussionSandbox } from './discussion-sandbox.mjs';

await mkdir('dist', { recursive: true });
await copyFile('src/delegate-cli.mjs', 'dist/delegate-cli.mjs');

// The Claude adapter pairs canUseTool (questions, plan approval) with every permission mode, so the SDK's
// bypassPermissions shadowing notice would land on DSH's stderr as a process warning on each native query.
// Only that bypass notice is dropped; the allowedTools variant is kept. A missing match fails the build.
const quietBypassNotice = {
  name: 'quiet-bypass-notice',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /codex-acp[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      // Codex posts the questions of request_user_input_async as a finished agent message (`delivery: "async"`) with no
      // deltas, and codex-acp forwards agent text only from deltas, so the questions would never show.
      let source = discussionSandbox(await readFile(path, 'utf8'));
      // Codex 0.160 omits the deprecated timer. DSH keeps untimed questions open even in Default mode;
      // isBlocking takes precedence, while an explicit legacy timer still expires.
      const inputWait = '    if (params.autoResolutionMs === null) {';
      if (source.split(inputWait).length !== 2) throw new Error('codex-acp user input wait seam changed');
      source = source.replace(inputWait, '    if (params.isBlocking === true || params.autoResolutionMs == null) {');
      const seam = '      case "agentMessage":\n        this.rememberAgentMessagePhase(event.item);\n        return null;\n      case "plan":\n        return await this.createCompletedPlanEvent(event.item);';
      if (source.split(seam).length !== 2) throw new Error('codex-acp completed agent message seam changed');
      return { contents: source.replace(seam, seam.replace('return null;', 'return event.item.delivery === "async" && event.item.text\n          ? createAgentTextMessageChunk(event.item.text, event.item.id, createMessagePhaseMeta(event.item.phase ?? null, this.sessionState.clientCapabilities.airClient)) : null;')), loader: 'js' };
    });
    // Claude replays marker-only /rename as a user turn although the CLI handled it locally.
    pluginBuild.onLoad({ filter: /claude-agent-acp[\\/]dist[\\/]acp-agent\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8'), seam = 'const REPLAY_HIDDEN_COMMANDS = new Set([\n';
      if (source.split(seam).length !== 2) throw new Error('claude-agent-acp local command replay seam changed');
      return { contents: source.replace(seam, seam + '    "/rename",\n'), loader: 'js' };
    });
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
  entryPoints: ['src/media.ts', 'src/secret-questions.ts', 'src/dsh-output.ts', 'src/contracts.ts', 'src/codex-rpc.ts', 'src/acp-adapter.ts', 'src/acp-profiles.ts', 'src/dsh.ts', 'src/dsh-runner.ts', 'src/bindings.ts', 'src/native-quota.ts', 'src/delegation.ts', 'src/worktree.ts', 'src/settings.ts', 'src/branch-context.ts'],
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

// The two ACP agent programs ship inside the plugin and run on the user's Codex / Claude Code executables
// (CODEX_PATH, CLAUDE_CODE_EXECUTABLE); the Codex npm binary package is therefore left out of the bundle.
for (const [entry, outfile, external] of [
  ['node_modules/@agentclientprotocol/codex-acp/dist/index.js', 'dist/codex-acp.mjs', ['@openai/codex']],
  ['node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', 'dist/claude-agent-acp.mjs', []],
]) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', external, logLevel: 'warning', plugins: [quietBypassNotice] });
}

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
  ['node_modules/@agentclientprotocol/sdk/LICENSE', 'acp-sdk.txt'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'claude-agent-sdk.md'],
  ['node_modules/@anthropic-ai/claude-agent-sdk/README.md', 'claude-agent-sdk-README.md'],
  ['node_modules/@agentclientprotocol/codex-acp/LICENSE', 'codex-acp.txt'],
  ['node_modules/@agentclientprotocol/claude-agent-acp/LICENSE', 'claude-agent-acp.txt'],
  ['licenses/codexhost.txt', 'codexhost.txt'],
]) await copyFile(source, resolve('dist/licenses', target));
