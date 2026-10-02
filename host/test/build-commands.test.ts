import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BuildCommands, signedMessageId} from '../src/build/commands.ts';
test('message ids preserve signed wire encoding boundaries', () => {
  for (const [encoded, signed] of [[0,0],[95,95],[96,-32],[127,-1],[128,128],[12287,12287],[12288,-4096],[16383,-1]]) assert.equal(signedMessageId(encoded), signed);
  for (const id of [-1,16384,1.5,NaN]) assert.throws(() => signedMessageId(id));
});
test('command declarations detect conflicts and count buffer arguments', () => {
  const b = new BuildCommands();
  assert.equal(b.accept('DECL_CONSTANT CLOCK_FREQ 100'), false);
  b.accept('DECL_COMMAND_FLAGS command_test 0 test a=%s b=%*s c=%.*s');
  b.accept('_DECL_ENCODER test a=%s b=%*s c=%.*s');
  const code = b.generate();
  assert.match(code, /\.num_args=5,/);
  assert.equal(code.match(/static const uint8_t command_parameters/g)?.length, 1);
  assert.equal(b.generate(), code);
  assert.throws(() => b.accept('DECL_COMMAND_FLAGS another 0 test a=%s b=%*s c=%.*s'));
  assert.throws(() => b.accept('_DECL_ENCODER test a=%u'));
  assert.deepEqual(b.dictionary().commands, {'test a=%s b=%*s c=%.*s': 2});
});
test('encoder deduplication and output format compatibility', () => {
  const b = new BuildCommands();
  b.accept('DECL_COMMAND_FLAGS identify 0 identify offset=%u count=%c');
  b.accept('_DECL_OUTPUT value %%u'); b.accept('_DECL_OUTPUT value %%u');
  assert.equal(b.generate().match(/const struct command_encoder command_encoder_/g)?.length,1);
  assert.deepEqual(b.dictionary().output, {'value %%u':2});
  b.accept('_DECL_OUTPUT trailing %%');
  assert.throws(() => b.generate(), /Invalid output/);
});
test('command ids reject more than two encoded bytes', () => {
  const b = new BuildCommands();
  b.accept('DECL_COMMAND_FLAGS identify 0 identify offset=%u count=%c');
  for (let i=0;i<16383;i++) b.accept(`_DECL_ENCODER response${i}`);
  assert.throws(() => b.generate(), /Too many/);
});
