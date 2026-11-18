import {
  Field,
  MutedIcon,
  NumberField,
  SegmentedControl,
  Slider,
  ToggleButton,
} from "@hussmartinez/ui/react";
import { type ReactNode, useCallback, useId, useMemo, useRef } from "react";
import {
  type VideoClip,
  type VideoFadeCurve,
  type VideoPlan,
  VOLUME_RANGE,
} from "../core/model/plan.js";
import type { VideoCommand } from "../core/operations/commands.js";
import {
  type ClipAudioState,
  clipAudioState,
  fadeCommands,
} from "../features/clip-audio/clip-audio.js";
import { clipPictureState } from "../features/clip-picture/clip-picture.js";
import { useVideoEditor, useVideoOutput, useVideoSession } from "./context.js";
import { useGestureValue } from "./gesture.js";
import { PictureControls } from "./PictureControls.js";
import { useVideoTools } from "./tools.js";

/**
 * Props of {@link VideoInspector}.
 *
 * @public
 */
export interface VideoInspectorProps {
  readonly className?: string;
}

/**
 * The volume slider's range, in decibels: where volume is usually set. The
 * number field beside it takes the model's whole range.
 */
const SLIDER_RANGE = { min: -60, max: 12 } as const;

const CURVES: readonly VideoFadeCurve[] = ["linear", "equalPower"];

const MICROSECONDS = 1_000_000;

/**
 * How often a drag of the volume slider is played to the preview, in
 * milliseconds: often enough to set a volume by ear, and no more often than
 * the audio can take a new plan.
 */
const PREVIEW_INTERVAL = 100;

/**
 * The inspector (docs/adr/0007, docs/adr/0008): the selected clips' sound
 * and picture. Volume, mute, and a fade in and out, each with its length
 * and shape; then a quarter turn, how the picture fills the frame, and one
 * clip's crop. A
 * change applies to every selected clip, as one undo step; a drag of the
 * volume slider, or a run of its keys, is one step too, and is
 * heard as it moves while the video plays. With no clip
 * selected it says what to select, and before a video is open it renders
 * nothing.
 *
 * @public
 */
export function VideoInspector(props: VideoInspectorProps): ReactNode {
  const { messages, selectedClips } = useVideoEditor();
  const { session, snapshot } = useVideoSession();
  const { plan, sources } = snapshot;
  const state = useMemo(
    () => clipAudioState(plan, sources, selectedClips),
    [plan, sources, selectedClips],
  );

  const picture = useMemo(
    () => clipPictureState(plan, sources, selectedClips),
    [plan, sources, selectedClips],
  );

  const execute = useCallback(
    (commands: VideoCommand | readonly VideoCommand[]) => {
      try {
        session.execute(commands);
      } catch {
        // The session's snapshot holds the error, which the stage shows.
      }
    },
    [session],
  );

  if (!plan) return null;
  const className = ["hm-video-inspector", props.className].filter(Boolean).join(" ");
  const keys = state.keys;
  if (keys.length === 0) {
    return (
      <section className={className} aria-label={messages.t("inspector.label")}>
        <p className="hm-video-inspector-note">{messages.t("inspector.empty")}</p>
      </section>
    );
  }

  return (
    <section className={className} aria-label={messages.t("inspector.label")}>
      {/* A new selection is a new set of controls, so a volume drag that's
          still pending is committed to the clips it was made on. */}
      <SoundControls key={keys.join("\u0000")} plan={plan} state={state} execute={execute} />
      <PictureControls plan={plan} sources={sources} state={picture} execute={execute} />
    </section>
  );
}

