import { appendFileSync } from 'node:fs';

const [mode, marker] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(marker, `${mode}:${JSON.parse(input).hook_event_name}\n`);
process.stdout.write(JSON.stringify(mode === 'block'
  ? { decision: 'block', reason: 'DSH_HOOK_BLOCKED' }
  : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'DSH_HOOK_CONTEXT' } }));
