#!/usr/bin/env -S node
// Node.js 26 CAN log diagnostics. GPL-3.0-or-later.
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { CandumpScanner } from '../host/src/diagnostics/candump.ts';
import { utf8LineBatches } from '../host/src/diagnostics/utf8-lines.ts';
async function main() {
  const args = process.argv.slice(2),
    usage =
      'Usage: node scripts/parsecandump.ts <candump.log> <canid> <mcu.dict>';
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length !== 3) throw new Error(usage);
  const [file, id, dictionary] = args;
  if (!/^(?:0x)?[0-9a-f]+$/i.test(id))
    throw new Error('CAN ID must be hexadecimal');
  let output = '';
  const scanner = new CandumpScanner(
    BigInt(/^0x/i.test(id) ? id : '0x' + id),
    readFileSync(dictionary),
    (line) => {
      output += line;
    },
  );
  try {
    for await (const batch of utf8LineBatches(file))
      for (const line of batch) {
        scanner.line(line);
        if (output.length >= 65536) {
          if (!process.stdout.write(output))
            await once(process.stdout, 'drain');
          output = '';
        }
      }
  } finally {
    if (output && !process.stdout.write(output))
      await once(process.stdout, 'drain');
  }
}
main().catch((error) => {
  process.stderr.write(
    `parsecandump: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
