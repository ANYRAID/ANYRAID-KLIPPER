#!/usr/bin/env -S node
// Node.js 26 replacement for Klipper's log extraction utility. GPL-3.0-or-later.
import { createReadStream, writeFileSync } from 'node:fs';
import { LogExtractor } from '../host/src/diagnostics/logextract.ts';
async function main() {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/logextract.ts <klippy.log>');
  const filename = process.argv[2],
    extractor = new LogExtractor(filename, (name, data) =>
      writeFileSync(name, data, 'utf8'),
    ),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = '';
  function consume(final = false) {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      if (c !== '\r' && c !== '\n') continue;
      if (c === '\r' && i === pending.length - 1 && !final) break;
      extractor.line(pending.slice(start, i));
      if (c === '\r' && pending[i + 1] === '\n') i++;
      start = i + 1;
    }
    pending = pending.slice(start);
  }
  for await (const chunk of createReadStream(filename)) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    consume();
  }
  pending += decoder.decode();
  consume(true);
  if (pending) extractor.line(pending);
  extractor.finish();
}
main().catch((error) => {
  process.stderr.write(
    `logextract: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
