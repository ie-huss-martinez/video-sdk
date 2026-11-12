import type { FrameRate, VideoContainer, VideoRotation } from "../../src/index.js";

const MAGIC = "FAKEVIDEO1\n";

/** What a fake video file holds: a description of its tracks, not media. */
export interface FakeVideoSpec {
  readonly container?: VideoContainer;
  readonly width: number;
  readonly height: number;
  readonly rotation?: VideoRotation;
  readonly rate: FrameRate;
  /** How many frames the packet walk finds. */
  readonly frames: number;
  /** How many frames the header claims, when it differs from the walk. */
  readonly declaredFrames?: number;
  readonly audio?: { readonly sampleRate: number; readonly channels: number } | null;
  /** The video codec, as a WebCodecs codec string. `avc1.64001f` by default. */
  readonly codec?: string;
  readonly tracks?: number;
}

/** A fake video file: a signature line, then the spec as JSON. */
export function encodeFakeVideo(spec: FakeVideoSpec): Blob {
  return new Blob([MAGIC, JSON.stringify(spec)]);
}

/** Reads a fake video file: `undefined` without the signature, and a `SyntaxError` for bad JSON. */
export async function decodeFakeVideo(file: Blob): Promise<FakeVideoSpec | undefined> {
  const text = await file.text();
  if (!text.startsWith(MAGIC)) return undefined;
  return JSON.parse(text.slice(MAGIC.length)) as FakeVideoSpec;
}

const EXPORT_MAGIC = "FAKEVIDEO-EXPORT1\n";

/** What the fake processor writes: where every output frame came from, and the metadata. */
export interface FakeExport {
  readonly container: string;
  readonly frames: readonly { readonly source: string; readonly time: number }[];
  readonly metadata: Readonly<Record<string, string>>;
}

export function encodeFakeExport(contents: FakeExport): Blob {
  return new Blob([EXPORT_MAGIC, JSON.stringify(contents)]);
}

export async function decodeFakeExport(file: Blob): Promise<FakeExport> {
  const text = await file.text();
  if (!text.startsWith(EXPORT_MAGIC)) throw new Error("Not a fake export.");
  return JSON.parse(text.slice(EXPORT_MAGIC.length)) as FakeExport;
}
