// Port of scripts/logextract.py, Copyright (C) 2017 Kevin O'Connor.
// GPL-3.0-or-later. Offline diagnostics only; extracted G-code is not executed.
import { parseLiteral, fixed6, type Literal } from './python-literal.ts';
export type Output = (filename: string, contents: string) => void;
type Row = [number, number, string];
interface Stream {
  parse(n: number, line: string): [boolean, Stream | null];
  lines(): Row[];
}
const comment = (n: number, line: string) =>
  `# ${String(n).padStart(6, ' ')}: ${line}`;
const text = (lines: Iterable<string>) =>
  [...lines].map((l) => l + '\n').join('');
export const rstrip = (s: string) =>
  s.replace(
    /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    '',
  );
export function addHighBits(
  value: bigint,
  reference: bigint,
  mask: bigint,
): bigint {
  const half = (mask + 1n) / 2n;
  return reference + ((value - (reference & mask) + half) & mask) - half;
}
export class TMCUartHelper {
  crc(data: Uint8Array) {
    let crc = 0;
    for (let b of data)
      for (let i = 0; i < 8; i++) {
        crc = ((crc << 1) ^ ((crc >> 7) ^ (b & 1) ? 7 : 0)) & 255;
        b >>= 1;
      }
    return crc;
  }
  serial(data: Uint8Array) {
    let value = 0n,
      pos = 0n;
    for (const b of data) {
      value |= BigInt((b << 1) | 512) << pos;
      pos += 10n;
    }
    return Uint8Array.from({ length: Number((pos + 7n) / 8n) }, (_, i) =>
      Number((value >> BigInt(i * 8)) & 255n),
    );
  }
  encode(sync: number, addr: number, reg: number, value?: number) {
    const bytes =
      value === undefined
        ? [sync, addr, reg]
        : [
            sync,
            addr,
            reg,
            (value >>> 24) & 255,
            (value >>> 16) & 255,
            (value >>> 8) & 255,
            value & 255,
          ];
    bytes.push(this.crc(Uint8Array.from(bytes)));
    return this.serial(Uint8Array.from(bytes));
  }
  pretty(addr: number, reg: number, value?: number) {
    return value === undefined
      ? `(${reg.toString(16)}@${addr.toString(16)})`
      : `(${(reg & ~128).toString(16)}@${addr.toString(16)}${reg & 128 ? '=' : '=='}${value.toString(16).padStart(8, '0')})`;
  }
  parse(data: Uint8Array) {
    if (data.length === 0) return '';
    if (data.length !== 5 && data.length !== 10) return '(length?)';
    let bits = 0n;
    for (let i = 0; i < data.length; i++)
      bits |= BigInt(data[i]) << BigInt(i * 8);
    const field = (shift: number) => Number((bits >> BigInt(shift)) & 255n),
      addr = field(11),
      reg = field(21),
      value =
        data.length === 10
          ? field(31) * 16777216 +
            field(41) * 65536 +
            field(51) * 256 +
            field(61)
          : undefined,
      sync = data.length === 10 && addr === 255 ? 5 : 245,
      expected = this.encode(sync, addr, reg, value),
      valid = data.every((v, i) => v === expected[i]);
    return (
      (valid ? '' : data.length === 5 ? 'Invalid: ' : 'Invalid:') +
      this.pretty(addr, reg, value)
    );
  }
}
class Config {
  lines: string[] = [];
  comments: string[] = [];
  filename: string;
  id: number;
  constructor(privateData: {
    configs: Map<string, Config>;
    n: number;
    logname: string;
  }) {
    this.configs = privateData.configs;
    this.n = privateData.n;
    this.id = this.configs.size + 1;
    this.filename = `${privateData.logname}.config${String(this.id).padStart(4, '0')}.cfg`;
  }
  configs: Map<string, Config>;
  n: number;
  add(_n: number, line: string) {
    if (line !== '=======================') {
      this.lines.push(line);
      return true;
    }
    this.finalize();
    return false;
  }
  finalize() {
    const key = JSON.stringify(this.lines),
      prior = this.configs.get(key);
    if (prior) prior.comments.push(...this.comments);
    else this.configs.set(key, this);
    (prior ?? this).comments.push(comment(this.n, 'config file'));
  }
  addComment(value: string | null) {
    if (value !== null) this.comments.push(value);
  }
  write(output: Output) {
    output(this.filename, text([...this.comments, ...this.lines]));
  }
}
class MCU implements Stream {
  name: string;
  sentTimeToSeq = new Map<string, bigint>();
  sentSeqToTime = new Map<bigint, number>();
  receiveSeqToTime = new Map<bigint, number>();
  frequency = 1;
  clock: [number, bigint, number] = [0, 0n, 1];
  shutdownSeq: bigint | null = null;
  constructor(name: string) {
    this.name = name;
  }
  transClock(clock: bigint, time: number) {
    const [sample, reference, freq] = this.clock,
      expected = BigInt(Math.trunc(Number(reference) + (time - sample) * freq)),
      extended = addHighBits(clock, expected, 0xffffffffn);
    return sample + Number(extended - reference) / freq;
  }
  annotate(line: string, seq: bigint | null, time: number) {
    if (seq !== null)
      line = line.replace(/: seq: 1[0-9a-f]/g, (m) => m + `(${seq})`);
    line = line.replace(
      /clock=([0-9]+)/g,
      (m, v) => m + `(${fixed6(this.transClock(BigInt(v), time))})`,
    );
    line = line.replace(
      /tmcuart_(?:response|send) oid=[0-9]+ (?:read|write)=b?('[^']*'|"[^"]*")/g,
      (m, literal) => {
        const value = parseLiteral('b' + literal);
        if (!(value instanceof Uint8Array))
          throw new Error('Invalid TMC byte literal');
        return rstrip(m) + new TMCUartHelper().parse(value);
      },
    );
    return this.name === 'mcu' ? line : `mcu '${this.name}': ${line}`;
  }
  parse(_n: number, line: string): [boolean, Stream | null] {
    let m =
      /^clocksync state: mcu_freq=([0-9]+) .* clock_est=\(([^ ]+) ([0-9]+) ([^ ]+)\)/.exec(
        line,
      );
    if (m) {
      this.frequency = Number(m[1]);
      this.clock = [Number(m[2]), BigInt(m[3]), Number(m[4])];
    }
    m =
      /^Dumping serial stats: .* send_seq=([0-9]+) receive_seq=([0-9]+) /.exec(
        line,
      );
    if (m) this.shutdownSeq = BigInt(m[2]);
    m = /^Dumping send queue ([0-9]+) messages$/.exec(line);
    if (m) return [true, new Sent(this, BigInt(m[1]))];
    m = /^Dumping receive queue ([0-9]+) messages$/.exec(line);
    if (m) return [true, new Received(this)];
    return [false, null];
  }
  lines(): Row[] {
    return [];
  }
}
class Sent implements Stream {
  mcu: MCU;
  count: bigint;
  rows: Row[] = [];
  constructor(mcu: MCU, count: bigint) {
    this.mcu = mcu;
    this.count = count;
  }
  parse(n: number, line: string): [boolean, Stream | null] {
    const m =
      /^Sent ([0-9]+) ([0-9]+\.[0-9]+) ([0-9]+\.[0-9]+) [0-9]+: seq: 1([0-9a-f]),/.exec(
        line,
      );
    if (!m) return this.mcu.parse(n, line);
    if (this.mcu.shutdownSeq === null)
      throw new Error('Missing shutdown sequence');
    const seq = addHighBits(
        BigInt('0x' + m[4]),
        this.mcu.shutdownSeq + BigInt(m[1]) - this.count,
        15n,
      ),
      time = Number(m[3]);
    this.mcu.sentTimeToSeq.set(`${Number(m[2])}|${seq & 15n}`, seq);
    this.mcu.sentSeqToTime.set(seq, time);
    this.rows.push([time, n, this.mcu.annotate(line, seq, time)]);
    return [true, null];
  }
  lines() {
    return this.rows;
  }
}
class Received implements Stream {
  mcu: MCU;
  rows: Row[] = [];
  constructor(mcu: MCU) {
    this.mcu = mcu;
  }
  parse(n: number, line: string): [boolean, Stream | null] {
    const m =
      /^Receive: ([0-9]+) ([0-9]+\.[0-9]+) ([0-9]+\.[0-9]+) [0-9]+: seq: 1([0-9a-f]),/.exec(
        line,
      );
    if (!m) return this.mcu.parse(n, line);
    const seq =
        this.mcu.sentTimeToSeq.get(
          `${Number(m[3])}|${(BigInt('0x' + m[4]) - 1n) & 15n}`,
        ) ?? null,
      time = Number(m[2]);
    if (seq !== null) this.mcu.receiveSeqToTime.set(seq + 1n, time);
    this.rows.push([time, n, this.mcu.annotate(line, seq, time)]);
    return [true, null];
  }
  lines() {
    return this.rows;
  }
}
class Moves implements Stream {
  name: string;
  kind: 'stepper' | 'trapq';
  clock: [number, bigint, number];
  frequency: number;
  rows: Row[] = [];
  constructor(name: string, kind: 'stepper' | 'trapq', mcu: MCU | undefined) {
    this.name = name;
    this.kind = kind;
    this.clock = mcu?.clock ?? [0, 0n, 1];
    this.frequency = mcu?.frequency ?? 1;
  }
  parse(n: number, line: string): [boolean, Stream | null] {
    const m = (
      this.kind === 'stepper'
        ? /^queue_step ([0-9]+): t=([0-9]+) /
        : /^move ([0-9]+): pt=([0-9]+\.[0-9]+)/
    ).exec(line);
    if (!m) return [false, null];
    const [sample, reference, freq] = this.clock,
      time =
        sample +
        (this.kind === 'stepper'
          ? Number(BigInt(m[2]) - reference)
          : Number(m[2]) * this.frequency - Number(reference)) /
          freq;
    const parts = line.split(' ');
    parts[0] =
      this.name + ' ' + (this.kind === 'stepper' ? 'queue_step' : 'move');
    parts[2] += `(${fixed6(time)})`;
    this.rows.push([time, n, parts.join(' ')]);
    return [true, null];
  }
  lines() {
    return this.rows;
  }
}
const asNumber = (value: Literal | undefined) => {
  if (
    typeof value !== 'number' &&
    typeof value !== 'bigint' &&
    typeof value !== 'boolean'
  )
    throw new Error('Invalid numeric gcode state');
  return Number(value);
};
const list = (value: Literal | undefined) => {
  if (!Array.isArray(value)) throw new Error('Invalid gcode position');
  return value;
};
const equalZero = (value: Literal[]) => value.every((v) => asNumber(v) === 0);
class Gcode implements Stream {
  rows: Row[] = [];
  commands: string[] = [];
  state = '';
  filename: string;
  output: Output;
  constructor(n: number, logname: string, output: Output) {
    this.filename = `${logname}.gcode${String(n).padStart(5, '0')}`;
    this.output = output;
  }
  stateLine(line: string) {
    const parts = line.split(/([^ ]+)=/),
      kv: { [key: string]: Literal } = Object.create(null);
    try {
      for (let i = 1; i < parts.length; i += 2)
        kv[parts[i]] = parseLiteral(parts[i + 1].trim());
    } catch {
      for (const key of Object.keys(kv)) delete kv[key];
    }
    const out = ['; Start g-code state restore', 'G28'];
    if (
      !(Object.hasOwn(kv, 'absolute_coord')
        ? kv.absolute_coord
        : kv.absolutecoord)
    )
      out.push('G91');
    if (
      !(Object.hasOwn(kv, 'absolute_extrude')
        ? kv.absolute_extrude
        : kv.absoluteextrude)
    )
      out.push('M83');
    const last = list(kv.last_position),
      base = list(kv.base_position),
      home = list(kv.homing_position);
    out.push(
      `G1 X${fixed6(asNumber(last[0]))} Y${fixed6(asNumber(last[1]))} Z${fixed6(asNumber(last[2]))} F${fixed6(asNumber(kv.speed) * 60)}`,
    );
    if (base.slice(0, 3).length !== 3 || !equalZero(base.slice(0, 3)))
      out.push('; Must manually set base position...');
    const extrusion =
      typeof last[3] === 'bigint' && typeof base[3] === 'bigint'
        ? Number(last[3] - base[3])
        : asNumber(last[3]) - asNumber(base[3]);
    out.push(`G92 E${fixed6(extrusion)}`);
    if (home.length !== 4 || !equalZero(home))
      out.push('; Must manually set homing position...');
    if (Math.abs(asNumber(kv.speed_factor) - 1 / 60) > 0.000001)
      out.push(`M220 S${fixed6(asNumber(kv.speed_factor) * 60 * 100)}`);
    if (asNumber(kv.extrude_factor) !== 1)
      out.push(`M221 S${fixed6(asNumber(kv.extrude_factor) * 100)}`);
    out.push('; End of state restore', '', '');
    this.state = out.join('\n');
  }
  parse(n: number, line: string): [boolean, Stream | null] {
    const m = /^Read ([0-9]+\.[0-9]+): (['"].*)$/.exec(line);
    if (!m) return [false, null];
    this.rows.push([Number(m[1]), n, line]);
    this.commands.push(m[2]);
    return [true, null];
  }
  lines() {
    if (this.rows.length) {
      const commands = this.commands.map((c) => {
        const value = parseLiteral(c);
        if (typeof value !== 'string')
          throw new Error('Invalid G-code literal');
        return value;
      });
      this.output(this.filename, this.state + commands.join(''));
    }
    return this.rows;
  }
}
class Api implements Stream {
  rows: Row[] = [];
  parse(n: number, line: string): [boolean, Stream | null] {
    const m = /^Received ([0-9]+\.[0-9]+): \{.*\}$/.exec(line);
    if (!m) return [false, null];
    this.rows.push([Number(m[1]), n, line]);
    return [true, null];
  }
  lines() {
    return this.rows;
  }
}
class Stats implements Stream {
  n: number;
  gcode: Gcode;
  mcus = new Map<string, MCU>();
  first: number | null = null;
  last: number | null = null;
  rows: [number | null, number, string][] = [];
  constructor(n: number, logname: string, output: Output) {
    this.n = n;
    this.gcode = new Gcode(n, logname, output);
  }
  check(time: number, line: string) {
    const parts = line.trim().split(/\s+/),
      values = new Map<string, string>();
    let mcu = '';
    for (const p of parts.slice(2)) {
      const at = p.indexOf('=');
      if (at < 0) mcu = p;
      else values.set(mcu + p.slice(0, at), p.slice(at + 1));
    }
    let min = 0,
      max = 999999999999;
    for (const [name, m] of this.mcus) {
      const s = values.get(name + ':send_seq');
      if (s === undefined) continue;
      const send = BigInt(s),
        receive = BigInt(values.get(name + ':receive_seq')!);
      min = Math.max(
        min,
        m.sentSeqToTime.get(send - 1n) ?? 0,
        m.receiveSeqToTime.get(receive) ?? 0,
      );
      max = Math.min(
        max,
        m.sentSeqToTime.get(send) ?? 999999999999,
        m.receiveSeqToTime.get(receive + 1n) ?? 999999999999,
      );
    }
    return Math.min(Math.max(time, min + 0.00000001), max - 0.00000001);
  }
  parse(n: number, line: string): [boolean, Stream | null] {
    let m = /^Stats ([0-9]+\.[0-9]+): /.exec(line);
    if (m) {
      this.last = Number(m[1]);
      this.first ??= this.last;
      this.rows.push([this.last, n, line]);
      return [true, null];
    }
    this.rows.push([null, n, line]);
    m = /^MCU '([^']+)' (?:is_)?shutdown:(.*)$/.exec(line);
    if (m) {
      const mcu = new MCU(m[1]);
      this.mcus.set(m[1], mcu);
      return [true, mcu];
    }
    m = /^Dumping stepper '([^']*)' \(([^)]+)\) ([0-9]+) queue_step:$/.exec(
      line,
    );
    if (m) return [true, new Moves(m[1], 'stepper', this.mcus.get(m[2]))];
    m = /^Dumping trapq '([^']*)' ([0-9]+) moves:$/.exec(line);
    if (m) return [true, new Moves(m[1], 'trapq', this.mcus.get('mcu'))];
    if (/^Dumping gcode input [0-9]+ blocks$/.test(line))
      return [true, this.gcode];
    if (/^gcode state: /.test(line)) {
      this.gcode.stateLine(line);
      return [true, null];
    }
    if (/^Dumping [0-9]+ requests for client [0-9]+$/.test(line))
      return [true, new Api()];
    return [false, null];
  }
  lines(): Row[] {
    const times: number[] = [];
    for (const m of this.mcus.values()) {
      for (const t of m.sentSeqToTime.values()) times.push(t);
      for (const t of m.receiveSeqToTime.values()) times.push(t);
    }
    if (!times.length) return [];
    let min = Infinity,
      max = -Infinity;
    for (const t of times) {
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    const index = this.rows.findIndex((r) => r[0] !== null && r[0] >= min - 5);
    if (index >= 0) this.rows.splice(0, index);
    let last = this.rows.find((r) => r[0] !== null)?.[0] ?? min;
    for (const row of this.rows) {
      if (row[0] !== null) last = this.check(row[0], row[2]);
      else if (row[1] >= this.n && last <= max) last = max + 0.00000001;
      row[0] = last;
    }
    return this.rows as Row[];
  }
}
class Shutdown {
  filename: string;
  comments: string[] = [];
  stats: Stats;
  active: Stream[];
  all: Stream[];
  output: Output;
  constructor(
    configs: Map<string, Config>,
    n: number,
    recent: [number, string][],
    logname: string,
    output: Output,
  ) {
    this.filename = `${logname}.shutdown${String(n).padStart(5, '0')}`;
    this.output = output;
    if (configs.size) {
      let config!: Config;
      for (const c of configs.values())
        if (!config || c.id > config.id) config = c;
      config.addComment(comment(n, recent.at(-1)![1]));
      this.comments.push('# config ' + config.filename);
    }
    this.stats = new Stats(n, logname, output);
    this.active = [this.stats];
    this.all = [...this.active];
    for (const [number, line] of recent) this.parse(number, line);
    this.stats.first = this.stats.last;
  }
  addComment(value: string | null) {
    if (value !== null) this.comments.push(value);
  }
  parse(n: number, line: string) {
    for (const stream of this.active) {
      const [parsed, next] = stream.parse(n, line);
      if (parsed) {
        if (next) {
          this.all.push(next);
          this.active = [next, this.stats];
        }
        break;
      }
    }
  }
  add(n: number, line: string) {
    this.parse(n, line);
    if (
      (this.stats.first !== null && this.stats.last! > this.stats.first + 5) ||
      line.startsWith('Git version') ||
      line.startsWith('Start printer at') ||
      line === '===== Config file ====='
    ) {
      this.finalize();
      return false;
    }
    return true;
  }
  finalize() {
    const streams = this.all.map((s) => s.lines());
    for (const rows of streams)
      for (let i = 1; i < rows.length; i++)
        if (rows[i - 1][0] > rows[i][0])
          rows[i] = [rows[i - 1][0], rows[i][1], rows[i][2]];
    const rows = streams.flat();
    rows.sort(
      (a, b) =>
        a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0),
    );
    this.output(
      this.filename,
      text([...this.comments, ...rows.map((r) => r[2])]),
    );
  }
}
export class LogExtractor {
  #configs = new Map<string, Config>();
  #handler: Config | Shutdown | null = null;
  #recent: [number, string][] = [];
  #git: string | null = null;
  #start: string | null = null;
  #number = 0;
  #finished = false;
  #name: string;
  #output: Output;
  constructor(logname: string, output: Output) {
    this.#name = logname;
    this.#output = output;
  }
  line(input: string) {
    if (this.#finished) throw new Error('Log extraction already finished');
    const line = rstrip(input),
      n = ++this.#number;
    this.#recent.push([n, line]);
    if (this.#recent.length > 200) this.#recent.shift();
    if (this.#handler) {
      if (this.#handler.add(n, line)) return;
      this.#recent = [];
      this.#handler = null;
    }
    if (line.startsWith('Git version')) this.#git = comment(n, line);
    else if (line.startsWith('Start printer at'))
      this.#start = comment(n, line);
    else if (line === '===== Config file =====') {
      this.#handler = new Config({
        configs: this.#configs,
        n,
        logname: this.#name,
      });
      this.#handler.addComment(this.#git);
      this.#handler.addComment(this.#start);
    } else if (line.includes('shutdown: ') || line.startsWith('Dumping ')) {
      this.#handler = new Shutdown(
        this.#configs,
        n,
        this.#recent,
        this.#name,
        this.#output,
      );
      this.#handler.addComment(this.#git);
      this.#handler.addComment(this.#start);
    }
  }
  finish() {
    if (this.#finished) return;
    this.#finished = true;
    this.#handler?.finalize();
    for (const config of this.#configs.values()) config.write(this.#output);
  }
}
