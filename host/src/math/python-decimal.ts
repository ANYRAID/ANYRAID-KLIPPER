/** Python fixed-point rounding (ties-to-even), including negative zero and values
 * above 1e21 where Number.toFixed switches to exponent notation. */
export function fixed6(value: number): string {return fixedDecimal(value,6);}
export function fixedDecimal(value:number, precision:number):string {
  if(!Number.isInteger(precision)||precision<0||precision>6)throw new RangeError('Invalid fixed decimal precision');
  if (!Number.isFinite(value))
    return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf';
  if (Math.abs(value) < 1e21 && (Math.abs(value) * 10**precision) % 1 !== 0.5)
    return Object.is(value, -0) ? '-'+(0).toFixed(precision) : value.toFixed(precision);
  const buffer = new ArrayBuffer(8),
    view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    negative = bits >> 63n,
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    mantissa = exponent ? fraction + (1n << 52n) : fraction,
    power = exponent ? exponent - 1075 : -1074;
  let scaled = mantissa * 10n**BigInt(precision);
  if (power >= 0) scaled <<= BigInt(power);
  else {
    const shift = BigInt(-power),
      divisor = 1n << shift,
      remainder = scaled & (divisor - 1n);
    scaled >>= shift;
    if (remainder * 2n > divisor || (remainder * 2n === divisor && scaled & 1n))
      scaled++;
  }
  const digits = scaled.toString().padStart(precision+1, '0');
  return (negative ? '-' : '') + (precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits);
}
