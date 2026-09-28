// Output-pin value semantics derived from klippy/extras/output_pin.py.
// GPL-3.0-or-later. Device ownership and scheduling are separate contracts.
import type { ConfigurationReader } from '../moonraker/config-reader.ts';
import { ConfigurationError } from '../moonraker/config-source.ts';

export interface OutputPinSettings {
  readonly section: string;
  readonly name: string;
  readonly pin: string;
  readonly pwm: boolean;
  readonly hardware: boolean;
  readonly cycleTime: number;
  readonly scale: number;
  readonly initialValue: number;
  readonly shutdownValue: number;
}

export function normalizeOutputPinValue(settings: Pick<OutputPinSettings, 'pwm' | 'scale'>, value: number): number {
  if (typeof settings.pwm !== 'boolean' || !Number.isFinite(settings.scale) || settings.scale <= 0
    || !settings.pwm && settings.scale !== 1) throw new RangeError('Invalid output pin scale');
  if (!Number.isFinite(value) || value < 0 || value > settings.scale) throw new RangeError('Output pin value outside configured scale');
  const normalized = value / settings.scale;
  if (!settings.pwm && normalized !== 0 && normalized !== 1) throw new RangeError('Digital output pin requires zero or one');
  if (value > 0 && normalized === 0) throw new RangeError('Output pin value underflows its scale');
  return normalized === 0 ? 0 : normalized;
}

/** Parse before allocating pins, OIDs or activating outputs. The caller supplies
 * the MCU's maximum supported nominal duration, not a host wall-clock limit. */
export function readOutputPin(reader: ConfigurationReader, sectionName: string, maximumCycleTime: number): Readonly<OutputPinSettings> {
  if (!/^output_pin [A-Za-z0-9_][A-Za-z0-9_-]*$/.test(sectionName)) throw new ConfigurationError('Invalid output_pin section name');
  if (!Number.isFinite(maximumCycleTime) || maximumCycleTime <= 0) throw new RangeError('Invalid MCU maximum output cycle');
  const section = reader.section(sectionName);
  const pwm = section.getBoolean('pwm', { defaultValue: false });
  const supported = new Set(['pin', 'pwm', 'value', 'shutdown_value', ...(pwm ? ['cycle_time', 'hardware_pwm', 'scale'] : [])]);
  for (const option of Object.keys(section.options())) {
    if (!supported.has(option)) throw new ConfigurationError(`Unsupported output pin option: ${option}`);
  }
  const pin = section.get('pin');
  if (!pin || /[\s\0]/u.test(pin)) throw new ConfigurationError('Invalid output pin description');
  const scale = pwm ? section.getFloat('scale', { defaultValue: 1, above: 0 }) : 1;
  const cycleTime = pwm ? section.getFloat('cycle_time', { defaultValue: .1, above: 0, maxval: maximumCycleTime }) : 0;
  if (pwm && cycleTime > maximumCycleTime) throw new ConfigurationError('Default output cycle exceeds MCU limit');
  const settings = { section: sectionName, name: sectionName.slice(11), pin, pwm,
    hardware: pwm && section.getBoolean('hardware_pwm', { defaultValue: false }), cycleTime, scale };
  const initialValue = normalizeOutputPinValue(settings, section.getFloat('value', { defaultValue: 0, minval: 0, maxval: scale }));
  const shutdownValue = normalizeOutputPinValue(settings, section.getFloat('shutdown_value', { defaultValue: 0, minval: 0, maxval: scale }));
  return Object.freeze({ ...settings, initialValue, shutdownValue });
}
