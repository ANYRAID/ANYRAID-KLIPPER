export const instruction = (
  address: string,
  op: string,
  params = '',
  reference = '',
) =>
  ` ${address}:\t00 00\t${op}${params ? '\t' + params : ''}${reference ? '\t; ' + reference : ''}`;
export function stackFixture() {
  return (
    [
      'AVR file format elf32-avr',
      '00000010 <entry>:',
      instruction('10', 'push', 'r28'),
      instruction('12', 'in', 'r28, 0x3d'),
      instruction('14', 'eor', 'r1, r1'),
      instruction('16', 'rcall', '.+0'),
      instruction('18', 'call', '0x40', '0x40 <worker>'),
      instruction('1c', 'call', '0x40', '0x40 <worker>'),
      instruction('20', 'icall'),
      instruction('22', 'rjmp', '0x50', '0x50 <tail>'),
      instruction('24', 'lds', 'r1, 0x60', '0x60 <memory>'),
      instruction('26', 'brne', '.+4', '0x2a <entry+0x1a>'),
      instruction('28', 'weird', '0x88', '0x88 <missing>'),
      '00000040 <worker>:',
      instruction('40', 'push', 'r16'),
      instruction('42', 'nop'),
      instruction('44', 'ret'),
      '00000050 <tail>:',
      instruction('50', 'push', 'r17'),
      instruction('52', 'ijmp'),
      '00000060 <sched_main>:',
      instruction('60', 'push', 'r18'),
      instruction('62', 'ret'),
      '00000070 <command_index>:',
      ' 0070: 00 02 00 00 00 00 20 00 00 01 00 00 00 00 28 00',
      '00000080 <__vector_13>:',
      instruction('80', 'push', 'r1'),
      instruction('82', 'ret'),
      '00000090 <timer_event.constprop.1>:',
      instruction('90', 'push', 'r1'),
      instruction('92', 'push', 'r2'),
      instruction('94', 'ret'),
      '000000a0 <unused>:',
      instruction('a0', 'ret'),
    ].join('\n') + '\n'
  );
}
export function stackChain(count: number, groupSize = count): string {
  return (
    Array.from({ length: count }, (_, i) => {
      const address = BigInt(i + 1) * 16n,
        next = address + 16n;
      return `${address.toString(16)} <f${i}>:\n${instruction(address.toString(16), 'push', 'r1')}\n${i + 1 < count && (i + 1) % groupSize !== 0 ? instruction((address + 2n).toString(16), 'call', '0x' + next.toString(16), '0x' + next.toString(16) + ` <f${i + 1}>`) : instruction((address + 2n).toString(16), 'ret')}`;
    }).join('\n') + '\n'
  );
}
