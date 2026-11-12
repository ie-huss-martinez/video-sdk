// The media worker, with playback's test hook (docs/adr/0006): after each
// draw it reads back the frame number the numbered fixture shows, in binary,
// and reports it with the clock, and it answers for its open frames. Reports
// go over a MessagePort the test sends first, because the output's own client
// is private; sdk-core ignores messages outside its protocol. (A
// BroadcastChannel delivered them seconds late in Firefox.)
import { exposeWorker } from "@hussmartinez/sdk-core";
import type { MediaWorkerContract } from "../../src/adapters/media-worker/contract.js";
import { mediaWorkerHandlers } from "../../src/adapters/media-worker/handlers.js";
import { audioDataLedger } from "../../src/adapters/mediabunny/audio-decoder.js";
import { videoFrameLedger } from "../../src/adapters/mediabunny/video-decoder.js";
import { schedulerLedger } from "../../src/core/playback/scheduler.js";

/** One frame drawn, as the test reads it back. */
export interface DrawnRecord {
  readonly type: "drawn";
  /** The number the drawn pixels show. */
  readonly number: number;
  readonly clip: string;
  /** The frame's source time, in microseconds. */
  readonly sourceTime: number;
  /** The clock when it was drawn, in timeline microseconds, or `null` when paused. */
  readonly clock: number | null;
  /** Wall-clock time when it was drawn, in milliseconds since the epoch. */
  readonly wall: number;
  /** The canvas's backing size when it was drawn. */
  readonly width: number;
  readonly height: number;
}

export interface LedgerRecord {
  readonly type: "ledger";
  readonly open: number;
  readonly held: number;
  /** Decoded audio chunks not yet closed. */
  readonly audio: number;
}

/** What the test posts to the worker to receive its reports. */
export interface TestPortMessage {
  readonly type: "video-sdk-test-port";
  readonly port: MessagePort;
}

let port: MessagePort | undefined;
self.addEventListener("message", (event: MessageEvent<Partial<TestPortMessage>>) => {
  if (event.data?.type !== "video-sdk-test-port" || !event.data.port) return;
  port = event.data.port;
  port.addEventListener("message", (request: MessageEvent<{ type: string }>) => {
    if (request.data.type !== "ledger") return;
    port?.postMessage({
      type: "ledger",
      open: videoFrameLedger.open,
      held: schedulerLedger.held,
      audio: audioDataLedger.open,
    } satisfies LedgerRecord);
  });
  port.start();
});

exposeWorker<MediaWorkerContract>(
  mediaWorkerHandlers({
    afterDraw({ context, clip, sourceTime, clock }) {
      const { canvas } = context;
      // The centre of each eighth of the width, across the middle row: the
      // output fills the width whenever the canvas is as wide or wider.
      const row = context.getImageData(0, canvas.height / 2, canvas.width, 1).data;
      const blocks = 8;
      const width = canvas.width / blocks;
      let number = 0;
      for (let block = 0; block < blocks; block += 1) {
        const x = Math.floor(block * width + width / 2);
        number = number * 2 + ((row[x * 4] as number) > 128 ? 1 : 0);
      }
      port?.postMessage({
        type: "drawn",
        number,
        clip: clip.key,
        sourceTime,
        clock,
        wall: performance.timeOrigin + performance.now(),
        width: canvas.width,
        height: canvas.height,
      } satisfies DrawnRecord);
    },
  }),
);
