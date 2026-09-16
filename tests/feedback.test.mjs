import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';

test('Codex and Claude receive the same per-step progress contract', () => {
  const codex = codexProfile({ command: 'codex', environment: {} }).firstPromptPrefix;
  const claude = claudeProfile({ command: process.execPath, environment: {} }).sessionMeta('create').systemPrompt.append;
  assert.equal(codex, `${claude}\n\n`);
  assert.equal(claudeProfile({ command: process.execPath, environment: {} }).sessionMeta('resume', '\n\n[HOST]').systemPrompt.append, `${claude}\n\n[HOST]`); // the Codex prefix ends with a blank line before the user's words
  assert.match(codex, /每个执行步骤开始前，先用一句话说明该步骤的目标/);
  assert.doesNotMatch(codex, /简单任务不必重复播报/);
});
