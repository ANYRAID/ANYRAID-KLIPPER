#!/usr/bin/env -S node
// Node.js 26 source whitespace checker. GPL-3.0-or-later.
import { readFileSync } from 'node:fs';
import {
  checkWhitespace,
  whitespaceHeader,
} from '../host/src/diagnostics/whitespace.ts';
let errors = false;
for (const filename of process.argv.slice(2)) {
  let data: Buffer;
  try {
    data = readFileSync(filename);
  } catch {
    continue;
  }
  checkWhitespace(filename, data, (issue) => {
    if (!errors) process.stderr.write(whitespaceHeader);
    errors = true;
    process.stderr.write(`${filename}:${issue.line}: ${issue.message}\n`);
  });
}
if (errors) {
  process.stderr.write('\n\n');
  process.exitCode = 255;
}
