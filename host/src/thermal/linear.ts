// Linear ADC conversion from klippy/extras/adc_temperature.py.
// Copyright (C) 2016-2024 Kevin O'Connor. GPL-3.0-or-later.
import type { TemperatureConverter } from './adc.ts';
export type LinearSample = readonly [number, number];
const sentinel = 9999999999999;
function finite(value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError('Non-finite linear conversion');
  return value;
}
/** Piecewise linear interpolation/extrapolation with an unambiguous inverse. */
export class LinearInterpolate {
  #keys: number[] = [];
  #gain: number[] = [];
  #offset: number[] = [];
  #values: number[];
  #ascending: boolean;
  constructor(input: readonly LinearSample[]) {
    if (input.length < 2 || input.length > 999)
      throw new RangeError('Expected 2..999 calibration samples');
    const samples = input
      .map((p) => {
        if (
          !Array.isArray(p) ||
          p.length !== 2 ||
          !p.every(Number.isFinite) ||
          p[0] >= sentinel
        )
          throw new RangeError('Invalid calibration sample');
        return [...p] as [number, number];
      })
      .sort((a, b) => a[0] - b[0]);
    const direction = Math.sign(samples[1][1] - samples[0][1]);
    for (let i = 1; i < samples.length; i++)
      if (
        samples[i][0] <= samples[i - 1][0] ||
        !direction ||
        Math.sign(samples[i][1] - samples[i - 1][1]) !== direction
      )
        throw new RangeError(
          'Calibration must have unique keys and strictly monotonic values',
        );
    let [lastKey, lastValue] = samples[0];
    for (const [key, value] of samples.slice(1)) {
      const gain = finite((value - lastValue) / (key - lastKey));
      const offset = finite(lastValue - lastKey * gain);
      if (!gain) throw new RangeError('Unrepresentable calibration slope');
      if (this.#gain.at(-1) === gain && this.#offset.at(-1) === offset)
        continue;
      this.#keys.push(key);
      this.#gain.push(gain);
      this.#offset.push(offset);
      lastKey = key;
      lastValue = value;
    }
    this.#keys.push(sentinel);
    this.#gain.push(this.#gain.at(-1)!);
    this.#offset.push(this.#offset.at(-1)!);
    this.#values = this.#keys.map((k, i) =>
      finite(k * this.#gain[i] + this.#offset[i]),
    );
    // Preserve upstream's direction choice, including its single-slope case.
    this.#ascending = this.#values[0] < this.#values[this.#values.length - 2];
  }
  interpolate(key: number): number {
    finite(key);
    if (key >= sentinel)
      throw new RangeError('Interpolation key outside supported range');
    let lo = 0,
      hi = this.#keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (key < this.#keys[mid]) hi = mid;
      else lo = mid + 1;
    }
    return finite(key * this.#gain[lo] + this.#offset[lo]);
  }
  reverse(value: number): number {
    finite(value);
    let i = 0;
    while (
      i < this.#values.length - 1 &&
      !(this.#ascending ? this.#values[i] >= value : this.#values[i] <= value)
    )
      i++;
    return finite((value - this.#offset[i]) / this.#gain[i]);
  }
}
export class LinearVoltage implements TemperatureConverter {
  #curve: LinearInterpolate;
  readonly ignoredSamples: number;
  constructor(samples: readonly LinearSample[], voltage = 5, offset = 0) {
    if (!Number.isFinite(voltage) || voltage <= 0 || !Number.isFinite(offset))
      throw new RangeError('Invalid ADC voltage configuration');
    const points: LinearSample[] = [];
    for (const p of samples) {
      if (p.length !== 2 || !p.every(Number.isFinite))
        throw new RangeError('Invalid voltage sample');
      const adc = (p[1] - offset) / voltage;
      if (adc >= 0 && adc <= 1) points.push([adc, p[0]]);
    }
    this.ignoredSamples = samples.length - points.length;
    this.#curve = new LinearInterpolate(points);
  }
  temperature(adc: number): number {
    if (!Number.isFinite(adc) || adc < 0 || adc > 1)
      throw new RangeError('Invalid ADC sample');
    return this.#curve.interpolate(adc);
  }
  adc(temperature: number): number {
    return this.#curve.reverse(temperature);
  }
}
export class LinearResistance implements TemperatureConverter {
  #curve: LinearInterpolate;
  #pullup: number;
  constructor(samples: readonly LinearSample[], pullup = 4700) {
    if (!Number.isFinite(pullup) || pullup <= 0)
      throw new RangeError('Invalid pullup resistor');
    this.#pullup = pullup;
    this.#curve = new LinearInterpolate(
      samples.map((p) => {
        if (p.length !== 2 || !p.every(Number.isFinite) || p[1] <= 0)
          throw new RangeError('Invalid resistance sample');
        return [p[1], p[0]];
      }),
    );
  }
  temperature(adc: number): number {
    finite(adc);
    if (adc < 0 || adc > 1) throw new RangeError('Invalid ADC sample');
    adc = Math.max(0.00001, Math.min(0.99999, adc));
    return this.#curve.interpolate((this.#pullup * adc) / (1 - adc));
  }
  adc(temperature: number): number {
    const resistance = this.#curve.reverse(temperature);
    return finite(resistance / (this.#pullup + resistance));
  }
}
