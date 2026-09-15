import { glob, readFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
// Development only: links existing builds. The published plugin uses DSH peers.
const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
for (const pattern of ['packages/*/*/package.json','vendor/*/package.json']) {
 for await (const path of glob(pattern, {cwd:reference})) {
  const file=resolve(reference,path), pkg=JSON.parse(await readFile(file,'utf8'));
  if (!pkg.name?.startsWith('@deepseek-ai/')) continue;
  const target=resolve('node_modules',pkg.name);
  await mkdir(dirname(target),{recursive:true});
  try {await lstat(target);} catch(error) {if(error.code!=='ENOENT') throw error; await symlink(dirname(file),target,'dir');}
 }
}
const host=resolve(process.env.CODEXHOST_REFERENCE_ROOT ?? '../../codex-host');
for(const name of ['zod','@codexhost/harness-adapter','@codexhost/shared-contracts']) {
 const target=resolve('node_modules',name); await mkdir(dirname(target),{recursive:true});
 try {await lstat(target);} catch(error) {if(error.code!=='ENOENT') throw error;await symlink(resolve(host,'node_modules',name),target,'dir');}
}
