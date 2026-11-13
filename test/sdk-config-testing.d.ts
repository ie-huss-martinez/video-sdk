// Types for sdk-config's test helper, which ships as JavaScript with JSDoc
// and no declaration file. They mirror its JSDoc; drop this file once
// sdk-config ships its own.
declare module "@hussmartinez/sdk-config/testing/audio-output" {
  export interface AudioOutput {
    /** Whether an `AudioContext` runs, at real-time speed. */
    readonly available: boolean;
    /** Why not, as a suffix for a skipped test's name. Empty when available. */
    readonly reason: string;
    /** How fast the context's clock ran against `performance.now()`, when it ran. */
    readonly clockRatio?: number;
  }

  export interface AudioOutputOptions {
    /** Clicks the button as a user would, for browsers that start audio only after a gesture. */
    readonly activate?: (button: HTMLButtonElement) => Promise<void>;
    readonly createContext?: () => AudioContext;
    readonly measureMs?: number;
  }

  /** Probes, once per test run, whether this browser can play audio at real-time speed. */
  export function audioOutput(options?: AudioOutputOptions): Promise<AudioOutput>;
}
