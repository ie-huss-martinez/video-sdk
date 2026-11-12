/**
 * How each output channel is made from the input channels (docs/adr/0005):
 * `matrix[output][input]` is the input's weight. It follows Web Audio's
 * speaker rules for mono, stereo, quad and 5.1, as audio-sdk does, so what
 * plays and what's exported mix the same way. Other layouts are discrete:
 * channel `n` goes to channel `n`, and the rest are dropped or silent.
 *
 * Channel orders are Web Audio's: stereo `L R`, quad `L R SL SR`, and 5.1
 * `L R C LFE SL SR`.
 *
 * @internal
 */
export function channelMatrix(inputs: number, outputs: number): readonly (readonly number[])[] {
  const h = Math.SQRT1_2;
  const speakers: Record<string, number[][]> = {
    "1>2": [[1], [1]],
    "1>4": [[1], [1], [0], [0]],
    "1>6": [[0], [0], [1], [0], [0], [0]],
    "2>1": [[0.5, 0.5]],
    "2>4": [
      [1, 0],
      [0, 1],
      [0, 0],
      [0, 0],
    ],
    "2>6": [
      [1, 0],
      [0, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    "4>1": [[0.25, 0.25, 0.25, 0.25]],
    "4>2": [
      [0.5, 0, 0.5, 0],
      [0, 0.5, 0, 0.5],
    ],
    "4>6": [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    "6>1": [[h, h, 1, 0, 0.5, 0.5]],
    "6>2": [
      [1, 0, h, 0, h, 0],
      [0, 1, h, 0, 0, h],
    ],
    "6>4": [
      [1, 0, h, 0, 0, 0],
      [0, 1, h, 0, 0, 0],
      [0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 1],
    ],
  };
  const rule = speakers[`${inputs}>${outputs}`];
  if (rule) return rule;
  return Array.from({ length: outputs }, (_, output) =>
    Array.from({ length: inputs }, (_, input) => (input === output ? 1 : 0)),
  );
}
