import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
/** Migration-only oracle: the deleted Python implementation from the task baseline. */
export function originalBuildCommands(directory: string): string {
  const p=spawnSync('git',['show','ce7002be:scripts/buildcommands.py'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:10000,maxBuffer:1048576});
  if(p.status!==0)throw new Error(p.stderr||String(p.error));
  const path=join(directory,'original-buildcommands.py');writeFileSync(path,p.stdout);return path;
}
