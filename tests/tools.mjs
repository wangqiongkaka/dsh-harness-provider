// Newer hosts require an executor in test compositions; older hosts own native execution inside Tools.
import Tools from '@deepseek-ai/dsh-tools';

export default {
  name: 'harness-test-tools',
  async apply(ctx) {
    await ctx.plugin(Tools);
    if (typeof Tools.prototype.setExecutor === 'function') await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'));
  },
};

/** Execute one capability through either host generation's tool dispatcher. */
export async function executeTool(tools, input) {
  if (typeof Tools.prototype.setExecutor !== 'function') return tools.execute(input);
  const { callId, name, arguments: args, ...context } = input;
  const batch = await tools.execute({ ...context, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] });
  return batch.results[0].result;
}
