import { describe, expect, it, vi } from "vitest";
import { createLazyPlaybackAudio } from "./lazy-playback-audio.js";

// The lazy player's start and close (docs/adr/0006): the output can be
// destroyed while the player is still loading or starting.
function fakeContext() {
  return {
    state: "suspended",
    // A resume that waits for a gesture that never comes.
    resume: () => new Promise<void>(() => {}),
    close: vi.fn(async () => {}),
  };
}

describe("the lazy audio player", () => {
  it("cancels a start that close overtakes while loading, and creates no context after", async () => {
    const contexts: ReturnType<typeof fakeContext>[] = [];
    const player = createLazyPlaybackAudio({
      createContext: () => {
        const context = fakeContext();
        contexts.push(context);
        return context as unknown as AudioContext;
      },
      fetchWindow: async () => [],
      timeOrigin: 0,
      performanceNow: () => 0,
    });
    const started = player.start();
    started.catch(() => {});
    await player.close();
    await expect(started).rejects.toMatchObject({ name: "VideoError", code: "ABORTED" });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.close).toHaveBeenCalled();
    await expect(player.start()).rejects.toMatchObject({ code: "ABORTED" });
    expect(await player.play(0, 1_000_000)).toBeUndefined();
    expect(contexts).toHaveLength(1);
  });
});
