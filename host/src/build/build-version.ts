// Firmware build provenance; original buildcommands.py Copyright 2016-2024
// Kevin O'Connor. GNU GPLv3.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hostname} from 'node:os';
const execute = promisify(execFile);
/** POSIX shlex.split with comments disabled; never execute through a shell. */
export function toolArguments(input: string): string[] {
  const args: string[] = []; let word = '', active = false, quote = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '\\') {
      if (++i === input.length) throw new Error('No escaped character');
      if (quote === '"' && !['"', '\\'].includes(input[i])) word += '\\';
      word += input[i]; active = true; continue;
    }
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; active = true; }
    else if (' \t\r\n'.includes(c)) { if (active) args.push(word); word = ''; active = false; }
    else { word += c; active = true; }
  }
  if (quote) throw new Error('No closing quotation');
  if (active) args.push(word);
  return args;
}
export type RunTool = (args: string[]) => Promise<string>;
export async function buildToolVersions(tools: string, run: RunTool): Promise<{clean: boolean; toolstr: string}> {
  const entries = tools.split(';').map(t => t.trim()), versions = ['', '']; let success = 0;
  for (const tool of entries) {
    let line = (await run(toolArguments(tool + ' --version'))).split('\n')[0];
    const index = line.startsWith('GNU ') ? 1 : 0;
    if (index) line = line.slice(4);
    const space = line.indexOf(' ');
    if (space < 1 || space === line.length - 1) continue;
    const version = line.slice(space + 1);
    if (versions[index] && versions[index] !== version) { versions[index] = 'mixed'; continue; }
    versions[index] = version; success++;
  }
  return {clean: !!versions[0] && !!versions[1] && success === entries.length, toolstr: `gcc: ${versions[0]} binutils: ${versions[1]}`};
}
export function formatBuildVersion(git: string, file: string, extra: string, clean: boolean, date: Date, host: string): string {
  let version = git;
  if (!version) { clean = false; version = file || '?'; }
  else if (version.includes('dirty')) clean = false;
  if (!clean) {
    const pad = (n: number) => String(n).padStart(2, '0');
    version += `-${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${host}`;
  }
  return version + extra;
}
export async function firmwareBuildVersion(repository: string, tools: string, extra: string): Promise<{version: string; toolstr: string; code: string}> {
  const run: RunTool = async args => {
    try {
      const {stdout} = await execute(args[0], args.slice(1), {cwd: repository, encoding: 'buffer', timeout: 10000, maxBuffer: 1048576});
      return new TextDecoder('utf-8', {fatal: true}).decode(stdout);
    } catch { return ''; }
  };
  const {clean, toolstr} = await buildToolVersions(tools, run);
  let git = '', file = '';
  try { await access(join(repository, '.git')); git = (await run(['git','describe','--always','--tags','--long','--dirty'])).trim(); } catch { /* source archive */ }
  if (!git) try { file = new TextDecoder('utf-8', {fatal:true}).decode(await readFile(join(repository, 'klippy/.version'))).trim(); } catch { /* version unknown */ }
  const version = formatBuildVersion(git, file, extra, clean, new Date(), hostname());
  return {version, toolstr, code: `\n// version: ${version}\n// build_versions: ${toolstr}\n`};
}
