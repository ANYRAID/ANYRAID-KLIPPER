// Port of scripts/checkstack.py, Copyright (C) 2015 Kevin O'Connor.
// GPL-3.0-or-later. AVR disassembly heuristic, not a proven stack bound.
const description = `
#funcname1[preamble_stack_usage,max_usage_with_callers]:
#    insn_addr:called_function [usage_at_call_point+caller_preamble,total_usage]
#
#funcname2[p,m,max_usage_to_yield_point]:
#    insn_addr:called_function [u+c,t,usage_to_yield_point]
`;
interface Call {
  instruction: string;
  address: bigint;
  usage: bigint;
}
class FunctionInfo {
  address: bigint;
  name: string;
  basic = 0n;
  max: bigint | null = null;
  yield = -1n;
  maxYield: bigint | null = null;
  total = 0n;
  calls: Call[] = [];
  seen = new Set<string>();
  constructor(address: bigint, name: string) {
    this.address = address;
    this.name = name;
  }
  call(instruction: string, address: bigint, usage: bigint) {
    const key = `${address}/${usage}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.calls.push({ instruction, address, usage });
  }
}
const root = (name: string) => name.split('.')[0];
const larger = (a: bigint, b: bigint) => (a > b ? a : b);
/** Preserve the original provisional values for cycles, but use an explicit
 * work stack so deeply nested nonrecursive graphs cannot overflow the JS stack. */
function calculate(
  info: FunctionInfo,
  functions: Map<bigint, FunctionInfo>,
  ignore: Set<string>,
  hops: Set<string>,
) {
  const enter = (item: FunctionInfo) => {
    item.max = item.basic;
    item.maxYield = item.yield;
    return {
      item,
      index: 0,
      max: item.basic,
      yield: item.yield,
      total: 0n,
      seen: new Set<string>(),
    };
  };
  if (info.max !== null) return;
  const work = [enter(info)];
  while (work.length) {
    const current = work.at(-1)!,
      call = current.item.calls[current.index];
    if (!call) {
      current.item.max = current.max;
      current.item.maxYield = current.yield;
      current.item.total = current.total;
      work.pop();
      continue;
    }
    const child = functions.get(call.address);
    if (!child) {
      current.index++;
      continue;
    }
    if (child.max === null) {
      work.push(enter(child));
      continue;
    }
    current.index++;
    if (!current.seen.has(child.name)) {
      current.seen.add(child.name);
      current.total += child.total + 1n;
    }
    const name = root(child.name);
    if (ignore.has(name)) continue;
    const usage = hops.has(name) ? call.usage : call.usage + child.max;
    const yieldUsage = hops.has(name)
      ? call.usage
      : call.usage + child.maxYield!;
    current.max = larger(current.max, usage);
    if (child.maxYield! >= 0n)
      current.yield = larger(current.yield, yieldUsage);
  }
}
function ordered(functions: Map<bigint, FunctionInfo>): FunctionInfo[] {
  const available = new Map(functions),
    result: FunctionInfo[] = [];
  const compare = (a: FunctionInfo, b: FunctionInfo) =>
    a.total === b.total
      ? a.name === b.name
        ? a.address > b.address
          ? -1
          : a.address < b.address
            ? 1
            : 0
        : a.name > b.name
          ? -1
          : 1
      : a.total > b.total
        ? -1
        : 1;
  const candidates = (addresses: Iterable<bigint>) =>
    [...addresses]
      .map((a) => available.get(a))
      .filter((f): f is FunctionInfo => !!f)
      .sort(compare);
  const work: {
    candidates: FunctionInfo[];
    index: number;
    parent?: FunctionInfo;
  }[] = [{ candidates: candidates(functions.keys()), index: 0 }];
  while (work.length) {
    const frame = work.at(-1)!;
    if (frame.index === frame.candidates.length) {
      if (frame.parent) result.push(frame.parent);
      work.pop();
      continue;
    }
    const info = frame.candidates[frame.index++];
    if (!available.delete(info.address)) continue;
    work.push({
      candidates: candidates(info.calls.map((c) => c.address)),
      index: 0,
      parent: info,
    });
  }
  return result;
}
export interface StackPolicy {
  ignore?: readonly string[];
  stackHop?: readonly string[];
}
export function analyzeStack(input: string, policy: StackPolicy = {}): string {
  const unknown = new FunctionInfo(-2n, '<unknown>'),
    indirect = new FunctionInfo(-1n, '<indirect>');
  unknown.max = indirect.max = 0n;
  unknown.maxYield = indirect.maxYield = -1n;
  const functions = new Map<bigint, FunctionInfo>([[-1n, indirect]]),
    data = new Map<bigint | null, string[]>(),
    output: string[] = [];
  let address: bigint | null = null,
    current: FunctionInfo | null = null,
    atStart = false,
    usage = 0n;
  for (const line of input.split(/\r\n|\r|\n/)) {
    let m = /^([0-9a-f]+) <(.*)>:$/.exec(line);
    if (m) {
      address = BigInt('0x' + m[1]);
      current = new FunctionInfo(address, m[2]);
      functions.set(address, current);
      usage = 0n;
      atStart = true;
      continue;
    }
    m =
      /^[ ]*([0-9a-f]+):\t[^\t]*\t([^\t]+?)(\t[^;]*)?[ ]*(?:; (0x[0-9a-f]+) <(.*)>)?$/.exec(
        line,
      );
    if (!m) {
      const lines = data.get(address) ?? [];
      lines.push(line);
      data.set(address, lines);
      continue;
    }
    const [, instruction, op, params, target, reference] = m;
    if (op === 'push') {
      usage++;
      continue;
    }
    if (op === 'rcall' && params?.trim() === '.+0') {
      usage += 2n;
      continue;
    }
    if (atStart) {
      if (op === 'in' || op === 'eor') continue;
      current!.basic = usage;
      atStart = false;
    }
    if (!target) {
      if (op === 'ijmp' || op === 'icall') {
        if (!current) throw new Error('Indirect call before function header');
        current.call(instruction, -1n, op === 'ijmp' ? 0n : usage + 2n);
      } else continue;
    } else {
      if (reference.includes('+') || op.startsWith('ld') || op.startsWith('st'))
        continue;
      if (!current) throw new Error('Call before function header');
      const called = BigInt(target);
      if (['rjmp', 'jmp', 'brne', 'brcs'].includes(op))
        current.call(instruction, called, 0n);
      else if (op === 'rcall' || op === 'call')
        current.call(instruction, called, usage + 2n);
      else {
        output.push('unknown call ' + reference);
        current.call(instruction, called, usage);
      }
    }
    usage = current!.basic;
  }
  const byName = new Map<string, FunctionInfo>();
  for (const info of functions.values()) byName.set(root(info.name), info);
  const command = byName.get('sched_main'),
    index = byName.get('command_index');
  if (command && index)
    for (const line of data.get(index.address) ?? []) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const add = (offset: number) => {
        const called =
            BigInt('0x' + parts[offset + 8] + parts[offset + 7]) * 2n,
          count = BigInt('0x' + parts[offset + 2]);
        command.call('0', called, command.basic + 2n + count * 4n);
      };
      add(0);
      if (parts.length >= 17) add(8);
    }
  const event = byName.get('__vector_13') ?? byName.get('__vector_17');
  if (event)
    for (const [name, info] of byName)
      if (name.endsWith('_event'))
        event.call('0', info.address, event.basic + 2n);
  const ignore = new Set(policy.ignore),
    hops = new Set(policy.stackHop);
  for (const info of functions.values())
    calculate(info, functions, ignore, hops);
  output.push(description);
  for (const info of ordered(functions)) {
    if (info.max === 0n && info.maxYield! < 0n) continue;
    output.push(
      `\n${info.name}[${info.basic},${info.max}${info.maxYield! >= 0n ? ',' + info.maxYield : ''}]:`,
    );
    for (const call of info.calls) {
      const child = functions.get(call.address) ?? unknown;
      output.push(
        `    ${call.instruction.padStart(4, ' ')}:${child.name.padEnd(40, ' ')} [${call.usage}+${child.basic},${call.usage + child.max!}${child.maxYield! >= 0n ? ',' + (call.usage + child.maxYield!) : ''}]`,
      );
    }
  }
  return output.join('\n') + '\n';
}
