import {
  Button,
  Field,
  IconButton,
  NumberField,
  RotateLeftIcon,
  RotateRightIcon,
  SegmentedControl,
} from "@hussmartinez/ui/react";
import { type ReactNode, useId, useMemo } from "react";
import type { VideoClip, VideoCrop, VideoFit, VideoPlan } from "../core/model/plan.js";
import type { VideoSourceInfo } from "../core/model/source.js";
import type { VideoCommand } from "../core/operations/commands.js";
import {
  type ClipPictureState,
  cropCommand,
  fitCommands,
  rotateCommands,
} from "../features/clip-picture/clip-picture.js";
import { useVideoEditor } from "./context.js";

const FITS: readonly VideoFit[] = ["contain", "cover"];

/** The crop's fields, in the order they're shown, with the message each is named by. */
const CROP_FIELDS = [
  ["x", "inspector.cropLeft"],
  ["y", "inspector.cropTop"],
  ["width", "inspector.cropWidth"],
  ["height", "inspector.cropHeight"],
] as const;

/**
 * The picture of the selected clips (docs/adr/0007): a quarter turn either
 * way, how the picture fills the frame, and, for one clip, its crop in
 * pixels of the picture as it's shown. Each change is one undo step, for
 * every selected clip.
 *
 * @internal
 */
export function PictureControls({
  plan,
  sources,
  state,
  execute,
}: {
  readonly plan: VideoPlan;
  readonly sources: readonly VideoSourceInfo[];
  readonly state: ClipPictureState;
  readonly execute: (commands: VideoCommand | readonly VideoCommand[]) => void;
}): ReactNode {
  const { messages, locale } = useVideoEditor();
  const ids = useId();
  // Pixels are counts, read digit by digit: no grouping, as in "1280".
  const pixels = useMemo(() => new Intl.NumberFormat(locale, { useGrouping: false }), [locale]);
  const keys = state.keys;
  const lead = state.lead as VideoClip;
  const frame = state.frame;
  const whole = frame ? { x: 0, y: 0, width: frame.width, height: frame.height } : null;
  const crop = lead.transform.crop ?? whole;
  /** The most each field can be, with the others as they are. */
  const most = (field: keyof VideoCrop): number => {
    if (!frame || !crop) return 0;
    if (field === "x") return frame.width - 2;
    if (field === "y") return frame.height - 2;
    return field === "width" ? frame.width - crop.x : frame.height - crop.y;
  };

  return (
    <fieldset className="hm-video-inspector-group">
      <legend className="hm-video-inspector-legend">
        {messages.t("inspector.picture", { count: keys.length })}
      </legend>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would nest a second legend in the group */}
      <div className="hm-video-inspector-row" role="group" aria-labelledby={`${ids}-rotation`}>
        <span className="hm-video-inspector-label" id={`${ids}-rotation`}>
          {messages.t("inspector.rotation")}
        </span>
        {/* An output is announced when it changes, so a turn is heard. */}
        <output className="hm-video-inspector-value">
          {state.rotation === null
            ? messages.t("inspector.rotationMixed")
            : messages.t("inspector.degrees", { degrees: state.rotation })}
        </output>
        <IconButton
          label={messages.t("inspector.rotateLeft")}
          icon={<RotateLeftIcon />}
          onClick={() => execute(rotateCommands(plan, sources, keys, 270))}
        />
        <IconButton
          label={messages.t("inspector.rotateRight")}
          icon={<RotateRightIcon />}
          onClick={() => execute(rotateCommands(plan, sources, keys, 90))}
        />
      </div>
      {/* A visible name for the group, which names it too (WCAG 2.5.3). */}
      <span className="hm-video-inspector-label" id={`${ids}-fit`}>
        {messages.t("inspector.fit")}
      </span>
      <SegmentedControl
        aria-labelledby={`${ids}-fit`}
        label={messages.t("inspector.fit")}
        size="small"
        value={state.fit ?? lead.transform.fit}
        options={FITS.map((value) => ({ value, label: messages.t(`inspector.fits.${value}`) }))}
        onValueChange={(fit) => execute(fitCommands(plan, keys, fit))}
      />
      {frame && crop ? (
        <>
          {CROP_FIELDS.map(([field, label]) => (
            <Field key={field} label={messages.t(label)}>
              <NumberField
                min={field === "width" || field === "height" ? 2 : 0}
                max={most(field)}
                step={1}
                largeStep={10}
                value={crop[field]}
                format={(value) => pixels.format(value)}
                onValueChange={(value) => execute(cropCommand(lead, frame, { [field]: value }))}
              />
            </Field>
          ))}
          <Button
            className="hm-video-inspector-action"
            disabled={lead.transform.crop === null}
            onClick={() => execute(cropCommand(lead, frame, null))}
          >
            {messages.t("inspector.cropReset")}
          </Button>
        </>
      ) : (
        <p className="hm-video-inspector-note">{messages.t("inspector.cropOne")}</p>
      )}
    </fieldset>
  );
}
