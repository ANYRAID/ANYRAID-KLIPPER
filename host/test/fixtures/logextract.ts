export const completeShutdown = [
  'Git version: test',
  'Start printer at Sun Sep 20 00:00:00 2026',
  '===== Config file =====',
  '[mcu]',
  'serial: /dev/serial/test',
  '=======================',
  'Stats 8.0: mcu: send_seq=32 receive_seq=32 task_avg=0.001',
  "MCU 'mcu' shutdown: Timer too close",
  'clocksync state: mcu_freq=1000000 last_clock=1 clock_est=(9.0 9000000 1000000.0)',
  'Dumping serial stats: bytes_write=100 send_seq=35 receive_seq=35 retransmit_seq=0',
  'Dumping send queue 3 messages',
  'Sent 0 9.100000 9.000000 10: seq: 10, queue_step oid=1 clock=9000000',
  'Sent 1 9.200000 9.150000 10: seq: 11, queue_step oid=1 clock=9010000',
  'Sent 2 9.300000 9.250000 10: seq: 12, queue_step oid=1 clock=4294967295',
  'Dumping receive queue 2 messages',
  'Receive: 0 9.210000 9.100000 10: seq: 11, status clock=9010000',
  'Receive: 1 9.310000 9.200000 10: seq: 12, status clock=9015000',
  "Dumping stepper 'stepper_x' (mcu) 2 queue_step:",
  'queue_step 0: t=9100000 interval=100 count=20 add=-1',
  'queue_step 1: t=9090000 interval=99 count=2 add=0',
  "Dumping trapq 'toolhead' 2 moves:",
  'move 0: pt=9.200000 move_t=0.01 start_v=0',
  'move 1: pt=9.100000 move_t=0.01 start_v=1',
  'gcode state: absolute_coord=True absolute_extrude=False last_position=[1.5, -0.0, 3.0, 8.0] base_position=[1.0, 0.0, 0.0, 2.0] homing_position=[0.0, 0.0, 1.0, 0.0] speed=2.5 speed_factor=0.01 extrude_factor=0.9',
  'Dumping gcode input 2 blocks',
  "Read 9.100000: 'G1 X2\\n'",
  "Read 9.000000: 'M117 温度\\n'",
  'Dumping 1 requests for client 12',
  'Received 9.200000: {"id":1,"method":"info"}',
  'Stats 9.3: mcu: send_seq=34 receive_seq=33 task_avg=0.001',
  'Stats 16.0: mcu: send_seq=35 receive_seq=34 task_avg=0.001',
];
export const logFixtures = [
  '',
  [
    'Git version: one',
    '===== Config file =====',
    '[mcu]',
    'serial: test',
    '=======================',
    'Git version: two',
    '===== Config file =====',
    '[mcu]',
    'serial: test',
    '=======================',
    '===== Config file =====',
    '[other]',
  ].join('\n'),
  completeShutdown.join('\n'),
  completeShutdown.join('\r\n') + '\r\n',
  completeShutdown.join('\r'),
  completeShutdown
    .map((l) =>
      l
        .replace("'mcu'", "'aux'")
        .replace('(mcu)', '(aux)')
        .replace('mcu:', 'aux:')
        .replace('receive_seq=35', 'receive_seq=9007199254741027')
        .replace('9000000 1000000.0', '18446744073709551616 1000000.0')
        .replace('t=9100000', 't=18446744073709651616'),
    )
    .join('\n'),
  [
    'Git version: lone',
    'Dumping gcode input 1 blocks',
    "Read 1.0: 'M117 alone\\n'",
  ].join('\n'),
  completeShutdown
    .concat(
      [
        'Git version: restarted',
        '===== Config file =====',
        '[mcu]',
        'serial: changed',
        '=======================',
      ],
      completeShutdown.slice(6),
    )
    .join('\n'),
];
// Exercise a CRLF split at the read buffer boundary and multibyte UTF-8 input.
logFixtures.push('x'.repeat(65535) + '\r\n' + completeShutdown.join('\r\n'));
logFixtures.push('\ufeff' + completeShutdown.join('\n'));
logFixtures.push(
  completeShutdown
    .map((l) =>
      l.replace(
        'queue_step oid=1 clock=9000000',
        "tmcuart_send oid=1 write=b'\\x00\\xff\\n'",
      ),
    )
    .join('\n'),
);
