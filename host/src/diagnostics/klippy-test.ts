// GPL-3.0-or-later. Regression orchestration; the selected backend is explicit.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export interface KlippyTestPlan {
  config: string;
  dictionaries: string[];
  gcodeFile: string | null;
  gcode: string[];
  shouldFail: boolean;
}

/** Preserve the legacy CONFIG-triggered snapshot order, including multi-config files. */
export function parseKlippyTest(source: string, filename: string, dictdir: string): KlippyTestPlan[] {
  const plans: KlippyTestPlan[] = [];
  let config: string | undefined, dictionaries: string[] | undefined;
  let gcodeFile: string | null = null, shouldFail = false, multiple = false;
  const gcode: string[] = [];
  const snapshot = () => {
    if (!config) throw new Error('config file not specified');
    if (!dictionaries) throw new Error('data dictionary file not specified');
    if (gcodeFile && gcode.length) throw new Error("Can't specify both a gcode file and gcode commands");
    plans.push({config, dictionaries: [...dictionaries], gcodeFile, gcode: [...gcode], shouldFail});
  };
  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0]!.trim();
    if (!line) continue;
    const [command, ...args] = line.split(/\s+/);
    if (['CONFIG', 'DICTIONARY', 'GCODE'].includes(command!) && !args[0])
      throw new Error(`${command} requires a path`);
    switch (command) {
      case 'CONFIG':
        if (config && !multiple) { multiple = true; snapshot(); }
        config = resolve(dirname(filename), args[0]!);
        if (multiple) snapshot();
        break;
      case 'DICTIONARY':
        dictionaries = [resolve(dictdir, args[0]!), ...args.slice(1).map(value => {
          const separator = value.indexOf('=');
          if (separator < 1 || separator === value.length - 1)
            throw new Error('Secondary dictionary requires mcu=path');
          return `${value.slice(0, separator)}=${resolve(dictdir, value.slice(separator + 1))}`;
        })];
        break;
      case 'GCODE': gcodeFile = resolve(dirname(filename), args[0]!); break;
      case 'SHOULD_FAIL': shouldFail = true; break;
      default: gcode.push(line);
    }
  }
  if (!multiple) snapshot();
  return plans;
}

export interface KlippyTestOptions {
  executable: string;
  entrypoint: string;
  cwd: string;
  tempdir: string;
  verbose?: boolean;
  keepfiles?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Each invocation owns one directory; failures retain it for diagnosis. */
export async function runKlippyTest(plan: KlippyTestPlan, options: KlippyTestOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new Error('timeoutMs must be an integer from 1 to 600000');
  if (!plan.config || !plan.dictionaries.length || (plan.gcodeFile && plan.gcode.length))
    throw new Error('Invalid Klippy test plan');
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(resolve(options.tempdir), 'klippy-test-'));
  try {
    const input = plan.gcodeFile ?? join(directory, '_test_.gcode');
    if (!plan.gcodeFile) await writeFile(input, plan.gcode.join('\n') + '\n');
    const log = join(directory, '_test_.log');
    const args = [options.entrypoint, plan.config, '-i', input, '-o', join(directory, '_test_output'), '-v'];
    for (const dictionary of plan.dictionaries) args.push('-d', dictionary);
    if (!options.verbose) args.push('-l', log);
    options.signal?.throwIfAborted();
    const result = await new Promise<{code: number | null; signal: string | null}>((accept, reject) => {
      const child = spawn(options.executable, args, {cwd: options.cwd, stdio: 'inherit'});
      let timedOut = false, cancelled = false, spawnError: Error | undefined;
      const cancel = () => { cancelled = true; child.kill('SIGKILL'); };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      options.signal?.addEventListener('abort', cancel, {once: true});
      if (options.signal?.aborted) cancel();
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        if (spawnError) reject(spawnError);
        else if (cancelled) reject(new Error('Klippy test cancelled'));
        else if (timedOut) reject(new Error(`Klippy test timed out after ${timeoutMs} ms`));
        else accept({code, signal});
      });
    });
    // A crash, signal, missing backend or timeout must never satisfy SHOULD_FAIL.
    if (result.signal || result.code === null)
      throw new Error(`Klippy backend terminated by ${result.signal ?? 'unknown cause'}`);
    if ((result.code !== 0) !== plan.shouldFail)
      throw new Error(plan.shouldFail ? 'Test failed to raise an error' : `Error during test (exit ${result.code})`);
    if (!options.keepfiles) await rm(directory, {recursive: true});
    return directory;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; artifacts: ${directory}`, {cause: error});
  }
}

export async function loadKlippyTests(filename: string, dictdir: string): Promise<KlippyTestPlan[]> {
  return parseKlippyTest(await readFile(filename, 'utf8'), filename, dictdir);
}
