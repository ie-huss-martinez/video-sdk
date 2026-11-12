// Times the resampler (docs/adr/0005), in Node, whose V8 is Chromium's. Not a
// test: run it with `node scripts/bench-resample.ts` when changing the
// resampler, and record the numbers in the pull request.
import { resample } from "../src/core/audio/resample.ts";

const SECONDS = 10;
const cases: readonly [number, number][] = [
  [44_100, 48_000],
  [48_000, 44_100],
  [96_000, 48_000],
  [48_000, 48_000],
];

for (const [from, to] of cases) {
  const input = Float32Array.from(
    { length: from * SECONDS },
    (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / from),
  );
  // Warm up, then time the best of three: one channel, in 250 ms windows as playback makes them.
  const window = to / 4;
  const run = () => {
    const started = performance.now();
    for (let first = 0; first < to * SECONDS; first += window) {
      resample(input, 0, from, to, (first * from) / to, window);
    }
    return performance.now() - started;
  };
  run();
  const best = Math.min(run(), run(), run());
  const realTime = (SECONDS * 1_000) / best;
  process.stdout.write(
    `${from} → ${to} Hz: ${best.toFixed(0)} ms for ${SECONDS} s of mono, ${realTime.toFixed(0)}× real time\n`,
  );
}
