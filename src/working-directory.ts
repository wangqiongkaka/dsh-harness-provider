import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

interface WorkingDirectory {
  get(session: Agent['session']): string;
  set(agent: Agent, path: string): Promise<string>;
}

/** Optional host capability: older deployments still run without directory switching. */
export function workingDirectory(agent: Agent): WorkingDirectory | undefined {
  return (agent.ctx as Context & { get(name: 'workingDirectory'): WorkingDirectory | undefined }).get('workingDirectory');
}
