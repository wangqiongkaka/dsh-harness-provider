import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { nativeSubagent, HarnessService } from '../dist/dsh.js';
import { DshOutput } from '../dist/dsh-output.js';

test('native subagent results read tool message content and failure status', () => {
  for (const isError of [false, true]) {
    const child = nativeSubagent({ id: 'child', parentId: 'parent', running: false }, [
      { type: 'assistant/message', data: { message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '{}' }] }) } },
      { type: 'tool/result', data: { message: createToolResultMessage({ callId: ToolCallId('call'), content: [{ type: 'text', text: 'result text' }], isError }) } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]);
    assert.equal(child.entries[0].status, isError ? 'failed' : 'completed');
    assert.equal(child.entries[0].output, 'result text');
  }
});

test('Harness notices identify their producer and retain their summary', async () => {
  const records = [];
  const output = new DshOutput({}, { session: { append(type, data) { records.push({ type, data }); } } }, { turn: 1, step: 1 }, () => 1, () => ({ provider: 'test', model: 'test' }));
  await output.complete({ item: { type: 'contextCompaction', itemId: 'compact' }, outcome: { status: 'succeeded' } });
  assert.deepEqual(records[0].data.source, { kind: 'dsh-harness-provider', form: 'notice', summary: 'Harness context compaction' });
});

test('native quota uses the registered provider configuration path and live values', async () => {
  let baseURL = 'https://example.com/v1';
  const services = {
    settings: { describe: () => [{ ns: 'custom-models', value: { providers: { custom: { baseURL, apiKeyEnv: 'TEST_QUOTA_KEY' } } } }] },
    llm: { listConfigurableProviders: () => [{ provider: 'custom', settingsNs: 'custom-models', settingsPath: ['providers', 'custom'] }] },
    credentials: { resolve: async key => key === 'TEST_QUOTA_KEY' ? { value: 'test-key' } : undefined },
  };
  const ctx = { get: name => services[name] };
  const agent = { session: { requestHeader: () => ({ config: { provider: 'custom' } }) } };
  const route = () => HarnessService.prototype.nativeRoute.call({ ctx }, agent);
  assert.deepEqual(await route(), { provider: 'custom', baseURL, apiKey: 'test-key', source: 'custom' });
  baseURL = 'https://other.example/v1';
  assert.equal((await route()).baseURL, baseURL);
});

test('parallel tool completions retain start order and cancellation never repeats a completed result', async () => {
  for (const cancel of [false, true]) {
    const records = [];
    const output = new DshOutput({}, { session: { append(type, data) { records.push({ type, data }); } } }, { turn: 1, step: 1 }, () => 1, () => ({ provider: 'test', model: 'test' }));
    const first = { type: 'commandExecution', itemId: 'first', command: 'first' };
    const second = { type: 'commandExecution', itemId: 'second', command: 'second' };
    output.start(first);
    output.start(second);
    await output.complete({ item: { ...second, output: 'second result' }, outcome: { status: 'succeeded' } });
    if (cancel) await output.interrupt();
    else await output.complete({ item: { ...first, output: 'first result' }, outcome: { status: 'succeeded' } });
    const results = records.filter(record => record.type === 'tool/result');
    assert.deepEqual(results.map(record => [record.data.step, record.data.message.toolCallId]), [[1, 'first'], [2, 'second']]);
    assert.equal(results[0].data.message.isError, cancel);
    assert.equal(results[1].data.message.isError, false);
    assert.equal(results[1].data.message.content[0].text, 'second result');
  }
});
