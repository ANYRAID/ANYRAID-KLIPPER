import type { ConfigurationReader } from '../moonraker/config-reader.ts';
import { PrinterPins, type PhysicalPinMap } from '../protocol/pins.ts';
import { mcuOids } from '../protocol/mcu-oids.ts';
import { compileDigital } from '../outputs/digital.ts';
import { compilePWM } from '../outputs/pwm.ts';
import { readPrintClock } from '../timing/print-clock-timeline.ts';
import type { StepperMCU } from './stepper.ts';
import type { FanClock } from './cooling-fan.ts';
import { readOutputPin } from './output-pin.ts';

export interface OutputPinRequest { section: string; oid?: number }
/** Build cold-start configuration only. No writes or template execution.
 * Generation commands are required before accepting physical ownership. */
export function compileConfiguredOutputPins<T>(reader: ConfigurationReader, pins: PrinterPins<T>,
  mcus: ReadonlyMap<string, StepperMCU<T>>, clocks: ReadonlyMap<string, FanClock>, requests: readonly OutputPinRequest[]) {
  if (!requests.length || requests.length > 128 || new Set(requests.map((r) => r.section)).size !== requests.length) {
    throw new Error('Invalid output pin batch');
  }
  const maps = new Map<string, PhysicalPinMap>();
  const specifications = requests.map((request) => {
    // The existing MCU host contract sets MAX_NOMINAL_DURATION to 3 seconds.
    const settings = readOutputPin(reader, request.section, 3);
    const parsed = pins.parse(settings.pin, { canInvert: true });
    const mcu = mcus.get(parsed.chipName), mapping = clocks.get(parsed.chipName);
    if (!mcu || mcu.chip !== parsed.chip || !mapping) throw new Error('Output pin MCU or clock ownership differs');
    const clock = readPrintClock(mapping.calibration, mapping.timeline);
    if (!Number.isFinite(mapping.currentPrintTime) || mapping.currentPrintTime < 0) throw new Error('Invalid output pin current print time');
    const resolver = pins.resolver(parsed.chipName).clone();
    for (const [key, value] of Object.entries(mcu.dictionary.constants)) {
      if (!key.startsWith('RESERVE_PINS_')) continue;
      if (typeof value !== 'string') throw new Error('Invalid firmware pin reservation');
      for (const pin of value.split(',')) if (pin.trim()) resolver.reserve(pin.trim(), key.slice(13));
    }
    const enumeration = mcu.dictionary.pinEnumeration;
    const physical = resolver.resolve([`claim pin=${parsed.pin}`])[0].slice(10);
    maps.set(parsed.chipName, { pins: enumeration, reserved: resolver.physicalReservations(enumeration) });
    return { request, settings, pin: Object.freeze({ ...parsed, pin: physical }), mcu, clock,
      timeline: mapping.timeline, currentPrintTime: mapping.currentPrintTime };
  });
  return mcuOids(pins).claim(specifications.map((s) => ({ mcu: s.pin.chipName, owner: s.settings.section, oid: s.request.oid })), (oids) => {
    const compiled = specifications.map((s, index) => {
      const options = { oid: oids[index], pin: s.pin, maxDuration: 0 };
      const output = s.settings.pwm
        ? Object.freeze({ kind: 'pwm' as const, config: compilePWM(s.mcu.chip, s.mcu.dictionary, {
          ...options, hardware: s.settings.hardware, cycleTime: s.settings.cycleTime,
          start: s.settings.initialValue, shutdown: s.settings.shutdownValue, currentPrintTime: s.currentPrintTime,
        }, s.clock.clockAt) })
        : Object.freeze({ kind: 'digital' as const, config: compileDigital(s.mcu.chip, s.mcu.dictionary, {
          ...options, start: s.settings.initialValue === 1, shutdown: s.settings.shutdownValue === 1,
        }) });
      const commands = output.kind === 'pwm' ? [...output.config.commands, ...output.config.restart, ...output.config.init]
        : [output.config.config, output.config.restart];
      for (const command of commands) s.mcu.dictionary.encodeCommand(command);
      const hardware = output.kind === 'pwm' && output.config.hardware;
      s.mcu.dictionary.lookup(hardware ? 'reset_pwm_out_generation oid=%c generation=%u' : 'reset_digital_out_generation oid=%c generation=%u');
      s.mcu.dictionary.lookup(hardware ? 'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u' : 'queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
      return { settings: s.settings, mcu: s.pin.chipName, output, clock: s.clock, timeline: s.timeline };
    });
    const acquired = pins.lookupBatch(specifications.map((s) => ({ description: s.settings.pin, options: { canInvert: true }, exclusive: true })), maps);
    return Object.freeze(compiled.map((plan, index) => Object.freeze({ ...plan, pin: acquired[index] })));
  });
}
