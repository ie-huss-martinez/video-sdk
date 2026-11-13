// Module types for the few non-standard imports the library makes. Declared
// here rather than through vite/client, so the library doesn't see Vite's
// or Node's global types.

/** A worker that Vite inlines into the build as a blob (docs/adr/0002). */
declare module "*?worker&inline" {
  const InlineWorker: new (options?: { readonly name?: string }) => Worker;
  export default InlineWorker;
}

/** The package's version, replaced at build time (sdk-core ADR 0038). */
declare const __VIDEO_SDK_VERSION__: string;
