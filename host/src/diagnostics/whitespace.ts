// Port of scripts/check_whitespace.py, Copyright (C) 2018 Kevin O'Connor.
// GPL-3.0-or-later.
import { basename } from 'node:path';
import { unicodeControlRanges } from './unicode-control-ranges.ts';
export function controlCodePoint(point: number): boolean {
  if (point < 128) return point < 32 || point === 127;
  let low = 0,
    high = unicodeControlRanges.length;
  while (low < high) {
    const mid = (low + high) >>> 1,
      [start, end] = unicodeControlRanges[mid];
    if (point < start) high = mid;
    else if (point > end) low = mid + 1;
    else return true;
  }
  return false;
}
function representation(point: number): string {
  if (point === 13) return "'\\r'";
  const prefix = point <= 255 ? 'x' : point <= 65535 ? 'u' : 'U',
    width = point <= 255 ? 2 : point <= 65535 ? 4 : 8;
  return "'\\" + prefix + point.toString(16).padStart(width, '0') + "'";
}
export interface WhitespaceIssue {
  line: number;
  message: string;
}
export function checkWhitespace(
  filename: string,
  data: Uint8Array,
  report: (issue: WhitespaceIssue) => void,
): void {
  if (!data.length) return;
  const source = ['.c', '.h', '.py'].some((s) => filename.endsWith(s)),
    makefile = basename(filename).toLowerCase() === 'makefile',
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let number = 0,
    start = 0;
  for (let end = 0; end <= data.length; end++) {
    if (end < data.length && data[end] !== 10) continue;
    number++;
    let line: string;
    try {
      line = decoder.decode(data.subarray(start, end));
    } catch {
      report({ line: number, message: 'Found non utf-8 character' });
      start = end + 1;
      continue;
    }
    start = end + 1;
    for (const character of line) {
      const point = character.codePointAt(0)!;
      if (controlCodePoint(point)) {
        if (point === 9 && makefile) continue;
        report({
          line: number,
          message: `Invalid ${point === 9 ? 'tab' : representation(point)} character`,
        });
        break;
      }
    }
    if (line.endsWith(' ') || line.endsWith('\t'))
      report({ line: number, message: 'Line has trailing spaces' });
    if (source && line.length > 80 && [...line].length > 80)
      report({ line: number, message: 'Line longer than 80 characters' });
  }
  if (data.at(-1) !== 10)
    report({ line: number, message: 'No newline at end of file' });
  if (data.at(-1) === 10 && data.at(-2) === 10)
    report({ line: number, message: 'Extra newlines at end of file' });
}
export const whitespaceHeader =
  '\n\nERROR:\nERROR: White space errors\nERROR:\n';
