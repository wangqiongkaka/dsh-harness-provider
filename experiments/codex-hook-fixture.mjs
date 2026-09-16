import { appendFileSync } from 'node:fs';

const marker = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(marker, `${input}\n`);
process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'UserPromptSubmit', additionalContext: 'CODEX_HOOK_CONTEXT',
} }));