/** The sound of the selected clips: volume, mute and the two fades. */
function SoundControls({
  plan,
  state,
  execute,
}: {
  readonly plan: VideoPlan;
  readonly state: ClipAudioState;
  readonly execute: (commands: VideoCommand | readonly VideoCommand[]) => void;
}): ReactNode {
  const { messages, session, setPreview } = useVideoEditor();
  const { snapshot: playback } = useVideoOutput();
  const { ariaKeyShortcuts, labelWithKeys } = useVideoTools();
  const ids = useId();
  const keys = state.keys;
  const count = keys.length;
  const lead = state.lead as VideoClip;
  const setVolume = useCallback(
    (volumeDb: number) => {
      // A drag can be committed as its clips go, such as by an undo: only
      // the clips the plan still has take it.
      const present = new Set(session.getSnapshot().plan?.clips.map((clip) => clip.key));
      const live = keys.filter((key) => present.has(key));
      if (live.length > 0) execute({ type: "video.setVolume", keys: live, volumeDb });
    },
    [execute, keys, session],
  );
  // While it plays, a drag is heard as it moves: the preview plays the plan
  // with the slider's volume, and the drag still commits one command.
  const playing = playback?.state === "playing";
  const waiting = useRef<{ timer: ReturnType<typeof setTimeout>; volumeDb: number } | null>(null);
  const endPreview = useCallback(() => {
    if (waiting.current) clearTimeout(waiting.current.timer);
    waiting.current = null;
    setPreview(null);
  }, [setPreview]);
  const previewVolume = useCallback(
    (volumeDb: number) => {
      if (!playing) return;
      const show = () => {
        const next = waiting.current?.volumeDb;
        waiting.current = null;
        const current = session.getSnapshot().plan;
        if (next === undefined || !current) return;
        const chosen = new Set(keys);
        setPreview({
          ...current,
          clips: current.clips.map((clip) =>
            chosen.has(clip.key) ? { ...clip, volumeDb: next } : clip,
          ),
        });
      };
      // At most one preview every PREVIEW_INTERVAL, ending on the last value.
      if (waiting.current) waiting.current.volumeDb = volumeDb;
      else waiting.current = { timer: setTimeout(show, PREVIEW_INTERVAL), volumeDb };
    },
    [playing, session, keys, setPreview],
  );
  const slider = useGestureValue(state.volumeDb ?? lead.volumeDb, setVolume, endPreview);

  const decibels = (db: number) => messages.t("inspector.decibels", { db });
  const mixed =
    state.volumeDb === null ||
    state.muted === null ||
    [state.fadeIn, state.fadeOut].some((fade) => fade.duration === null || fade.curve === null);
  const fade = (edge: "in" | "out") => {
    const shown = edge === "in" ? state.fadeIn : state.fadeOut;
    const own = edge === "in" ? lead.fadeIn : lead.fadeOut;
    const label = messages.t(edge === "in" ? "inspector.fadeIn" : "inspector.fadeOut");
    const shape = messages.t(edge === "in" ? "inspector.fadeInShape" : "inspector.fadeOutShape");
    return (
      <>
        <Field label={label}>
          <NumberField
            min={0}
            max={shown.max / MICROSECONDS}
            step={0.1}
            largeStep={1}
            value={Math.min(shown.duration ?? own.duration, shown.max) / MICROSECONDS}
            onValueChange={(seconds) =>
              execute(fadeCommands(plan, keys, edge, { duration: seconds * MICROSECONDS }))
            }
          />
        </Field>
        {/* A visible name for the group, which names it too (WCAG 2.5.3). */}
        <span className="hm-video-inspector-label" id={`${ids}-${edge}`}>
          {shape}
        </span>
        <SegmentedControl
          aria-labelledby={`${ids}-${edge}`}
          label={shape}
          size="small"
          value={shown.curve ?? own.curve}
          options={CURVES.map((value) => ({
            value,
            label: messages.t(`inspector.curves.${value}`),
          }))}
          onValueChange={(curve) => execute(fadeCommands(plan, keys, edge, { curve }))}
        />
      </>
    );
  };

  return (
    <fieldset className="hm-video-inspector-group">
      <legend className="hm-video-inspector-legend">
        {messages.t("inspector.sound", { count })}
      </legend>
      {state.hasAudio ? (
        <>
          {mixed ? (
            <p className="hm-video-inspector-note">{messages.t("inspector.mixed")}</p>
          ) : null}
          <Field label={messages.t("inspector.volume")}>
            <Slider
              ref={slider.ref}
              min={SLIDER_RANGE.min}
              max={SLIDER_RANGE.max}
              step={1}
              largeStep={6}
              value={Math.min(Math.max(slider.value, SLIDER_RANGE.min), SLIDER_RANGE.max)}
              onValueChange={(value) => {
                slider.change(value);
                previewVolume(value);
              }}
              formatValue={decibels}
            />
          </Field>
          <Field label={messages.t("inspector.volumeExact")}>
            <NumberField
              min={VOLUME_RANGE.min}
              max={VOLUME_RANGE.max}
              step={1}
              largeStep={6}
              value={slider.value}
              onValueChange={setVolume}
            />
          </Field>
          <ToggleButton
            className="hm-video-inspector-mute"
            startIcon={<MutedIcon />}
            pressed={state.muted === true}
            title={labelWithKeys("video.mute")}
            aria-keyshortcuts={ariaKeyShortcuts("video.mute")}
            onPressedChange={(muted) => execute({ type: "video.setMuted", keys, muted })}
          >
            {messages.t("inspector.mute")}
          </ToggleButton>
          {fade("in")}
          {fade("out")}
        </>
      ) : (
        <p className="hm-video-inspector-note">{messages.t("inspector.noSound", { count })}</p>
      )}
    </fieldset>
  );
}
