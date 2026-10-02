// MCU command table generation, compatible with scripts/buildcommands.py.
const types = new Map([
  ['%u', ['PT_uint32', 5]], ['%i', ['PT_int32', 5]],
  ['%hu', ['PT_uint16', 3]], ['%hi', ['PT_int16', 3]],
  ['%c', ['PT_byte', 2]], ['%s', ['PT_string', 64]],
  ['%.*s', ['PT_progmem_buffer', 64]], ['%*s', ['PT_buffer', 64]],
] as const);
type Parameter = readonly [string, number];
function parameter(format: string): Parameter {
  const result = types.get(format as '%u');
  if (!result) throw new Error(`Invalid parameter format: ${format}`);
  return result;
}
export function signedMessageId(encoded: number): number {
  if (!Number.isInteger(encoded) || encoded < 0 || encoded >= 16384)
    throw new RangeError('Message id must fit two encoded bytes');
  const first = encoded < 128 ? encoded : encoded >> 7;
  const value = (first & 0x60) === 0x60 ? first | -0x20 : first;
  return encoded < 128 ? value : (value << 7) | (encoded & 127);
}
function parameters(message: string, output: boolean): Parameter[] {
  if (!output) return message.trim().split(/\s+/).slice(1).map(arg => {
    const parts = arg.split('=');
    if (parts.length !== 2) throw new Error(`Invalid message argument: ${arg}`);
    return parameter(parts[1]);
  });
  const result: Parameter[] = [];
  // Keep the upstream percent scanning semantics, including repeated percent signs.
  for (let pos = message.indexOf('%'); pos >= 0; pos = message.indexOf('%', pos + 1)) {
    if (message[pos + 1] === '%') continue;
    let found: Parameter | undefined;
    for (let length = 1; length <= 4; length++) {
      found = types.get(message.slice(pos, pos + length) as '%u');
      if (found) break;
    }
    if (!found) throw new Error(`Invalid output format: ${message}`);
    result.push(found);
  }
  return result;
}
export class BuildCommands {
  private commands = new Map<string, {func: string; flags: string}>();
  private encoders: {name: string | null; message: string}[] = [];
  private ids = new Map<string, number>([
    ['identify_response offset=%u data=%.*s', 0], ['identify offset=%u count=%c', 1],
  ]);
  private names = new Map([...this.ids.keys()].map(message => [message.split(' ')[0], message]));
  accept(line: string): boolean {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(line);
    const kind = match?.[1] ?? line;
    if (!['DECL_COMMAND_FLAGS', '_DECL_ENCODER', '_DECL_OUTPUT'].includes(kind)) return false;
    if (!match) throw new Error(`Missing declaration: ${kind}`);
    let message = match[2];
    let command: {func: string; flags: string} | undefined;
    if (kind === 'DECL_COMMAND_FLAGS') {
      const fields = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(message);
      if (!fields) throw new Error('Invalid command declaration');
      command = {func: fields[1], flags: fields[2]}; message = fields[3];
      if (!/^[A-Za-z_]\w*$/.test(command.func)) throw new Error('Invalid command function');
    }
    const name = message.trim().split(/\s+/)[0];
    if (kind !== '_DECL_OUTPUT') {
      if (command && this.commands.has(name)) throw new Error(`Multiple definitions: ${name}`);
      if (this.names.has(name) && this.names.get(name) !== message) throw new Error(`Conflicting definition: ${name}`);
      this.names.set(name, message);
    }
    if (command) this.commands.set(name, command);
    else this.encoders.push({name: kind === '_DECL_OUTPUT' ? null : name, message});
    return true;
  }
  private assignIds(): void {
    for (const item of [...this.commands.keys(), ...this.encoders.map(e => e.message)]) {
      const message = this.names.get(item) ?? item;
      if (!this.ids.has(message)) {
        if (this.ids.size >= 16384) throw new RangeError('Too many message ids');
        this.ids.set(message, this.ids.size);
      }
    }
  }
  dictionary(): {commands: Record<string, number>; responses: Record<string, number>; output?: Record<string, number>} {
    this.assignIds();
    const commands = new Set<number>(), responses = new Set<number>();
    for (const [name, message] of this.names) (this.commands.has(name) ? commands : responses).add(signedMessageId(this.ids.get(message)!));
    const result: ReturnType<BuildCommands['dictionary']> = {commands: {}, responses: {}};
    for (const [message, id] of this.ids) {
      const signed = signedMessageId(id);
      if (commands.has(signed)) result.commands[message] = signed;
      if (responses.has(signed)) result.responses[message] = signed;
      if (!commands.has(signed) && !responses.has(signed)) (result.output ??= {})[message] = signed;
    }
    return result;
  }
  generate(): string {
    this.assignIds();
    if (!this.commands.size) throw new Error('No command declarations');
    const tables = new Map<string, string[]>();
    const parser = (id: number, message: string, kind: 'output' | 'command' | 'response') => {
      const params = parameters(message, kind === 'output');
      const names = params.map(p => p[0]); const key = names.join(',');
      if (names.length && !tables.has(key)) tables.set(key, names);
      const table = names.length ? `command_parameters${[...tables.keys()].indexOf(key)}` : '0';
      let code = `\n    // ${kind === 'output' ? 'Output: ' : ''}${message}\n    .encoded_msgid=${id}, // msgid=${signedMessageId(id)}\n    .num_params=${names.length},\n    .param_types = ${table},\n`;
      if (kind === 'response') code += `    .num_args=${names.length + names.filter(n => n === 'PT_buffer' || n === 'PT_progmem_buffer').length},`;
      else code += `    .max_size=${Math.min(64, 5 + (id < 128 ? 1 : 2) + params.reduce((sum, p) => sum + p[1], 0))},\n    .min_size=${Math.min(64, 5 + (id < 128 ? 1 : 2) + names.length)}`;
      return code;
    };
    const definitions: string[] = [], encoderLookups: string[] = [], outputLookups: string[] = [];
    const seen = new Set<number>();
    for (const {name, message} of this.encoders) {
      const id = this.ids.get(message)!;
      if (seen.has(id)) continue;
      seen.add(id);
      (name === null ? outputLookups : encoderLookups).push(`    if (__builtin_strcmp(str, "${message}") == 0)\n        return &command_encoder_${id};\n`);
      definitions.push(`const struct command_encoder command_encoder_${id} PROGMEM = {    ${parser(id, message, name === null ? 'output' : 'command')}\n};\n`);
    }
    const responseCode = `\n${definitions.join('').trim()}\n\nconst __always_inline struct command_encoder *\nctr_lookup_encoder(const char *str)\n{\n    ${encoderLookups.join('').trim()}\n    return NULL;\n}\n\nconst __always_inline struct command_encoder *\nctr_lookup_output(const char *str)\n{\n    ${outputLookups.join('').trim()}\n    return NULL;\n}\n`;
    const byId = new Map([...this.commands].map(([name, c]) => [this.ids.get(this.names.get(name)!)!, {name, ...c}]));
    const index: string[] = [], externs = new Set<string>();
    const max = Math.max(...byId.keys());
    for (let id = 0; id <= max; id++) {
      const command = byId.get(id);
      if (!command) { index.push(' {\n},'); continue; }
      externs.add(command.func);
      index.push(` {${parser(id, this.names.get(command.name)!, 'response')}\n    .flags=${command.flags},\n    .func=${command.func}\n},`);
    }
    const commandCode = `\n${[...externs].sort().map(func => `extern void ${func}(uint32_t*);`).join('\n')}\n\nconst struct command_parser command_index[] PROGMEM = {\n${index.join('').trim()}\n};\n\nconst uint16_t command_index_size PROGMEM = ARRAY_SIZE(command_index);\n`;
    const tableCode = ['', ...[...tables.values()].map((names, i) => `static const uint8_t command_parameters${i}[] PROGMEM = {\n    ${names.join(', ')} };`), ''].join('\n');
    return tableCode + responseCode + commandCode;
  }
}
