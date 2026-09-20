// ADC sensor configuration semantics from adc_temperature.py; GPL-3.0-or-later.
import type {
  ConfigSection,
  ConfigurationReader,
} from '../moonraker/config-reader.ts';
import {
  LinearVoltage,
  LinearResistance,
  type LinearSample,
} from './linear.ts';
import { createLinearSensor, linearSensorNames } from './linear-sensors.ts';
type SensorConfig = Pick<ConfigSection, 'get' | 'getFloat'>;
type Definition = { resistance: boolean; samples: readonly LinearSample[] };
/** Configuration-time registry only; owns no pins or device actions. */
export class LinearSensorRegistry {
  #custom = new Map<string, Definition>();
  get names(): readonly string[] {
    return Object.freeze([...linearSensorNames, ...this.#custom.keys()]);
  }
  register(section: Pick<ConfigSection, 'name' | 'get' | 'getFloat'>): void {
    const parts = section.name.trim().split(/\s+/);
    if (parts.shift() !== 'adc_temperature' || !parts.length)
      throw new Error('Invalid ADC calibration section');
    const name = parts.join(' ');
    if (
      name.length > 256 ||
      name.includes('\0') ||
      linearSensorNames.includes(name) ||
      this.#custom.has(name)
    )
      throw new Error('Invalid or duplicate linear sensor name');
    if (this.#custom.size >= 256)
      throw new Error('Linear sensor definition capacity exceeded');
    const resistance =
      section.get('resistance1', { defaultValue: null }) !== null;
    const samples: LinearSample[] = [];
    for (let i = 1; i < 1000; i++) {
      const temperature = section.getFloat('temperature' + i, {
        defaultValue: null,
      });
      if (temperature === null) break;
      const value = section.getFloat(
        (resistance ? 'resistance' : 'voltage') + i,
      );
      samples.push(Object.freeze([temperature, value] as const));
    }
    if (samples.length < 2)
      throw new Error('At least two calibration samples required');
    // Electrical scaling belongs to the consuming heater, not this definition.
    this.#custom.set(
      name,
      Object.freeze({ resistance, samples: Object.freeze(samples) }),
    );
  }
  create(config: SensorConfig): LinearVoltage | LinearResistance {
    const name = config.get('sensor_type');
    const definition = this.#custom.get(name);
    if (!definition && !linearSensorNames.includes(name))
      throw new Error('Unknown linear sensor type');
    if (definition?.resistance || name === 'PT1000') {
      const pullup = config.getFloat('pullup_resistor', {
        defaultValue: 4700,
        above: 0,
      });
      return definition
        ? new LinearResistance(definition.samples, pullup)
        : createLinearSensor(name, { pullup });
    }
    const voltage = config.getFloat('adc_voltage', {
      defaultValue: 5,
      above: 0,
    });
    const offset = config.getFloat('voltage_offset', { defaultValue: 0 });
    return definition
      ? new LinearVoltage(definition.samples, voltage, offset)
      : createLinearSensor(name, { voltage, offset });
  }
}
/** Existing INI reader supports both ':' and '='; this does not boot Klipper. */
export function loadLinearSensors(
  reader: ConfigurationReader,
): LinearSensorRegistry {
  const registry = new LinearSensorRegistry();
  for (const name of reader.sections())
    if (/^adc_temperature(?:\s|$)/.test(name))
      registry.register(reader.section(name));
  return registry;
}
