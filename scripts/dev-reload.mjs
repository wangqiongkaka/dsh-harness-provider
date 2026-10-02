import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Development only: copies the current build into the directory a DSH profile links to. DSH's own hot reload watches
// that directory rather than dist/, so `npm run check` (which rebuilds dist/) never reloads the plugin under a running session.
const live = resolve(process.env.DSH_PLUGIN_LIVE ?? '.cache/live');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
// The entry goes last: DSH reloads on its change, and the programs it spawns must already be in place.
const programs = pkg.files.filter(file => /^dist\/.+\.m?js$/.test(file) && file !== pkg.main);
for (const file of ['package.json', pkg.dsh.bundle.patch, ...programs, pkg.main]) {
  await mkdir(dirname(resolve(live, file)), { recursive: true });
  await copyFile(file, resolve(live, file));
}
console.log('Published the current build to', live);
