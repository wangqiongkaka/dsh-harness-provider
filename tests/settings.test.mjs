import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, defaultSettings, settingsOf } from '../dist/settings.js';
import { Config as PluginConfig } from '../dist/dsh.js';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';
import { DelegationBridge } from '../dist/delegation.js';

// The built-in progress contract, as the profiles injected it before it became a setting.
const feedbackInstructions = defaultSettings().progressFeedbackText;
test('the plugin Config keeps the former built-in defaults, rejects out-of-range values, and is what the Loader validates with', () => {
  assert.deepEqual(settingsOf(PluginConfig({}))(), defaultSettings(), "the entry exports the plugin Config");
  assert.match(feedbackInstructions, /^\[DSH 进展反馈\][\s\S]*每个执行步骤开始前[\s\S]*\[\/DSH 进展反馈\]$/);
  assert.deepEqual(defaultSettings(), {
    codexCommand: 'codex', claudeCommand: undefined, idleCloseSeconds: 60,
    delegateHarnesses: ['codex'], delegateReportBack: false, delegateWorktree: false, discussHarnesses: ['codex', 'claude-code'],
    progressFeedback: true, progressFeedbackText: feedbackInstructions,
    requestTimeoutSeconds: 60, sessionLoadTimeoutSeconds: 120, discussionTimeoutMinutes: 30,
    toolOutputChars: 64_000, peerReviewChars: 12_000, discussionResultChars: 16_000,
    catalogCacheSeconds: 60, quotaCacheSeconds: 60, pluginCacheSeconds: 30, recoveryCheckSeconds: 30, acpStderr: false,
  });
  // The existing profile entry options still parse; `root` stays an ordinary, non-live field.
  const parsed = Config['~standard'].validate({ root: '/state', codexCommand: '/bin/codex' }).value;
  assert.equal(parsed.root, '/state');assert.equal(settingsOf(parsed)().codexCommand, '/bin/codex');assert.equal('root' in settingsOf(parsed)(), false);
  for (const invalid of [{ idleCloseSeconds: 1 }, { discussionResultChars: 64_001 }, { quotaCacheSeconds: 5 }, { delegateHarnesses: ['other'] }, { discussHarnesses: ['dsh'] }]) {
    assert.ok(Config['~standard'].validate(invalid).issues?.length, JSON.stringify(invalid));
  }
});

test('both profiles read the live settings on every use: executables, the feedback contract and the ACP limits', () => {
  let current = { ...defaultSettings(), codexCommand: '/opt/codex', claudeCommand: process.execPath, requestTimeoutSeconds: 7, sessionLoadTimeoutSeconds: 9, toolOutputChars: 1234, acpStderr: true };
  const settings = () => current;
  const codex = codexProfile({ environment: {}, settings }), claude = claudeProfile({ environment: {}, settings });
  const developer = () => JSON.parse(codex.spawn({}, '\n\n[HOST]').env.CODEX_CONFIG).developer_instructions;
  assert.equal(codex.spawn({}).env.CODEX_PATH, '/opt/codex');
  assert.equal(claude.spawn({ PATH: '' }).env.CLAUDE_CODE_EXECUTABLE, process.execPath);
  assert.equal(developer(), `${feedbackInstructions}\n\n[HOST]`);
  assert.deepEqual(codex.limits(), { requestTimeoutMs: 7000, loadTimeoutMs: 9000, toolOutputChars: 1234, stderr: true });
  assert.deepEqual(claude.limits(), codex.limits());
  // An edit reaches the next spawn and session without rebuilding the profile.
  current = { ...current, codexCommand: 'codex-next', progressFeedbackText: '[CUSTOM]' };
  assert.equal(codex.spawn({}).env.CODEX_PATH, 'codex-next');
  assert.equal(developer(), '[CUSTOM]\n\n[HOST]');
  assert.equal(claude.sessionMeta('create', '\n\n[HOST]').systemPrompt.append, '[CUSTOM]\n\n[HOST]');
  // Turned off, only the Host's own instructions remain.
  current = { ...current, progressFeedback: false };
  assert.equal(developer(), '\n\n[HOST]');
  assert.equal(claude.sessionMeta('resume').systemPrompt.append, '');
  // An explicit command still pins the executable over the setting.
  assert.equal(codexProfile({ command: 'pinned', environment: {}, settings }).spawn({}).env.CODEX_PATH, 'pinned');
});

test('the delegation CLI waits for a discussion as long as the setting said when its session process started', async () => {
  let minutes = 30;
  const bridge = new DelegationBridge(async () => ({}), () => minutes * 60_000);
  try {
    assert.equal((await bridge.environment('source')).DSH_DELEGATE_DISCUSS_TIMEOUT_MS, '1800000');
    minutes = 2;
    assert.equal((await bridge.environment('source')).DSH_DELEGATE_DISCUSS_TIMEOUT_MS, '120000');
  } finally { await bridge.close(); }
});

test('the schema DSH Settings sends to the page still accepts the values after a JSON round trip', async () => {
  const { default: Schema } = await import('@deepseek-ai/schemastery');
  // The Host serializes the form schema with toJSON; the page rebuilds it and validates the section before showing it.
  const rebuilt = new Schema(JSON.parse(JSON.stringify(Config.toJSON())));
  assert.doesNotThrow(() => rebuilt(defaultSettings()));
  assert.throws(() => rebuilt({ ...defaultSettings(), discussionResultChars: 64_001 }), /64000/);
  assert.throws(() => rebuilt({ ...defaultSettings(), idleCloseSeconds: 1 }));
});
