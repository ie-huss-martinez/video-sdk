# Security policy

`@hussmartinez/video-sdk` opens video files from anywhere: phone recordings, screen captures, downloads, user uploads. Its promise is that those files are processed on the user's device and never leave it. A vulnerability here can break that promise inside every application that embeds it, so reports are among the most valuable this project can receive. Thank you for taking the time to report one privately.

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion.**

Report it through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [the advisory form](https://github.com/ie-huss-martinez/video-sdk/security/advisories/new). Only the maintainer can see the report.

Please include:

- the affected version, or the commit;
- what an attacker can do, and under which conditions;
- steps to reproduce it, or a proof of concept. If it needs a crafted video, attach it to the private report. **Never attach a personal recording**, or any video or audio that shows or records people, places, voices, documents or anything else personal or confidential. Use a generated video, such as solid colours, a test pattern or a tone, or describe how to make one.

## What to expect

- **Acknowledgement** within 7 days.
- **Updates** at least every 14 days until the issue is resolved.
- **A fix and an advisory.** Once a fix is released, a GitHub Security Advisory describes the issue, with a CVE where it applies. You're credited in the advisory unless you'd rather not be.
- **Coordinated disclosure.** Please keep the issue private until the advisory is published, or for 90 days after your report, whichever comes first. If a fix needs longer, we'll agree on a date with you.

## Supported versions

The package is pre-1.0. Security fixes go into the latest release only. No version has been published yet.

## Scope

In scope is everything in this repository: `@hussmartinez/video-sdk`, its workers, its own probe and its integration of the demuxer, muxer and codecs, the workflows that verify and release it, and the published package. Examples:

- a video that runs script in the host page or a worker, or makes the SDK insert file-derived text, such as metadata, a track name or a file name, as HTML ([ADR 0001](docs/adr/0001-video-engines.md));
- a **container or codec bomb**: a file that declares or decodes to more than the file policy's limits allow, in frame pixels, frame rate, duration, bitrate, packet size, tracks, channels or sample rate, and still reaches a decoder. For example, a small file with millions of tiny packets; a header or sample table that claims less than the packets or the decoder produce; decoded frames larger than the probe reported; or a file that the SDK demuxes or decodes outside a worker ([ADR 0001](docs/adr/0001-video-engines.md));
- a video that freezes or crashes the page, hangs the probe or the demuxer, or exhausts memory despite the limits, including through decoded frames that are never closed ([ADR 0002](docs/adr/0002-workers-and-assets.md));
- any network request the SDK makes, including for workers, codecs, fonts or models ([ADR 0002](docs/adr/0002-workers-and-assets.md));
- **metadata and location leaks:** an exported video that carries metadata from its sources instead of only what the user set, such as GPS coordinates, the recording device, creation times, chapters, subtitle tracks or cover art; or an editor that says metadata was removed when it wasn't;
- **cut footage surviving an export:** video or audio the user trimmed, split off or deleted that is still in the exported file, for example as packets outside an edit list, an untrimmed track, or a source muxed alongside the edit. Exports are re-encoded and never copy a source's packets ([ADR 0001](docs/adr/0001-video-engines.md));
- **frames leaking between clips:** a frame or audio from one clip, source or editor appearing in another, such as a stale frame after a seek or an edit, a decoder or canvas reused without a reset, or one editor's video showing in another on the same page;
- file names, frames, audio or metadata reaching the host's `onEvent`, or anything else that leaks a video's data;
- styles from the standalone script that change the host page outside the editor;
- anything that requires a weaker Content Security Policy than documented, such as `unsafe-eval`;
- weaknesses in the build, release or publishing workflows, such as unpinned actions, excessive permissions, or a bundled dependency that doesn't match its pinned version.

The SDK checks and probes files with its own code, reads and writes containers with [mediabunny](https://github.com/Vanilagy/mediabunny) 1.65.2 (MPL-2.0), bundled at that exact version, and decodes and encodes with the browser's WebCodecs, all in workers ([ADR 0001](docs/adr/0001-video-engines.md)). **A known vulnerability in any third-party code that the SDK bundles, including mediabunny, is in scope** when the SDK's latest release still ships the affected version, because applications can only get the fix from us.

Out of scope:

- vulnerabilities in a browser's own video and audio codecs. Report those to the browser's vendor; tell us too if the SDK could avoid passing such files to the codec, for example through a limit;
- issues that need an already compromised device, browser or build environment;
- a file that is merely slow within the configured limits, or that a browser can't decode. Report those as public issues;
- accessibility defects. They matter just as much, but report them as a public issue so they can be fixed in the open.

Vulnerabilities in the shared runtime or the design system go to their repositories' security policies: [sdk-core's](https://github.com/ie-huss-martinez/sdk-core/security/policy) and [ui's](https://github.com/ie-huss-martinez/ui/security/policy).
