import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  type MetadataTags,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  WebMOutputFormat,
} from "mediabunny";
import type { ExportCandidate } from "../../core/export/encoding.js";
import type { VideoMetadata } from "../../core/model/plan.js";

/**
 * Writes an export's encoded chunks into a container (docs/adr/0001,
 * docs/adr/0005), with mediabunny's `Output`. The file is collected in
 * parts as the muxer writes it, and becomes a `Blob` when finished.
 *
 * @internal
 */
export interface ExportWriter {
  /** Adds a video chunk, in decode order, awaiting the muxer's back-pressure. */
  addVideo(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void>;
  /** Adds an audio chunk, awaiting the muxer's back-pressure. */
  addAudio(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void>;
  /** Finishes the file. */
  finish(): Promise<Blob>;
  /** Drops the file. */
  cancel(): Promise<void>;
}

/**
 * The bytes a muxer writes, in parts. MP4 without fast start writes in
 * order, then goes back to patch the media box's size in its header, so a
 * write may overwrite bytes already collected: it's copied into the parts
 * it covers.
 */
function collector(counted: (size: number) => void) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const offsets: number[] = [];
  let end = 0;
  const write = ({ data, position }: StreamTargetChunk) => {
    if (position === end) {
      // Checked before it's kept: past `maxFileSize`, nothing more is collected.
      counted(end + data.length);
      parts.push(data.slice());
      offsets.push(position);
      end += data.length;
      return;
    }
    if (position > end || position + data.length > end) {
      throw new RangeError("The muxer wrote past the end of the file.");
    }
    // A patch: copy it into the parts it covers.
    for (const [index, part] of parts.entries()) {
      const start = offsets[index] as number;
      const from = Math.max(position, start);
      const to = Math.min(position + data.length, start + part.length);
      if (from < to) part.set(data.subarray(from - position, to - position), from - start);
    }
  };
  return { stream: new WritableStream<StreamTargetChunk>({ write }), blob: () => new Blob(parts) };
}

/** The plan's metadata as tags: only the fields the user set, and no creation time (docs/adr/0005). */
function tags(metadata: VideoMetadata): MetadataTags {
  const set: MetadataTags = { creationTime: null };
  if (metadata.title) set.title = metadata.title;
  if (metadata.description) set.description = metadata.description;
  if (metadata.artist) set.artist = metadata.artist;
  if (metadata.comment) set.comment = metadata.comment;
  // A date is written only when it's a calendar date, as containers store dates.
  if (/^\d{4}-\d{2}-\d{2}$/.test(metadata.date)) {
    const date = new Date(`${metadata.date}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) set.date = date;
  }
  return set;
}

/**
 * Starts writing an export.
 *
 * @param withAudio - Whether the file has an audio track. A plan without audio writes none.
 * @param counted - Called with the file's size before each part is kept; it throws to stop the file.
 * @internal
 */
export async function createExportWriter(
  candidate: ExportCandidate,
  metadata: VideoMetadata,
  frameRate: number,
  withAudio: boolean,
  counted: (size: number) => void,
): Promise<ExportWriter> {
  const target = collector(counted);
  const output = new Output({
    format:
      candidate.container === "mp4"
        ? new Mp4OutputFormat({ fastStart: false })
        : new WebMOutputFormat(),
    target: new StreamTarget(target.stream),
  });
  const video = new EncodedVideoPacketSource(candidate.video.muxer);
  output.addVideoTrack(video, { frameRate });
  const audio = withAudio ? new EncodedAudioPacketSource(candidate.audio.muxer) : undefined;
  if (audio) output.addAudioTrack(audio);
  output.setMetadataTags(tags(metadata));
  await output.start();
  return {
    addVideo: (chunk, meta) => video.add(EncodedPacket.fromEncodedChunk(chunk), meta),
    addAudio: async (chunk, meta) => audio?.add(EncodedPacket.fromEncodedChunk(chunk), meta),
    async finish() {
      await output.finalize();
      return target.blob();
    },
    async cancel() {
      if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
    },
  };
}
