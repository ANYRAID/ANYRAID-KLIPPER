#!/usr/bin/env node
// Compile-time MCU requests. GNU GPLv3.
import {parseArgs} from 'node:util';
import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildCommands} from '../host/src/build/buildcommands.ts';
import {firmwareBuildVersion} from '../host/src/build/build-version.ts';
async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Node.js 26 is required');
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    extra: {type:'string', short:'e', default:''}, tools: {type:'string', short:'t', default:''},
    dictionary: {type:'string', short:'d'}, kconfig: {type:'string', short:'k'},
    verbose: {type:'boolean', short:'v'}, help: {type:'boolean', short:'h'},
  }});
  if (values.help) { console.log('Usage: node scripts/buildcommands.mts [-e EXTRA] [-t TOOLS] [-d DICTIONARY] -k KCONFIG INPUT OUTPUT.c'); return; }
  if (positionals.length !== 2 || !values.kconfig) throw new Error('Expected -k KCONFIG, input requests and output C paths');
  const outputs = [positionals[1], ...(values.dictionary ? [values.dictionary] : [])];
  const inputs = [positionals[0], values.kconfig].map(p => resolve(p));
  if (new Set(outputs.map(p => resolve(p))).size !== outputs.length || outputs.some(p => inputs.includes(resolve(p)))) throw new Error('Input and output paths must be distinct');
  const decode = (b: Buffer) => new TextDecoder('utf-8', {fatal:true}).decode(b);
  const requests = decode(await readFile(positionals[0])), kconfig = decode(await readFile(values.kconfig));
  const provenance = await firmwareBuildVersion(process.cwd(), values.tools, values.extra);
  const result = buildCommands(requests, kconfig, provenance);
  const temporary: string[] = [];
  try {
    for (const [i, path] of outputs.entries()) {
      const temp = path + '.' + randomUUID() + '.tmp'; temporary.push(temp);
      await writeFile(temp, i === 0 ? result.code : result.dictionary, {flag:'wx'});
    }
    // Publish dictionary first; a failed C publication leaves the make target failed.
    for (let i = outputs.length - 1; i >= 0; i--) await rename(temporary[i], outputs[i]);
  } finally { await Promise.all(temporary.map(p => unlink(p).catch(() => {}))); }
  console.log(`Version: ${provenance.version}`);
  if (values.verbose) console.error(`Build tools: ${provenance.toolstr}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
