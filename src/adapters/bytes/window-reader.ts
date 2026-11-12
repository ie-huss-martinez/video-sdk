// TODO(sdk-core 0.3.0): import `createWindowReader` from `@hussmartinez/sdk-core`
// (sdk-core ADR 0037) once a fixed 0.3.0 is published, and delete this copy.

/** The default window: large enough that walking a file costs few `Blob` reads. */
const DEFAULT_WINDOW_SIZE = 1 << 20;

/**
 * Options for {@link createWindowReader}.
 *
 * @internal
 */
export interface WindowReaderOptions {
  /**
   * How many bytes to read from the `Blob` at a time, at least. A positive
   * integer; 1 MiB by default.
   */
  readonly windowSize?: number;
}

/**
 * Reads a `Blob` through a window, for parsers that walk a file in small
 * steps, such as a probe reading frame headers. From {@link createWindowReader}.
 *
 * @internal
 */
export interface WindowReader {
  /** The file's size in bytes. */
  readonly size: number;
  /**
   * Reads up to `length` bytes at `offset`: fewer at the end of the file, and
   * none at or past it.
   *
   * When the bytes aren't in the current window, it reads a new window from
   * `offset`, of `length` bytes or the window size, whichever is larger, but
   * never past the end of the file. So a read never holds more than the rest
   * of the file, which the file policy's size limit already bounds.
   *
   * The result is a view into the window. It stays valid after later reads,
   * but don't modify it: later reads from the same window would see the
   * change. Copy it first with `slice()` to keep or change it.
   *
   * @param offset - Where to start, in bytes. A non-negative integer.
   * @param length - How many bytes to read. A non-negative integer.
   * @throws `RangeError` if `offset` or `length` isn't a non-negative integer.
   * @returns The bytes. It rejects with the `Blob`'s own error, such as
   *   `NotReadableError`, if the file can't be read.
   */
  bytes(offset: number, length: number): Promise<Uint8Array>;
}

/** Throws unless the value is a non-negative safe integer. */
function checkCount(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `The ${name} must be an integer of at least ${minimum}, not ${String(value)}.`,
    );
  }
}

/**
 * Creates a {@link WindowReader}, which reads a `Blob` in large slices so that
 * parsers walking it in small steps never load all of it, and make few reads.
 *
 * @example
 * ```ts
 * const reader = createWindowReader(file);
 * const header = await reader.bytes(0, 12);
 * ```
 *
 * @param file - The file to read.
 * @param options - The window size.
 * @throws `RangeError` if `windowSize` isn't a positive integer.
 * @internal
 */
export function createWindowReader(file: Blob, options: WindowReaderOptions = {}): WindowReader {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  checkCount("window size", windowSize, 1);
  const size = file.size;
  let start = 0;
  let window = new Uint8Array(0);

  return {
    size,
    async bytes(offset, length) {
      checkCount("offset", offset, 0);
      checkCount("length", length, 0);
      const from = Math.min(offset, size);
      const end = Math.min(size, from + length);
      if (from < start || end > start + window.length) {
        const windowEnd = Math.min(size, from + Math.max(length, windowSize));
        window = new Uint8Array(await file.slice(from, windowEnd).arrayBuffer());
        start = from;
      }
      return window.subarray(from - start, end - start);
    },
  };
}
