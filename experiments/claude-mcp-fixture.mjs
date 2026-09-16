import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let ordinal = 0;

createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if ('result' in message || 'error' in message) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (!('id' in message)) return;
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dsh-probe', version: '1.0.0' },
  } });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
    { name: 'ask', description: 'Ask through MCP elicitation', inputSchema: { type: 'object', properties: {} } },
  ] } });
  if (message.method === 'tools/call' && message.params.name === 'ask') {
    const id = `elicitation-${++ordinal}`;
    const response = new Promise(resolve => pending.set(id, resolve));
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      mode: 'form', message: 'Choose a deployment region', requestedSchema: {
        type: 'object', required: ['region'], properties: { region: { type: 'string', title: 'Region', enum: ['us', 'eu'] } },
      },
    } });
    const answer = await response;
    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `MCP:${answer.action}:${answer.content?.region ?? ''}` }] } });
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
});
