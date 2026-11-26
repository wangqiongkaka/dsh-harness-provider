import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeProfile } from '../dist/acp-profiles.js';
import { defaultSettings } from '../dist/settings.js';

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

async function fakeCli(dir, name = 'reclaude') {
  const file = join(dir, name);
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'status' && args[1] === '--json') {
  if (process.env.TEST_STATUS_COUNTER) fs.appendFileSync(process.env.TEST_STATUS_COUNTER, '1\\n');
  if (process.env.TEST_STATUS_EXIT && process.env.TEST_STATUS_EXIT !== '0') process.exit(Number(process.env.TEST_STATUS_EXIT));
  process.stdout.write(process.env.TEST_STATUS_JSON ?? '');
  process.exit(0);
}
if (process.env.TEST_CAPTURED_ENV) {
  fs.writeFileSync(process.env.TEST_CAPTURED_ENV, JSON.stringify({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }));
}
process.exit(1);
`;
  await writeFile(file, script, 'utf8');
  await chmod(file, 0o755);
  return file;
}

test('configuring reclaude injects its active binding CLAUDE_CONFIG_DIR and follows account switches', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'reclaude-spawn-'));
  const localBin = join(root, '.local', 'bin');
  const counter = join(root, 'status-calls');
  await mkdir(localBin, { recursive: true });
  try {
    const cli = await fakeCli(localBin, 'reclaude');
    const native = await fakeCli(localBin, 'claude');
    const alias = join(root, 'my-claude');
    await symlink(cli, alias);
    const dataDir = join(root, '.rec');
    const status = deviceId => JSON.stringify({ global: { data_dir: dataDir }, claude: { current: { device_id: deviceId } } });

    // Native `claude` never probes `status --json` or sets CLAUDE_CONFIG_DIR.
    const nativeEnv = claudeProfile({ command: native, environment: {} }).spawn({
      HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_JSON: status(57531), TEST_STATUS_COUNTER: counter,
    }).env;
    assert.equal(nativeEnv.CLAUDE_CODE_EXECUTABLE, native);
    assert.equal(nativeEnv.CLAUDE_CONFIG_DIR, undefined);
    await assert.rejects(readFile(counter, 'utf8'), { code: 'ENOENT' });

    // Bare name `reclaude` resolves from ~/.local/bin even when launchd's PATH lacks it, and injects CLAUDE_CONFIG_DIR.
    const profile = claudeProfile({ command: 'reclaude', environment: {} });
    const first = profile.spawn({ HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_JSON: status(57531), TEST_STATUS_COUNTER: counter }).env;
    assert.equal(first.CLAUDE_CODE_EXECUTABLE, cli);
    assert.equal(first.CLAUDE_CONFIG_DIR, join(dataDir, 'claude', 'accounts', '57531', 'config'));

    // Switching active binding is reflected on the next spawn.
    const switched = profile.spawn({ HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_JSON: status(90002), TEST_STATUS_COUNTER: counter }).env;
    assert.equal(switched.CLAUDE_CONFIG_DIR, join(dataDir, 'claude', 'accounts', '90002', 'config'));

    // A symlink pointing to reclaude is recognized as reclaude too.
    const viaSymlink = claudeProfile({ environment: {} }).spawn({
      CLAUDE_COMMAND_PATH: alias, HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_JSON: status(57531), TEST_STATUS_COUNTER: counter,
    }).env;
    assert.equal(viaSymlink.CLAUDE_CODE_EXECUTABLE, alias);
    assert.equal(viaSymlink.CLAUDE_CONFIG_DIR, join(dataDir, 'claude', 'accounts', '57531', 'config'));

    // Explicit CLAUDE_CONFIG_DIR wins and skips probing `reclaude status --json`.
    const callsBeforeExplicit = (await readFile(counter, 'utf8')).trim().split('\n').length;
    const customDir = join(root, 'custom-config');
    const explicit = profile.spawn({
      HOME: root, PATH: '', SHELL: '/bin/false', CLAUDE_CONFIG_DIR: customDir, TEST_STATUS_JSON: status(57531), TEST_STATUS_COUNTER: counter,
    }).env;
    assert.equal(explicit.CLAUDE_CONFIG_DIR, customDir);
    const callsAfterExplicit = (await readFile(counter, 'utf8')).trim().split('\n').length;
    assert.equal(callsAfterExplicit, callsBeforeExplicit);

    // Unbound / failing `reclaude status --json` degrades gracefully without setting CLAUDE_CONFIG_DIR.
    const unbound = profile.spawn({ HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_JSON: JSON.stringify({ global: { data_dir: dataDir }, claude: {} }) }).env;
    assert.equal(unbound.CLAUDE_CONFIG_DIR, undefined);
    const failed = profile.spawn({ HOME: root, PATH: '', SHELL: '/bin/false', TEST_STATUS_EXIT: '1' }).env;
    assert.equal(failed.CLAUDE_CONFIG_DIR, undefined);

    // A configured `reclaude` that is absent never falls back to a native `claude`.
    const claudeOnlyHome = await mkdtemp(join(tmpdir(), 'reclaude-missing-'));
    try {
      const nativeBin = join(claudeOnlyHome, '.local', 'bin');
      await mkdir(nativeBin, { recursive: true });
      await fakeCli(nativeBin, 'claude');
      assert.throws(() => profile.spawn({ HOME: claudeOnlyHome, PATH: nativeBin, SHELL: '/bin/false' }), error => error.code === 'notInstalled');
    } finally {
      await rm(claudeOnlyHome, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude account inspection also forwards reclaude CLAUDE_CONFIG_DIR to the spawned CLI', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'reclaude-inspector-'));
  const capturedPath = join(root, 'captured.json');
  try {
    const cli = await fakeCli(root, 'reclaude');
    const dataDir = join(root, '.rec');
    const profile = claudeProfile({
      command: cli,
      environment: {
        HOME: root,
        SHELL: '/bin/false',
        TEST_CAPTURED_ENV: capturedPath,
        TEST_STATUS_JSON: JSON.stringify({ global: { data_dir: dataDir }, claude: { current: { device_id: 12345 } } }),
      },
    });
    await assert.rejects(() => profile.inspectAccount());
    const captured = JSON.parse(await readFile(capturedPath, 'utf8'));
    assert.equal(captured.CLAUDE_CONFIG_DIR, join(dataDir, 'claude', 'accounts', '12345', 'config'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuring claudeConfigDir injects CLAUDE_CONFIG_DIR, expands ~/, wins over env and reclaude probing, and applies to account inspection', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-config-dir-'));
  const counter = join(root, 'status-calls');
  const capturedPath = join(root, 'captured.json');
  try {
    const cli = await fakeCli(root, 'reclaude');
    let current = { ...defaultSettings(), claudeCommand: cli, claudeConfigDir: '~/.rec/claude/accounts/2048/config' };
    const profile = claudeProfile({
      environment: { HOME: root, SHELL: '/bin/false', TEST_CAPTURED_ENV: capturedPath, TEST_STATUS_COUNTER: counter },
      settings: () => current,
    });
    const expected = join(root, '.rec', 'claude', 'accounts', '2048', 'config');

    // Configured claudeConfigDir expands ~/ and wins over both process env CLAUDE_CONFIG_DIR and reclaude probing.
    const spawned = profile.spawn({
      HOME: root, SHELL: '/bin/false', CLAUDE_CONFIG_DIR: join(root, 'env-dir'), TEST_STATUS_COUNTER: counter,
    }).env;
    assert.equal(spawned.CLAUDE_CONFIG_DIR, expected);
    await assert.rejects(readFile(counter, 'utf8'), { code: 'ENOENT' });

    // Account inspection forwards the same configured CLAUDE_CONFIG_DIR.
    await assert.rejects(() => profile.inspectAccount());
    const captured = JSON.parse(await readFile(capturedPath, 'utf8'));
    assert.equal(captured.CLAUDE_CONFIG_DIR, expected);
    await assert.rejects(readFile(counter, 'utf8'), { code: 'ENOENT' });

    // Clearing claudeConfigDir live falls back to the environment variable on the next spawn.
    current = { ...current, claudeConfigDir: '' };
    const fallback = profile.spawn({ HOME: root, SHELL: '/bin/false', CLAUDE_CONFIG_DIR: join(root, 'env-dir') }).env;
    assert.equal(fallback.CLAUDE_CONFIG_DIR, join(root, 'env-dir'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
