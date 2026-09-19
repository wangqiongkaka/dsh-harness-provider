import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';

test('Codex and Claude receive the same per-step progress contract', () => {
  const codexInstructions = (environment, instructions) => JSON.parse(codexProfile({ command: 'codex', environment: {} }).spawn(environment, instructions).env.CODEX_CONFIG);
  const codex = codexInstructions({}).developer_instructions;
  const claude = claudeProfile({ command: process.execPath, environment: {} }).sessionMeta('create').systemPrompt.append;
  assert.equal(codex, claude);
  assert.equal(claudeProfile({ command: process.execPath, environment: {} }).sessionMeta('resume', '\n\n[HOST]').systemPrompt.append, `${claude}\n\n[HOST]`);
  assert.equal(codexInstructions({}, '\n\n[HOST]').developer_instructions, `${claude}\n\n[HOST]`);
  // Codex developer instructions join a CODEX_CONFIG the user already set instead of replacing it.
  assert.deepEqual(codexInstructions({ CODEX_CONFIG: JSON.stringify({ model: 'm', developer_instructions: 'MINE' }) }), { model: 'm', developer_instructions: `MINE\n\n${claude}` });
  assert.match(codex, /每个执行步骤开始前，先用一句话说明该步骤的目标/);
  assert.match(codex, /调用 Bash 时用中文提供简短的 description/); // the activity list reads in Chinese
  assert.doesNotMatch(codex, /简单任务不必重复播报/);
  // Every visible line is Chinese whatever the language of code, tool output or system notices.
  assert.match(codex, /所有可见文字使用中文/);
  assert.doesNotMatch(codex, /用户的语言|用户最近一条消息的语言/);
  assert.match(codex, /不要因为代码、工具输出、系统提示.*使用其他语言而切换/);
  assert.match(codex, /代码、命令、路径.*保持原样/);
});
