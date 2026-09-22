import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { HarnessService, inject } from '../dist/dsh.js';
import { DshOutput } from '../dist/dsh-output.js';

test('Harness completion bypasses native skill injection and preserves restorable step boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-step-interception-'));
  const ctx = new Context();
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {}
  }
  try {
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Typert, Commands]) await ctx.plugin(plugin);
    ctx.provide('skills', { snapshot: async () => ({ complete: true, skills: [{ name: 'fixture', description: 'fixture', invocation: { modelInvocable: true, userInvocable: true } }] }) });
    ctx.provide('userQuestions', {}); ctx.provide('attachments', {}); ctx.provide('fileUploads', {});
    await ctx.plugin(SkillTool);
    const adapter = { async close() {} };
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: adapter, 'claude-code': adapter }); } });
    let runs = 0;
    ctx.harness.runner.run = async ({ agent, turn, step }) => {
      runs++;
      agent.session.append('step/start', { turn, step });
      const output = new DshOutput(ctx, agent, { turn, step }, () => 1, () => ({ provider: 'codex', model: 'fixture' }));
      for (const itemId of ['first', 'last']) await output.complete({ item: { type: 'agentMessage', itemId, text: itemId }, outcome: { status: 'succeeded' } });
      await output.finish();
      agent.session.append('step/end', { turn, step: output.step });
    };
    await ctx.plugin(Loop, { agents: [] });
    const id = SessionId('step-interception');
    await ctx.harness.bindings.write({ version: 1, sessionId: id, harness: 'codex', cwd: root, locked: true });
    const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: root, delegationDepth: 0 } });
    for (let i = 0; i < 2; i++) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }));
      await agent.whenIdle();
    }
    const events = agent.session.snapshotEvents();
    assert.equal(runs, 2);
    assert.deepEqual(events.filter(e => e.type === 'step/start').map(e => [e.data.turn, e.data.step]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
    const ends = events.filter(e => e.type === 'turn/end').map(e => e.data.reason);
    assert.deepEqual(ends.map(reason => reason.kind), ['completed', 'completed'], JSON.stringify(ends));
    restoreReleasedV4Artifact({ header: agent.session.header, events, inheritedEventCount: 0 }, new Set(events.map(e => e.type)));
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
