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

/** A Blackman-windowed sinc at `x` input samples from the centre. */
function kernel(x: number, cutoff: number, radius: number): number {
  if (x === 0) return cutoff;
  if (Math.abs(x) >= radius) return 0;
  const t = Math.PI * cutoff * x;
  const w = (Math.PI * (x + radius)) / radius;
  const blackman = 0.42 - 0.5 * Math.cos(w) + 0.08 * Math.cos(2 * w);
  return (cutoff * Math.sin(t) * blackman) / t;
}

/**
 * Resamples by evaluating a windowed-sinc interpolation at exact positions
 * (docs/adr/0005): output sample `k` is the input at position
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
  const cutoff = cutoffFor(inputRate, outputRate);
  const radius = kernelRadius(inputRate, outputRate);
  for (let k = 0; k < count; k += 1) {
    const position = first + k * step;
    const centre = Math.floor(position);
    const from = Math.max(centre - radius + 1, inputStart);
    const to = Math.min(centre + radius, inputStart + input.length - 1);
    let sum = 0;
    for (let index = from; index <= to; index += 1) {
      sum += (input[index - inputStart] as number) * kernel(position - index, cutoff, radius);
    }
    output[k] = sum;
  }
  return output;
}
