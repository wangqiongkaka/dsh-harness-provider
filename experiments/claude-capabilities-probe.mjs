import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeCodeAdapter } from '../dist/claude-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const { startMessagesFixture } = await import(pathToFileURL(join(reference, 'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const command = process.env.CLAUDE_COMMAND ?? '/opt/homebrew/bin/claude';
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };

async function scenario(behavior, setup, prompt, respond) {
  const fixture = await startMessagesFixture(behavior);
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-capabilities-'));
  const home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(home, 'settings.json'), '{}');
  await setup?.(root);
  const adapter = new ClaudeCodeAdapter({ environment: {
    PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: fixture.baseUrl,
    CODEXHOST_CLAUDE_COMMAND: command, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_PROXY: '127.0.0.1,localhost',
  } });
  try {
    const session = unwrap(await adapter.open({ kind: 'create', cwd: root, permissionModeId: 'bypassPermissions' }));
    const output = session.outputs[Symbol.asyncIterator](), seen = [];
    unwrap(await session.execute({ type: 'turn.start', turnId: 'probe', input: [{ type: 'text', text: prompt }] }));
    for (;;) {
      const next = await output.next(); assert.equal(next.done, false); seen.push(next.value);
      if (next.value.kind === 'interaction') await respond?.(session, next.value.interaction);
      if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') {
        assert.equal(next.value.event.outcome.status, 'succeeded', JSON.stringify(next.value));
        return { fixture, root, seen };
      }
    }
  } finally { await adapter.close(); await fixture.close(); }
}

const cleanups = [];
try {
  const mcp = await scenario({ kind: 'tool-use', toolName: 'mcp__probe__ask', input: {}, finalText: 'mcp-complete' }, async root => {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [join(here, 'claude-mcp-fixture.mjs')] } } }));
  }, 'Use the probe ask tool', async (session, interaction) => {
    assert.equal(interaction.type, 'question');
    assert.equal(interaction.questions[0].id, 'region');
    unwrap(await session.execute({ type: 'interaction.respond', interactionId: interaction.interactionId,
      response: { type: 'question', answers: { region: ['eu'] } } }));
  });
  cleanups.push(mcp.root);
  const tool = mcp.seen.find(output => output.kind === 'event' && output.event.type === 'item.completed' && output.event.snapshot.item.type === 'toolExecution');
  assert.match(tool.event.snapshot.item.output.content[0].text, /MCP:accept:eu/);
  console.log('PASS: real Claude CLI loads project MCP, executes its tool, and bridges MCP elicitation through DSH');

  const hookMarker = join(tmpdir(), `dsh-hook-${process.pid}.log`); cleanups.push(hookMarker);
  const hook = await scenario({ kind: 'complete', text: 'hook-complete' }, async root => {
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${join(here, 'claude-hook-fixture.mjs')}" context "${hookMarker}"` }] }] } }));
  }, 'Run the project hook');
  cleanups.push(hook.root);
  assert.match(await readFile(hookMarker, 'utf8'), /context:UserPromptSubmit/);
  assert.ok(hook.fixture.requests.some(request => JSON.stringify(request.body.messages).includes('DSH_HOOK_CONTEXT')));
  console.log('PASS: real Claude CLI runs project hooks and adds hook feedback to model context');

  const blockMarker = join(tmpdir(), `dsh-hook-block-${process.pid}.log`); cleanups.push(blockMarker);
  const blocked = await scenario({ kind: 'complete', text: 'MODEL_MUST_NOT_RUN' }, async root => {
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${join(here, 'claude-hook-fixture.mjs')}" block "${blockMarker}"` }] }] } }));
  }, 'This prompt should be blocked');
  cleanups.push(blocked.root);
  assert.equal(blocked.fixture.requests.length, 0, 'blocked hook still reached the model');
  assert.match(await readFile(blockMarker, 'utf8'), /block:UserPromptSubmit/);
  assert.match(blocked.seen.filter(output => output.kind === 'event' && output.event.type === 'item.completed' && output.event.snapshot.item.type === 'agentMessage')
    .map(output => output.event.snapshot.item.text).join('\n'), /DSH_HOOK_BLOCKED/);
  console.log('PASS: real Claude CLI hook blocking stops the model request and DSH renders the reason');

  const slash = await scenario({ kind: 'complete', text: 'MODEL_MUST_NOT_RUN' }, undefined, '/help');
  cleanups.push(slash.root);
  assert.equal(slash.fixture.requests.length, 0, '/help was sent to the model instead of handled by Claude Code');
  const text = slash.seen.filter(output => output.kind === 'event' && output.event.type === 'item.completed' && output.event.snapshot.item.type === 'agentMessage')
    .map(output => output.event.snapshot.item.text).join('\n');
  assert.ok(text.trim(), 'slash-command output was not visible through DSH');
  console.log('PASS: real Claude CLI handles /help locally and DSH renders its output');
} finally {
  await Promise.all(cleanups.map(path => rm(path, { recursive: true, force: true })));
}
