// Decoder for the literal values emitted by Python repr in Klipper logs.
// Never evaluates code. Integer literals remain BigInt until their consumer
// explicitly performs a binary64 operation, matching Python int/float order.
export type Literal =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | Literal[]
  | { [key: string]: Literal };
export function parseLiteral(source: string): Literal {
  let at = 0,
    nodes = 0;
  const fail = (): never => {
      throw new Error('Invalid Python log literal');
    },
    space = () => {
      while (/\s/.test(source[at] ?? '') && at < source.length) at++;
    };
  function string(bytes: boolean): string | Uint8Array {
    const quote = source[at++];
    let out = '';
    const data: number[] = [];
    const append = (value: string) => {
      if (bytes) {
        for (const c of value) {
          const n = c.codePointAt(0)!;
          if (n > 255) fail();
          data.push(n);
        }
      } else out += value;
    };
    while (at < source.length) {
      let c = source[at++];
      if (c === quote) return bytes ? Uint8Array.from(data) : out;
      if (c === '\n' || c === '\r') fail();
      if (c !== '\\') {
        if (bytes && c.charCodeAt(0) > 127) fail();
        append(c);
        continue;
      }
      if (at >= source.length) fail();
      c = source[at++];
      const escapes: Record<string, string> = {
        '\\': '\\',
        "'": "'",
        '"': '"',
        a: '\x07',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
      };
      if (Object.hasOwn(escapes, c)) {
        append(escapes[c]);
        continue;
      }
      if (c === 'x' || (!bytes && (c === 'u' || c === 'U'))) {
        const count = c === 'x' ? 2 : c === 'u' ? 4 : 8,
          raw = source.slice(at, at + count);
        if (raw.length !== count || !/^[0-9a-f]+$/i.test(raw)) fail();
        at += count;
        const value = parseInt(raw, 16);
        if (value > 0x10ffff) fail();
        append(String.fromCodePoint(value));
        continue;
      }
      if (/[0-7]/.test(c)) {
        let raw = c;
        while (raw.length < 3 && /[0-7]/.test(source[at] ?? ''))
          raw += source[at++];
        const value = parseInt(raw, 8);
        append(String.fromCodePoint(bytes ? value & 255 : value));
        continue;
      }
      append('\\' + c);
    }
    return fail();
  }
  function value(depth: number): Literal {
    if (depth > 64 || ++nodes > 100000) fail();
    space();
    const c = source[at];
    if (
      (c === 'b' || c === 'B') &&
      (source[at + 1] === "'" || source[at + 1] === '"')
    ) {
      at++;
      return string(true);
    }
    if (c === "'" || c === '"') return string(false);
    if (c === '[' || c === '(') {
      at++;
      const end = c === '[' ? ']' : ')',
        out: Literal[] = [];
      space();
      while (source[at] !== end) {
        out.push(value(depth + 1));
        space();
        if (source[at] !== ',') break;
        at++;
        space();
      }
      if (source[at++] !== end) fail();
      return out;
    }
    if (c === '{') {
      at++;
      const out: { [key: string]: Literal } = Object.create(null);
      space();
      while (source[at] !== '}') {
        const key = value(depth + 1);
        if (typeof key !== 'string') fail();
        space();
        if (source[at++] !== ':') fail();
        out[key as string] = value(depth + 1);
        space();
        if (source[at] !== ',') break;
        at++;
        space();
      }
      if (source[at++] !== '}') fail();
      return out;
    }
    for (const [token, item] of [
      ['True', true],
      ['False', false],
      ['None', null],
    ] as const)
      if (source.startsWith(token, at)) {
        at += token.length;
        return item;
      }
    const match =
      /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][+-]?[0-9_]+)?)/.exec(
        source.slice(at),
      );
    if (!match) fail();
    const raw = match![0].replaceAll('_', '');
    at += match![0].length;
    if (/[.eE]/.test(raw) && !/^[-+]?0[xob]/i.test(raw)) return Number(raw);
    const negative = raw.startsWith('-'),
      unsigned = raw.replace(/^[+-]/, '');
    return (negative ? -1n : 1n) * BigInt(unsigned);
  }
  const result = value(0);
  space();
  if (at !== source.length) fail();
  return result;
}
export {fixed6,fixedDecimal} from '../math/python-decimal.ts';
