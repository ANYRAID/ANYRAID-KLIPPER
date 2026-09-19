// Protocol identify dictionary generation; compatible with scripts/buildcommands.py.
// Original Copyright (C) 2016-2024 Kevin O'Connor; GNU GPLv3.
import {deflateSync} from 'node:zlib';
function compareUnicode(a: string, b: string): number {
  const aa = Array.from(a, c => c.codePointAt(0)!), bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
/** Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=True).
 * Build dictionaries contain exact integers, strings, lists and objects only. */
export function dictionaryJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('Dictionary numbers must be exact integers');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Array.isArray(value)) return '[' + value.map(dictionaryJSON).join(',') + ']';
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid dictionary value');
  return '{' + Object.keys(value).sort(compareUnicode).map(k => dictionaryJSON(k) + ':' + dictionaryJSON((value as Record<string, unknown>)[k])).join(',') + '}';
}
export function generateIdentify(data: unknown): {dictionary: string; compressed: Buffer; code: string} {
  const dictionary = dictionaryJSON(data), compressed = deflateSync(dictionary, {level: 9});
  let bytes = '';
  for (let i = 0; i < compressed.length; i++) bytes += (i % 8 === 0 ? '\n   ' : '') + ' 0x' + compressed[i].toString(16).padStart(2, '0') + ',';
  const code = `\nconst uint8_t command_identify_data[] PROGMEM = {${bytes}\n};\n\n// Identify size = ${compressed.length} (${dictionary.length} uncompressed)\nconst uint32_t command_identify_size PROGMEM\n    = ARRAY_SIZE(command_identify_data);\n`;
  return {dictionary, compressed, code};
}
