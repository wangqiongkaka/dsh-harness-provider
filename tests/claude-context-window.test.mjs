import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js';

test('Claude ACP reads the window for a model without a 1m name suffix', async () => {
  const session = {
    query: { getContextUsage: async () => ({ rawMaxTokens: 1_000_000 }) },
    models: { currentModelId: 'claude-opus-5-5' },
    contextWindowSize: 200_000,
    contextWindowAuthoritative: false,
  };
  const agent = { sessions: { session }, logger: { error: () => {} } };
  ClaudeAcpAgent.prototype.refreshContextWindowInBackground.call(agent, 'session', session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.contextWindowSize, 1_000_000);
  assert.equal(session.contextWindowAuthoritative, true);
});
