import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeProfile } from '../dist/acp-profiles.js';

test('Claude sessions keep the Artifact tool enabled', () => {
  const { env } = claudeProfile({ command: process.execPath, environment: {} }).spawn({});
  // The SDK spawns the CLI with CLAUDE_CODE_ENTRYPOINT=sdk-ts, which drops the Artifact tools (and with them
  // /design's canvas) unless CLAUDE_CODE_ARTIFACT is truthy. Opt back in so ACP sessions match the native TUI.
  assert.equal(env.CLAUDE_CODE_ARTIFACT, '1');
});

test('CLAUDE_COMMAND_PATH names the Claude Code executable when the setting is empty, and a missing one never falls back', () => {
  const profile = claudeProfile({ environment: {} });
  assert.equal(profile.spawn({ CLAUDE_COMMAND_PATH: process.execPath }).env.CLAUDE_CODE_EXECUTABLE, process.execPath);
  assert.throws(() => profile.spawn({ CLAUDE_COMMAND_PATH: '/nonexistent/claude' }), error => error.code === 'notInstalled');
});
