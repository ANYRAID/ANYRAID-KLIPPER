import type {MotanSeries} from './derived-math.ts';

/** Normalized real second-order section: b0, b1, b2, a0=1, a1, a2. */
export type MotanSOS = readonly (readonly number[])[];
export type MotanSOSMode = 'filt' | 'filtfilt';

function coefficients(sos: MotanSOS): void {
  if (!Array.isArray(sos) || !sos.length || sos.length > 64)
    throw new Error('Motan SOS requires 1..64 sections');
  for (const row of sos) {
    if (!Array.isArray(row) || row.length !== 6 || row[3] !== 1
        || row.some(value => typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error('Motan SOS requires finite normalized coefficients');
  }
}

/** Solve the 2x2 steady-state system with partial pivoting. The cascade
 * gain and state scaling follow scipy.signal.sosfilt_zi. */
function initialState(sos: MotanSOS): Float64Array {
  const state = new Float64Array(sos.length * 2);
  let scale = 1;
  for (let i = 0; i < sos.length; i++) {
    const [b0, b1, b2, , a1, a2] = sos[i];
    let a = 1 + a1, b = -1, c = a2, d = 1;
    let u = b1 - a1 * b0, v = b2 - a2 * b0;
    if (Math.abs(c) > Math.abs(a)) {
      [a, c] = [c, a]; [b, d] = [d, b]; [u, v] = [v, u];
    }
    if (a === 0) throw new Error('Singular Motan SOS steady state');
    // LAPACK's LU scales the column by the reciprocal unless the pivot is
    // subnormal. Direct division differs enough to perturb very low cutoffs.
    const factor = Math.abs(a) >= 2.2250738585072014e-308 ? c * (1 / a) : c / a;
    d -= factor * b; v -= factor * u;
    if (d === 0) throw new Error('Singular Motan SOS steady state');
    const z1 = v / d, z0 = (u - b * z1) / a;
    state[2 * i] = scale * z0; state[2 * i + 1] = scale * z1;
    scale *= ((b0 + b1) + b2) / ((1 + a1) + a2);
  }
  for (const value of state) if (!Number.isFinite(value))
    throw new Error('Motan SOS steady state exceeds finite range');
  return state;
}

function pass(data: Float64Array, sos: MotanSOS, state: Float64Array,
              reverse: boolean): void {
  const endpoint = reverse ? data[data.length - 1] : data[0];
  // Pair adjacent sections to reduce buffer traffic while keeping each
  // section's recurrence and arithmetic order unchanged.
  for (let section = 0; section < sos.length; section++) {
    const [b0, b1, b2, , a1, a2] = sos[section];
    let z0 = state[2 * section] * endpoint;
    let z1 = state[2 * section + 1] * endpoint;
    if (section + 1 < sos.length) {
      const [c0, c1, c2, , d1, d2] = sos[section + 1];
      let w0 = state[2 * section + 2] * endpoint;
      let w1 = state[2 * section + 3] * endpoint;
      const step = reverse ? -1 : 1, end = reverse ? -1 : data.length;
      for (let i = reverse ? data.length - 1 : 0; i !== end; i += step) {
        const x = data[i], y = b0 * x + z0;
        z0 = (b1 * x - a1 * y) + z1;
        z1 = b2 * x - a2 * y;
        const next = c0 * y + w0;
        w0 = (c1 * y - d1 * next) + w1;
        w1 = c2 * y - d2 * next;
        data[i] = next;
      }
      if (!Number.isFinite(w0) || !Number.isFinite(w1))
        throw new Error('Motan SOS state exceeds finite range');
      section++;
    } else if (reverse) {
      for (let i = data.length - 1; i >= 0; i--) {
        const x = data[i], y = b0 * x + z0;
        z0 = (b1 * x - a1 * y) + z1;
        z1 = b2 * x - a2 * y;
        data[i] = y;
      }
    } else {
      for (let i = 0; i < data.length; i++) {
        const x = data[i], y = b0 * x + z0;
        z0 = (b1 * x - a1 * y) + z1;
        z1 = b2 * x - a2 * y;
        data[i] = y;
      }
    }
    if (!Number.isFinite(z0) || !Number.isFinite(z1))
      throw new Error('Motan SOS state exceeds finite range');
  }
}

/** Motan's steady-state forward filter or odd-padded forward/backward filter.
 * Coefficient design is separate. No Python execution or implicit fallback. */
export function motanSOSFilter(sos: MotanSOS, source: MotanSeries,
                               mode: MotanSOSMode): Float64Array {
  coefficients(sos);
  if (mode !== 'filt' && mode !== 'filtfilt') throw new Error('Invalid Motan SOS mode');
  if ((!Array.isArray(source) && !(source instanceof Float64Array))
      || !source.length || source.length > 2000000)
    throw new Error('Motan SOS requires 1..2000000 samples');
  const edge = mode === 'filt' ? 0 : 3 * (2 * sos.length + 1
    - Math.min(sos.filter(row => row[2] === 0).length,
               sos.filter(row => row[5] === 0).length));
  if (source.length <= edge) throw new Error(`Motan SOS needs more than padlen ${edge} samples`);
  if ((source.length + 2 * edge) * sos.length * (mode === 'filt' ? 1 : 2) > 50000000)
    throw new Error('Motan SOS work limit exceeded');
  for (const value of source) if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Motan SOS requires finite Float64 samples');
  const state = initialState(sos), data = new Float64Array(source.length + 2 * edge);
  data.set(source, edge);
  for (let i = 0; i < edge; i++) {
    data[i] = 2 * source[0] - source[edge - i];
    data[edge + source.length + i] = 2 * source[source.length - 1] - source[source.length - 2 - i];
  }
  pass(data, sos, state, false);
  if (mode === 'filtfilt') pass(data, sos, state, true);
  for (const value of data) if (!Number.isFinite(value))
    throw new Error('Motan SOS result exceeds finite range');
  return edge ? data.slice(edge, edge + source.length) : data;
}
