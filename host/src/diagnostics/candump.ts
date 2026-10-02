// Port of scripts/parsecandump.py, Copyright (C) 2023 Kevin O'Connor.
// GPL-3.0-or-later. Offline CAN diagnostics; never sends packets.
import { checkFrame } from '../protocol/codec.ts';
import { MessageDictionary, type WireValue } from '../protocol/dictionary.ts';
import { fixed6 } from './python-literal.ts';

export function bytesRepr(bytes: Uint8Array): string {
  const quote = bytes.includes(39) && !bytes.includes(34) ? '"' : "'";
  let out = 'b' + quote;
  for (const b of bytes) {
    if (b === 92 || b === quote.charCodeAt(0))
      out += '\\' + String.fromCharCode(b);
    else if (b === 9) out += '\\t';
    else if (b === 10) out += '\\n';
    else if (b === 13) out += '\\r';
    else if (b >= 32 && b < 127) out += String.fromCharCode(b);
    else out += '\\x' + b.toString(16).padStart(2, '0');
  }
  return out + quote;
}
const hexBytes = new Map<string, number>();
for (let i = 0; i < 256; i++) {
  const s = i.toString(16).padStart(2, '0');
  hexBytes.set(s, i);
  hexBytes.set(s.toUpperCase(), i);
}
const strip = (s: string) =>
  s.replace(
    /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    '',
  );
const valueText = (v: WireValue) =>
  v instanceof Uint8Array ? bytesRepr(v) : String(v);
export class PacketDump {
  #dictionary = new MessageDictionary();
  #formats = new Map<string, string>();
  constructor(dictionary: Uint8Array) {
    this.#dictionary.identify(dictionary, false);
    const raw = JSON.parse(
      new TextDecoder().decode(this.#dictionary.rawIdentify),
    );
    for (const format of [
      'identify_response offset=%u data=%.*s',
      'identify offset=%u count=%c',
      ...Object.keys(raw.commands),
      ...Object.keys(raw.responses),
    ])
      this.#formats.set(format.split(/\s+/)[0], format);
  }
  dump(frame: Uint8Array): string[] {
    const result = ['seq: ' + frame[1].toString(16).padStart(2, '0')];
    for (const message of this.#dictionary.parseFrame(frame)) {
      if (message.name === '#unknown') {
        result.push('#unknown ' + bytesRepr(frame));
        continue;
      }
      const output = message.name === '#output',
        format = output
          ? String(message.parameters['#format'])
          : this.#formats.get(message.name)!;
      const values = Object.entries(message.parameters)
        .filter(([k]) => k !== '#format')
        .map(([, v]) => valueText(v));
      let at = 0;
      result.push(
        (output ? '#output ' : '') +
          format.replace(/%%|%(?:\.\*s|\*s|hu|hi|u|i|c|s)/g, (token) =>
            token === '%%' ? '%' : values[at++],
          ),
      );
    }
    return result;
  }
}
class CanStream {
  #data = new Uint8Array();
  #needScan = false;
  readonly name: string;
  readonly packets: PacketDump;
  constructor(name: string, packets: PacketDump) {
    this.name = name;
    this.packets = packets;
  }
  push(
    bytes: Uint8Array,
    line: string,
    report: (message: string, name: string, error?: boolean) => void,
  ) {
    const data = new Uint8Array(this.#data.length + bytes.length);
    data.set(this.#data);
    data.set(bytes, this.#data.length);
    let pos = 0;
    while (true) {
      if (this.#needScan) {
        const sync = data.indexOf(126, pos),
          end = sync < 0 ? data.length : sync + 1;
        if (sync >= 0) this.#needScan = false;
        report(
          `Discarding ${end - pos} (${[...data.subarray(pos, end)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')})`,
          this.name,
          true,
        );
        pos = end;
        if (pos === data.length) break;
      }
      const length = checkFrame(data.subarray(pos));
      if (length === 0) break;
      if (length < 0) {
        report('Invalid data: ' + strip(line), this.name, true);
        this.#needScan = true;
        continue;
      }
      if (length === 5)
        report('Ack ' + data[pos + 1].toString(16).padStart(2, '0'), this.name);
      else
        report(
          `${length}: ${this.packets.dump(data.subarray(pos, pos + length)).join(', ')}`,
          this.name,
        );
      pos += length;
    }
    this.#data = data.slice(pos);
  }
}
export class CandumpScanner {
  #number = 0;
  #last = -1;
  #handlers: Map<string, CanStream>;
  #output: (line: string) => void;
  constructor(
    canid: bigint,
    dictionary: Uint8Array,
    output: (line: string) => void,
  ) {
    const packets = new PacketDump(dictionary),
      id = (v: bigint) => v.toString(16).toUpperCase().padStart(3, '0');
    this.#handlers = new Map([
      [id(canid | 1n), new CanStream('RX', packets)],
      [id(canid & ~1n), new CanStream('TX', packets)],
    ]);
    this.#output = output;
  }
  line(line: string) {
    const number = ++this.#number,
      parts = strip(line).split(/\s+/);
    let time = 0;
    const report = (message: string, name = '', error = false) => {
      const raw = fixed6(time),
        stamp = raw.startsWith('-')
          ? '-' + raw.slice(1).padStart(9, '0')
          : raw.padStart(10, '0');
      this.#output(
        `${String(number).padStart(4, '0')}:${stamp}:${name}${error ? ' WARN' : ''} ${message}\n`,
      );
    };
    if (parts.length < 7) {
      if (strip(line)) report('Ignoring line: ' + strip(line), '', true);
      return;
    }
    const [timestamp, , , , , id, length] = parts;
    if (
      !timestamp.startsWith('(') ||
      !timestamp.endsWith(')') ||
      !length.startsWith('[') ||
      !length.endsWith(']')
    ) {
      report('Ignoring line: ' + strip(line), '', true);
      return;
    }
    const raw = timestamp.slice(1, -1);
    if (
      !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan)$/i.test(
        raw,
      )
    )
      throw new Error('Invalid CAN timestamp');
    time = /^[+-]?inf/i.test(raw)
      ? raw.startsWith('-')
        ? -Infinity
        : Infinity
      : Number(raw);
    if (time < this.#last)
      report(
        `Backwards time ${fixed6(time)} vs ${fixed6(this.#last)}: ${strip(line)}`,
        '',
        true,
      );
    this.#last = time;
    const handler = this.#handlers.get(id);
    if (!handler) return;
    const bytes = parts.slice(7).map((p) => {
      const byte = hexBytes.get(p);
      if (byte !== undefined) return byte;
      if (!/^[+]?(?:0x)?[0-9a-f]+$/i.test(p))
        throw new Error('Invalid CAN byte');
      const value = Number.parseInt(p, 16);
      if (value > 255) throw new Error('CAN byte outside uint8 range');
      return value;
    });
    handler.push(Uint8Array.from(bytes), line, report);
  }
}
