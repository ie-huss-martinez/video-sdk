import { defineReactLint } from "@hussmartinez/sdk-config/eslint-react";

// React's own lint plugin, and nothing else: Biome stays the linter and
// formatter (sdk-core ADR 0063).
export default await defineReactLint({
  // Off while they have findings, each until the pull request that fixes it
  // turns it back on:
  // - refs, 3 in react/context.tsx: the latest-ref pattern, once ui has
  //   useLatest.
  // - immutability, 2 in VideoToolbar.tsx: the file chooser's ref.
  // - set-state-in-effect, 3 in VideoExportDialog, VideoInspector and
  //   VideoStage: state that follows a prop.
  // - exhaustive-deps, 6 in VideoTimeline, context.tsx and tools.ts:
  //   dependencies made anew on every render. Biome's rule checks dependency
  //   lists meanwhile (biome.json).
  off: ["refs", "immutability", "set-state-in-effect", "exhaustive-deps"],
});
