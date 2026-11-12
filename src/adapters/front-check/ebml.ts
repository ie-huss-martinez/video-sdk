import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import type { WindowReader } from "../bytes/window-reader.js";
import { malformed, refused } from "./errors.js";
import type { FrontCheck } from "./types.js";

const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const TRACKS = 0x1654ae6b;
const CUES = 0x1c53bb6b;
const TAGS = 0x1254c367;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const CONTENT_ENCODINGS = 0x6d80;
const CONTENT_ENCODING = 0x6240;
const CONTENT_ENCRYPTION = 0x5035;

/** The Segment's children that hold its index (ADR 0001). */
const INDEX_ELEMENTS = new Set([SEEK_HEAD, TRACKS, CUES, TAGS]);
/** Every Segment child, which also ends a Cluster of unknown size. */
const SEGMENT_CHILDREN = new Set([
  SEEK_HEAD,
  0x1549a966, // Info
  TRACKS,
  CUES,
  TAGS,
  CLUSTER,
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

/** An element header: its id, where its data is, and its size, or `undefined` if unknown. */
interface Element {
  readonly id: number;
  readonly start: number;
  readonly data: number;
  readonly size: number | undefined;
}

/**
 * Whether a file starts with an EBML header.
 *
 * @internal
 */
export async function looksEbml(reader: WindowReader): Promise<boolean> {
  const head = await reader.bytes(0, 4);
  return head.length === 4 && new DataView(head.buffer, head.byteOffset, 4).getUint32(0) === EBML;
}

/**
 * The front check for Matroska and WebM (ADR 0001), before mediabunny reads
 * the file: it walks the Segment's children, bounding the index, counting
 * tracks and refusing encrypted ones. Elements of unknown size are allowed
 * only for the Segment and its Clusters, as `MediaRecorder` writes them; a
 * Cluster of unknown size is walked to its end, block by block. Every size is
 * checked against its parent, and every loop advances.
 *
 * @internal
 */
export async function checkEbml(
  reader: WindowReader,
  policy: VideoFilePolicy,
  maxElements: number,
): Promise<FrontCheck> {
  let container: "webm" | "mkv" = "mkv";
  let elements = 0;

  const header = async (offset: number, end: number): Promise<Element> => {
    elements += 1;
    if (elements > maxElements) throw malformed(container, "too-many-elements");
    const bytes = await reader.bytes(offset, 12);
    const first = bytes[0];
    if (first === undefined || first === 0) throw malformed(container, "truncated");
    const idLength = Math.clz32(first) - 23;
    if (idLength > 4 || bytes.length < idLength + 1) throw malformed(container, "element-size");
    let id = 0;
    for (let i = 0; i < idLength; i += 1) id = id * 256 + (bytes[i] as number);
    const sizeFirst = bytes[idLength] as number;
    if (sizeFirst === 0) throw malformed(container, "element-size");
    const sizeLength = Math.clz32(sizeFirst) - 23;
    if (bytes.length < idLength + sizeLength) throw malformed(container, "truncated");
    let size = sizeFirst & (0xff >> sizeLength);
    let unknown = size === 0xff >> sizeLength;
    for (let i = 1; i < sizeLength; i += 1) {
      const byte = bytes[idLength + i] as number;
      size = size * 256 + byte;
      unknown &&= byte === 0xff;
    }
    const data = offset + idLength + sizeLength;
    if (data > end) throw malformed(container, "truncated");
    if (unknown) return { id, start: offset, data, size: undefined };
    if (!Number.isSafeInteger(size)) throw malformed(container, "element-size");
    if (data + size > end) throw malformed(container, "truncated");
    return { id, start: offset, data, size };
  };

  /** Calls `visit` for each child of an element of known size. */
  const children = async (parent: Element, visit: (child: Element) => Promise<void>) => {
    const end = parent.data + (parent.size ?? 0);
    let offset = parent.data;
    while (offset < end) {
      const element = await header(offset, end);
      if (element.size === undefined) throw malformed(container, "element-size");
      await visit(element);
      offset = element.data + element.size;
    }
  };

  const head = await header(0, reader.size);
  if (head.id !== EBML || head.size === undefined) throw refused(container, "signature");
  let docType: string | undefined;
  await children(head, async (element) => {
    if (element.id === DOC_TYPE && element.size !== undefined && element.size <= 64) {
      docType = String.fromCharCode(...(await reader.bytes(element.data, element.size))).replace(
        /\0+$/,
        "",
      );
    }
  });
  if (docType === "webm") container = "webm";
  else if (docType !== "matroska") throw refused("matroska", "doc-type");

  const segment = await header(head.data + head.size, reader.size);
  if (segment.id !== SEGMENT) throw malformed(container, "no-index");
  const segmentEnd = segment.size === undefined ? reader.size : segment.data + segment.size;

  let indexSize = 0;
  let tracks = 0;
  let sawTracks = false;
  let offset = segment.data;
  while (offset < segmentEnd) {
    const element = await header(offset, segmentEnd);
    if (element.size === undefined) {
      if (element.id !== CLUSTER) throw malformed(container, "element-size");
      // Walk the blocks until the next Segment child, or the end.
      offset = element.data;
      while (offset < segmentEnd) {
        const inner = await header(offset, segmentEnd);
        if (SEGMENT_CHILDREN.has(inner.id)) break;
        if (inner.size === undefined) throw malformed(container, "element-size");
        offset = inner.data + inner.size;
      }
      continue;
    }
    if (INDEX_ELEMENTS.has(element.id)) {
      indexSize += element.data + element.size - element.start;
      policy.check("maxIndexSize", indexSize);
    }
    if (element.id === TRACKS) {
      sawTracks = true;
      await children(element, async (entry) => {
        if (entry.id !== TRACK_ENTRY) return;
        tracks += 1;
        await children(entry, async (field) => {
          if (field.id !== CONTENT_ENCODINGS) return;
          await children(field, async (encoding) => {
            if (encoding.id !== CONTENT_ENCODING) return;
            await children(encoding, async (part) => {
              if (part.id === CONTENT_ENCRYPTION) throw refused(container, "encryption");
            });
          });
        });
      });
    }
    offset = element.data + element.size;
  }
  if (!sawTracks) throw malformed(container, "no-index");
  if (tracks === 0) throw malformed(container, "no-tracks");
  return { container, family: "matroska", indexSize, tracks };
}
