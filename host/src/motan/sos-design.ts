import type {MotanSOS} from './sos-filter.ts';

/** Real second-order notch, with bandwidth strictly below Nyquist.
 * Keep the transfer polynomial directly instead of a root round-trip. */
export function motanNotch(frequency: number, quality: number, sampleRate: number): MotanSOS {
  if (![frequency, quality, sampleRate].every(Number.isFinite)
      || frequency <= 0 || quality <= 0 || sampleRate <= 0)
    throw new Error('Invalid Motan notch parameters');
  const normalized = 2 * frequency / sampleRate;
  const bandwidth = normalized / quality;
  if (!(normalized > 0 && normalized < 1 && bandwidth > 0 && bandwidth < 1))
    throw new Error('Motan notch frequency and bandwidth must be below Nyquist');
  const gain = 1 / (1 + Math.tan((bandwidth * Math.PI) / 2));
  const cosine = Math.cos(normalized * Math.PI);
  const row = [gain, gain * (-2 * cosine), gain, 1, -2 * gain * cosine, 2 * gain - 1];
  // Resolve rounded-to-unit poles explicitly; no silently singular filter.
  if (row.some(value => !Number.isFinite(value)) || !(Math.abs(row[5]) < 1)
      || !(1 + row[4] + row[5] > 0) || !(1 - row[4] + row[5] > 0))
    throw new Error('Motan notch poles cannot be represented stably');
  return Object.freeze([Object.freeze(row)]);
}
