import { type Page, test } from "@playwright/test";

/**
 * What a page's playback was waiting for when a step failed, to name a stall
 * the next time one happens in CI (issue #73). The editor starts its clock
 * only once its worker has answered, so a stall is a call the worker never
 * answered, or an audio clock that doesn't move.
 *
 * It records only method names, times and clock numbers: never a call's
 * input or result, which can hold a file's contents, and never a file name.
 * It logs nothing in the page, whose console the tests require to be clean.
 */
export interface PlaybackDiagnostics {
  readonly visibility: DocumentVisibilityState;
  /** How many workers the page started. */
  readonly workers: number;
  /** The family RPC calls no worker has answered yet, oldest first. */
  readonly pending: readonly {
    readonly worker: number;
    readonly method: string;
    readonly ageMs: number;
  }[];
  /** Every `AudioContext` the page made, sampled twice, 500 ms apart. */
  readonly audio: readonly {
    readonly state: AudioContextState;
    readonly currentTime: number;
    readonly stateLater: AudioContextState;
    readonly currentTimeLater: number;
  }[];
  /** The transport's play button and time, as shown. */
  readonly transport: { readonly button: string | null; readonly time: string | null };
}

interface Recorder {
  readonly pending: Map<string, { readonly method: string; readonly at: number }>;
  readonly contexts: AudioContext[];
  workers: number;
}

/**
 * Records, from before the page's own scripts run, each family RPC call the
 * page posts to a worker until its result or error comes back, and every
 * `AudioContext` the page makes.
 */
export async function recordPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorder: Recorder = { pending: new Map(), contexts: [], workers: 0 };
    Object.defineProperty(window, "__hmPlayback", { value: recorder });
    type RpcMessage = { protocol?: unknown; type?: unknown; id?: unknown; method?: unknown };
    const isRpc = (message: unknown): message is RpcMessage =>
      typeof message === "object" &&
      message !== null &&
      (message as RpcMessage).protocol === "hm-rpc";

    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const worker = recorder.workers;
        recorder.workers += 1;
        const post = this.postMessage.bind(this) as (...args: unknown[]) => void;
        this.postMessage = ((message: unknown, ...rest: unknown[]) => {
          if (isRpc(message) && message.type === "call" && typeof message.method === "string") {
            recorder.pending.set(`${worker}:${String(message.id)}`, {
              method: message.method,
              at: performance.now(),
            });
          }
          post(message, ...rest);
        }) as Worker["postMessage"];
        this.addEventListener("message", (event) => {
          const message: unknown = event.data;
          if (isRpc(message) && (message.type === "result" || message.type === "error")) {
            recorder.pending.delete(`${worker}:${String(message.id)}`);
          }
        });
      }
    };

    const RealContext = window.AudioContext;
    if (RealContext) {
      window.AudioContext = class extends RealContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          recorder.contexts.push(this);
        }
      };
    }
  });
}

/** Reads what {@link recordPlayback} recorded, sampling each audio clock twice. */
export async function readPlayback(page: Page): Promise<PlaybackDiagnostics> {
  return page.evaluate(async () => {
    const recorder = (window as unknown as { __hmPlayback?: Recorder }).__hmPlayback;
    const toggle = document.querySelector(".hm-video-transport [aria-pressed]");
    const transport = {
      button: toggle?.getAttribute("aria-label") ?? toggle?.textContent?.trim() ?? null,
      time: document.querySelector(".hm-video-transport-time")?.textContent ?? null,
    };
    if (!recorder) {
      return {
        visibility: document.visibilityState,
        workers: 0,
        pending: [],
        audio: [],
        transport,
      };
    }
    const sample = () =>
      recorder.contexts.map((context) => ({
        state: context.state,
        currentTime: Math.round(context.currentTime * 1_000) / 1_000,
      }));
    const first = sample();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const later = sample();
    const now = performance.now();
    return {
      visibility: document.visibilityState,
      workers: recorder.workers,
      pending: [...recorder.pending.entries()]
        .map(([key, call]) => ({
          worker: Number(key.split(":")[0]),
          method: call.method,
          ageMs: Math.round(now - call.at),
        }))
        .sort((a, b) => b.ageMs - a.ageMs),
      audio: first.map((context, index) => ({
        state: context.state,
        currentTime: context.currentTime,
        stateLater: later[index]?.state ?? context.state,
        currentTimeLater: later[index]?.currentTime ?? context.currentTime,
      })),
      transport,
    };
  });
}

/**
 * Runs a step of the test, and when it fails, attaches what the page's
 * playback was waiting for, and adds it to the failure's message, then fails
 * as the step did.
 */
export async function explained<T>(page: Page, step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    let report: string;
    try {
      report = JSON.stringify(await readPlayback(page), null, 2);
    } catch (reason) {
      report = `The diagnostics couldn't be read: ${String(reason)}`;
    }
    await test.info().attach(`playback diagnostics: ${step}`, {
      body: report,
      contentType: "application/json",
    });
    // In the failure's own message, which every reporter prints, CI's too.
    if (error instanceof Error) {
      error.message = `${error.message}\n\nPlayback diagnostics after "${step}":\n${report}`;
    }
    throw error;
  }
}
