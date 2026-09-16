import { createHash } from 'node:crypto';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const file=`${pkg.name}-${pkg.version}.tgz`;
execFileSync('npm',['pack','--ignore-scripts','--silent'],{stdio:'pipe'});
const hash=createHash('sha256').update(await readFile(file)).digest('hex').slice(0,12);
const artifact=resolve('.cache',`${pkg.name}-${hash}.tgz`);
await mkdir(resolve('.cache'),{recursive:true});
await copyFile(file,artifact);
execFileSync('dsh',['plugin','--profile','web','add','--offline',artifact],{
 env:{...process.env,DSH_HOME:resolve('.cache/dsh-install'),DSH_TELEMETRY_DISABLED:'1'},stdio:'pipe',
});
console.log('Installed current artifact in isolated DSH profile:',hash);
