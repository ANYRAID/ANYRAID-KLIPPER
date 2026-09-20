import type {
  ConfigSection,
  ConfigurationReader,
} from '../moonraker/config-reader.ts';
import {
  loadLinearSensors,
  type LinearSensorRegistry,
} from './linear-config.ts';
import {
  Thermistor,
  type CalibrationPoint,
  type ThermistorModel,
} from './thermistor.ts';
import { thermistorDefaults } from './thermistor-defaults.ts';
import type { TemperatureConverter } from './adc.ts';
/** Unified analog sensor configuration; digital/I2C/SPI sensors remain separate. */
export class AnalogSensorRegistry {
  #linear: LinearSensorRegistry;
  #thermistors = new Map<string, ThermistorModel>();
  constructor(reader: ConfigurationReader) {
    this.#linear = loadLinearSensors(reader);
    if (
      this.#linear.names.some((name) => Object.hasOwn(thermistorDefaults, name))
    )
      throw new Error('Linear sensor name collides with a default thermistor');
    for (const [name, model] of Object.entries(thermistorDefaults))
      this.#thermistors.set(name, structuredClone(model));
    const sections = reader
      .sections()
      .filter((name) => /^thermistor\s/.test(name));
    if (sections.length > 256)
      throw new Error('Thermistor definition capacity exceeded');
    const defined = new Set<string>();
    for (const sectionName of sections) {
      const name = sectionName.trim().split(/\s+/).slice(1).join(' ');
      if (
        !name ||
        name.length > 256 ||
        name.includes('\0') ||
        defined.has(name) ||
        this.#linear.names.includes(name)
      )
        throw new Error('Invalid or duplicate analog sensor name');
      const section = reader.section(sectionName);
      const point = (i: number): CalibrationPoint => [
        section.getFloat('temperature' + i, { above: -273.15 }),
        section.getFloat('resistance' + i, { above: 0 }),
      ];
      const first = point(1),
        beta = section.getFloat('beta', { defaultValue: null, above: 0 });
      const model: ThermistorModel =
        beta === null
          ? { points: [first, point(2), point(3)] }
          : { point: first, beta };
      // Validate coefficients before publishing a custom definition.
      new Thermistor(4700, 0, model);
      this.#thermistors.set(name, model);
      defined.add(name);
    }
  }
  get names(): readonly string[] {
    return Object.freeze([...this.#linear.names, ...this.#thermistors.keys()]);
  }
  create(
    section: Pick<ConfigSection, 'get' | 'getFloat'>,
  ): TemperatureConverter {
    const name = section.get('sensor_type'),
      model = this.#thermistors.get(name);
    if (!model) return this.#linear.create(section);
    return new Thermistor(
      section.getFloat('pullup_resistor', { defaultValue: 4700, above: 0 }),
      section.getFloat('inline_resistor', { defaultValue: 0, minval: 0 }),
      model,
    );
  }
}
