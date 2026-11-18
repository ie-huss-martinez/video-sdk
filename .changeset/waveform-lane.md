---
"@hussmartinez/video-sdk": minor
---

The editor's timeline now shows each clip's sound as a waveform under the clips, at the clip's volume and fades, so a muted clip shows flat. The clips let it show through, each with a short title such as "Clip 2".

For your own drawing:

- **`session.getPeaks(source)`** returns a source's waveform peaks, the lowest and highest sample of each 10 ms. They're built in the background after a file is inserted, so the clip appears without waiting for them. Until they arrive it returns `undefined`, and when they do, the snapshot's new `peaksVersion` goes up. A source without sound never has peaks.
- **`peakColumns(peaks, { from, to, columns })`** turns peaks into one lowest and one highest sample per column, for a source's time from `from` to `to` in microseconds.
