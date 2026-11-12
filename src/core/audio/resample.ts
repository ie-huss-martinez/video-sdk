/**
 * Zero crossings of the resampler's sinc on each side of a sample, at its
 * cutoff (docs/adr/0005). Sixteen keeps the passband flat to within a
 * fraction of a decibel up to 20 kHz at 44.1 and 48 kHz.
 *
 * @internal
 */
export const ZERO_CROSSINGS = 16;

/** The cutoff, as a fraction of the input's Nyquist: below 1 when downsampling, against aliasing. */
function cutoffFor(inputRate: number, outputRate: number): number {
  return Math.min(1, outputRate / inputRate);
}

/**
 * How many input samples on each side of a position the resampler reads.
 *
 * @internal
 */
export function kernelRadius(inputRate: number, outputRate: number): number {
  return Math.ceil(ZERO_CROSSINGS / cutoffFor(inputRate, outputRate));
}

/**
 * Table entries per input sample of distance. Each tap is linearly
 * interpolated between two entries, as bandlimited-interpolation resamplers
 * do; at 512 the interpolation error is far below the kernel's own ripple.
 *
 * @internal
 */
export const TABLE_PHASES = 512;

/** A Blackman-windowed sinc at `x` input samples from the centre. */
function kernel(x: number, cutoff: number, radius: number): number {
  if (x === 0) return cutoff;
  if (Math.abs(x) >= radius) return 0;
  const t = Math.PI * cutoff * x;
  const w = (Math.PI * (x + radius)) / radius;
  const blackman = 0.42 - 0.5 * Math.cos(w) + 0.08 * Math.cos(2 * w);
  return (cutoff * Math.sin(t) * blackman) / t;
}

/** The kernel's tables, one per pair of rates, made once: the kernel is symmetric, so they cover distances from 0. */
const tables = new Map<string, Float64Array>();

/**
 * The kernel tabulated from distance 0 to `radius`, at {@link TABLE_PHASES}
 * entries per input sample, with a trailing zero so interpolating at the
 * last entry reads within the table.
 */
function kernelTable(cutoff: number, radius: number): Float64Array {
  const key = `${cutoff}:${radius}`;
  let table = tables.get(key);
  if (!table) {
    table = new Float64Array(radius * TABLE_PHASES + 2);
    for (let i = 0; i <= radius * TABLE_PHASES; i += 1) {
      table[i] = kernel(i / TABLE_PHASES, cutoff, radius);
    }
    tables.set(key, table);
  }
  return table;
}

/**
 * Resamples by evaluating a windowed-sinc interpolation at exact positions
 * (docs/adr/0005), with the kernel read from a table made once per pair of
 * rates and interpolated linearly: output sample `k` is the input at position
 * `first + k × inputRate ÷ outputRate`, in input samples. Each output sample
 * depends only on its position and the input around it, so windows made
 * separately join without a seam, and the same plan always gives the same
 * samples. Input outside `input` is silence.
 *
 * @param input - Input samples; `input[0]` is input sample `inputStart`.
 * @param inputStart - The input sample index of `input[0]`.
 * @param first - The position of the first output sample, in input samples.
 * @param count - How many output samples to make.
 * @internal
 */
export function resample(
  input: Float32Array,
  inputStart: number,
  inputRate: number,
  outputRate: number,
  first: number,
  count: number,
): Float32Array {
  const output = new Float32Array(count);
  const step = inputRate / outputRate;
  if (inputRate === outputRate && Number.isInteger(first)) {
    for (let k = 0; k < count; k += 1) {
      const index = first + k - inputStart;
      output[k] = index >= 0 && index < input.length ? (input[index] as number) : 0;
    }
    return output;
  }
  const radius = kernelRadius(inputRate, outputRate);
  const table = kernelTable(cutoffFor(inputRate, outputRate), radius);
  const last = inputStart + input.length - 1;
  for (let k = 0; k < count; k += 1) {
    const position = first + k * step;
    const centre = Math.floor(position);
    const from = Math.max(centre - radius + 1, inputStart);
    const to = Math.min(centre + radius, last);
    // Taps at and before the centre are (fraction + j) samples away, and
    // those after it (1 − fraction + j): on each side the table index steps
    // by TABLE_PHASES and the interpolation weight stays the same.
    const before = (position - centre) * TABLE_PHASES;
    const after = TABLE_PHASES - before;
    let sum = 0;
    let entry = Math.floor(before) + (centre - from) * TABLE_PHASES;
    let weight = before - Math.floor(before);
    for (let index = from; index <= Math.min(centre, to); index += 1) {
      const below = table[entry] as number;
      sum +=
        (input[index - inputStart] as number) *
        (below + weight * ((table[entry + 1] as number) - below));
      entry -= TABLE_PHASES;
    }
    entry = Math.floor(after) + Math.max(0, from - centre - 1) * TABLE_PHASES;
    weight = after - Math.floor(after);
    for (let index = Math.max(centre + 1, from); index <= to; index += 1) {
      const below = table[entry] as number;
      sum +=
        (input[index - inputStart] as number) *
        (below + weight * ((table[entry + 1] as number) - below));
      entry += TABLE_PHASES;
    }
    output[k] = sum;
  }
  return output;
}
