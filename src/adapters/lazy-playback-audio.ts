import type { PlaybackAnchor } from "../core/playback/timeline.js";
import type { AudioEnvironment, PlaybackAudio } from "./playback-audio.js";

/**
 * The page's audio player, loaded on the first `start` (docs/adr/0006), so
 * the root entry doesn't carry it for hosts that never play: it's only
 * needed once a plan with audio plays. The context is created and resumed
 * synchronously, still within the user's gesture; the player that schedules
 * windows on it loads after.
 *
 * @internal
 */
export function createLazyPlaybackAudio(environment: AudioEnvironment): PlaybackAudio {
  let context: AudioContext | undefined;
  let player: PlaybackAudio | undefined;
  let hidden = false;
  let loading: Promise<PlaybackAudio> | undefined;

  const load = () => {
    loading ??= import("./playback-audio.js").then(({ createPlaybackAudio }) => {
      player = createPlaybackAudio({
        ...environment,
        createContext: () => context ?? environment.createContext(),
      });
      player.setHidden(hidden);
      return player;
    });
    return loading;
  };

  return {
    start() {
      if (!context) {
        context = environment.createContext();
        // Within the gesture: some browsers no longer count it after an await.
        void context.resume().catch(() => {});
      }
      return load().then((loaded) => loaded.start());
    },
    async play(fromTime: number, endTime: number): Promise<PlaybackAnchor | undefined> {
      return (await load()).play(fromTime, endTime);
    },
    anchor: () => player?.anchor(),
    stalled: () => player?.stalled() ?? false,
    switchPlan(endTime) {
      player?.switchPlan(endTime);
    },
    setHidden(value) {
      hidden = value;
      player?.setHidden(value);
    },
    stop() {
      player?.stop();
    },
    async close() {
      if (player) return player.close();
      await context?.close().catch(() => {});
      context = undefined;
    },
  };
}
