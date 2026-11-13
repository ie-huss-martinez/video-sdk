import {
  ChevronLeftIcon,
  ChevronRightIcon,
  IconButton,
  PauseIcon,
  PlayIcon,
  ToggleButton,
} from "@hussmartinez/ui/react";
import type { ReactNode } from "react";
import { planFrames } from "../core/model/plan.js";
import { frameTime } from "../core/model/time.js";
import { useVideoEditor, useVideoOutput, useVideoPlayhead, useVideoSession } from "./context.js";
import { formatTimecode } from "./timecode.js";
import { useVideoTools } from "./tools.js";

/**
 * Props of {@link VideoTransport}.
 *
 * @public
 */
export interface VideoTransportProps {
  readonly className?: string;
}

/**
 * Playback controls (docs/adr/0007): play and pause, the previous and next
 * frame, and the time as `position of length`. When the browser kept sound
 * from starting, a notice says how to turn it on.
 *
 * @public
 */
export function VideoTransport(props: VideoTransportProps): ReactNode {
  const { messages, locale } = useVideoEditor();
  const { snapshot } = useVideoSession();
  const { output, snapshot: playback } = useVideoOutput();
  const frame = useVideoPlayhead();
  const { ariaKeyShortcuts, labelWithKeys } = useVideoTools();
  /** A tool's shortcuts and tooltip, for the transport's own buttons. */
  const keysOf = (id: string) => ({
    title: labelWithKeys(id),
    "aria-keyshortcuts": ariaKeyShortcuts(id),
  });
  const plan = snapshot.plan;
  const frames = plan ? planFrames(plan) : 0;
  const disabled = !output || frames === 0;
  const playing = playback?.state === "playing";
  const rate = plan?.output.frameRate ?? { num: 30, den: 1 };
  const time = messages.t("transport.time", {
    position: formatTimecode(frameTime(frame, rate), locale),
    length: formatTimecode(frameTime(frames, rate), locale),
  });

  return (
    <fieldset
      className={["hm-video-transport", props.className].filter(Boolean).join(" ")}
      aria-label={messages.t("transport.label")}
    >
      <IconButton
        label={messages.t("transport.previousFrame")}
        icon={<ChevronLeftIcon />}
        disabled={disabled}
        {...keysOf("video.previous-frame")}
        onClick={() => output?.step(-1)}
      />
      <ToggleButton
        label={messages.t(playing ? "transport.pause" : "transport.play")}
        icon={playing ? <PauseIcon /> : <PlayIcon />}
        pressed={playing}
        disabled={disabled}
        {...keysOf("video.play-pause")}
        onPressedChange={(pressed) => {
          if (!output) return;
          if (pressed) void output.play().catch(() => {});
          else output.pause();
        }}
      />
      <IconButton
        label={messages.t("transport.nextFrame")}
        icon={<ChevronRightIcon />}
        disabled={disabled}
        {...keysOf("video.next-frame")}
        onClick={() => output?.step(1)}
      />
      <span className="hm-video-transport-time" aria-live="off">
        {time}
      </span>
      {playback?.audio === "blocked" ? (
        <p className="hm-video-transport-note" role="status">
          {messages.t("transport.audioBlocked")}
        </p>
      ) : null}
    </fieldset>
  );
}
