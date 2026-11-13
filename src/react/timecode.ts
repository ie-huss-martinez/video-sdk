/**
 * A time on the timeline as a timecode, `m:ss.cc`, or `h:mm:ss.cc` from an
 * hour: minutes, seconds and hundredths, with the locale's digits.
 *
 * @param microseconds - A time, in microseconds.
 * @internal
 */
export function formatTimecode(microseconds: number, locale?: string): string {
  const hundredths = Math.floor(Math.max(0, microseconds) / 10_000);
  const hours = Math.floor(hundredths / 360_000);
  const minutes = Math.floor(hundredths / 6_000) % 60;
  const seconds = Math.floor(hundredths / 100) % 60;
  const fraction = hundredths % 100;
  const one = new Intl.NumberFormat(locale, { useGrouping: false });
  const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const clock =
    hours > 0
      ? `${one.format(hours)}:${two.format(minutes)}:${two.format(seconds)}`
      : `${one.format(minutes)}:${two.format(seconds)}`;
  return `${clock}.${two.format(fraction)}`;
}
