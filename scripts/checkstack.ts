#!/usr/bin/env -S node
// AVR stack heuristic. GPL-3.0-or-later.
// avr-objdump -d out/klipper.elf | node scripts/checkstack.ts
import { analyzeStack } from '../host/src/diagnostics/stack.ts';
import { once } from 'node:events';
async function main() {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let input = '';
  for await (const chunk of process.stdin)
    input += decoder.decode(chunk as Buffer, { stream: true });
  input += decoder.decode();
  if (!process.stdout.write(analyzeStack(input)))
    await once(process.stdout, 'drain');
}
main().catch((error) => {
  process.stderr.write(
    `checkstack: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
