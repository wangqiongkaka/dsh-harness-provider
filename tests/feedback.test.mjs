import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';

test('Codex and Claude receive the same per-step progress contract', () => {
  const codex = codexProfile({ command: 'codex', environment: {} }).firstPromptPrefix;
  const claude = claudeProfile({ command: process.execPath, environment: {} }).sessionMeta('create').systemPrompt.append;
  assert.equal(codex, claude);
  assert.match(codex, /每个执行步骤开始前，先用一句话说明该步骤的目标/);
  assert.doesNotMatch(codex, /简单任务不必重复播报/);
});
