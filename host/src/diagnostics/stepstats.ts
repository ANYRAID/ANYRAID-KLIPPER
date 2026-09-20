// Stepper communication-log statistics. GPL-3.0-or-later.
// Original Python implementation: Copyright (C) 2016 Kevin O'Connor.
import { createReadStream } from 'node:fs';
interface Stepper {
  directions: bigint;
  direction: string | undefined;
  queues: bigint;
  negative: bigint;
  positive: bigint;
}
function integer(value: string | undefined): bigint {
  if (value === undefined || !/^[+-]?[0-9]+$/.test(value))
    throw new Error('Invalid decimal integer');
  return BigInt(value);
}
export class StepStatistics {
  #steppers = new Map<string, Stepper>();
  line(line: string): void {
    // The Python 2 input is bytes: only ASCII whitespace separates fields.
    const parts = line.split(/[ \t\n\r\v\f]+/).filter(Boolean);
    if (!parts.length) return;
    const fields = new Map<string, string>();
    for (const part of parts.slice(1)) {
      const equal = part.indexOf('=');
      if (equal < 0) throw new Error('Malformed command field');
      fields.set(part.slice(0, equal), part.slice(equal + 1));
    }
    const name = parts[0];
    if (!['config_stepper', 'set_next_step_dir', 'queue_step'].includes(name))
      return;
    const oid = fields.get('oid');
    if (oid === undefined) throw new Error('Missing stepper oid');
    if (name === 'config_stepper') {
      this.#steppers.set(oid, {
        directions: 0n,
        direction: undefined,
        queues: 0n,
        negative: 0n,
        positive: 0n,
      });
      return;
    }
    const stepper = this.#steppers.get(oid);
    if (!stepper) throw new Error('Unconfigured stepper');
    if (name === 'set_next_step_dir') {
      const direction = fields.get('dir');
      if (direction === undefined) throw new Error('Missing stepper direction');
      stepper.directions++;
      stepper.direction = direction;
    } else {
      if (stepper.direction !== '0' && stepper.direction !== '1')
        throw new Error('Invalid or unset stepper direction');
      const count = integer(fields.get('count'));
      stepper.queues++;
      if (stepper.direction === '0') stepper.negative += count;
      else stepper.positive += count;
    }
  }
  format(): string {
    const rows = [...this.#steppers].map(([oid, stepper]) => ({
      oid: integer(oid),
      stepper,
    }));
    const compare = (a: bigint | string, b: bigint | string): number => {
      // Python 2 orders numeric initial direction before a string direction.
      if (typeof a !== typeof b) return typeof a === 'bigint' ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    };
    rows.sort((a, b) => {
      const key = compare(a.oid, b.oid);
      if (key) return key;
      const fields = (s: Stepper) => [
        s.directions,
        s.direction ?? 0n,
        s.queues,
        s.negative,
        s.positive,
      ];
      const left = fields(a.stepper),
        right = fields(b.stepper);
      for (let i = 0; i < left.length; i++) {
        const result = compare(left[i], right[i]);
        if (result) return result;
      }
      return 0;
    });
    const pad = (n: bigint, width: number) => n.toString().padStart(width);
    return rows
      .map(
        ({ oid, stepper: s }) =>
          `oid:${pad(oid, 3)} dir_cmds:${pad(s.directions, 6)} queue_cmds:${pad(s.queues, 7)} (${pad(s.positive, 8)} -${pad(s.negative, 8)} = ${pad(s.positive - s.negative, 8)})\n`,
      )
      .join('');
  }
}
export async function stepStatisticsFile(path: string): Promise<string> {
  const stats = new StepStatistics();
  let pending = '';
  for await (const chunk of createReadStream(path)) {
    pending += (chunk as Buffer).toString('latin1');
    let start = 0,
      end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      stats.line(pending.slice(start, end));
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending) stats.line(pending);
  return stats.format();
}
