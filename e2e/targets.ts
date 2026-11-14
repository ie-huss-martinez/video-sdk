import { readFileSync } from "node:fs";

/**
 * Where the editor runs: each example, with its workers inlined (worker-src
 * blob:) and self-hosted (worker-src 'self'), each under its own Content
 * Security Policy.
 */
export const targets = [
  { name: "Vite, inlined workers", url: "http://localhost:4330/inline.html", selfHosted: false },
  {
    name: "Vite, self-hosted workers",
    url: "http://localhost:4330/self-hosted.html",
    selfHosted: true,
  },
  { name: "Next.js, self-hosted workers", url: "http://localhost:4331/", selfHosted: true },
  { name: "Next.js, inlined workers", url: "http://localhost:4331/inline", selfHosted: false },
] as const;

/** The self-hosted workers' paths, which only the self-hosted pages load. */
export const WORKER_PATHS = [
  "/video-sdk/video/media.worker.js",
  "/video-sdk/video/export.worker.js",
];

/** The package's own 2 s test video, 60 frames at 30 per second, with audio. */
export const video = (): Buffer =>
  readFileSync(new URL("../test/fixtures/video/landscape-vp8.webm", import.meta.url));
