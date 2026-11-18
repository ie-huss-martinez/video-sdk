import { Field, NumberField, SegmentedControl, TextArea, TextField } from "@hussmartinez/ui/react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { videoLimits } from "../core/errors/video-limits.js";
import type { VideoMetadata, VideoPlan } from "../core/model/plan.js";
import type { VideoCommand } from "../core/operations/commands.js";
import {
  changedOutput,
  channelChoices,
  metadataCommand,
  metadataProblem,
  type OutputChange,
  type OutputProblem,
  outputCommand,
  outputProblem,
  sampleRateChoices,
} from "../features/output-settings/output-settings.js";
import { useVideoEditor } from "./context.js";

type Execute = (commands: VideoCommand | readonly VideoCommand[]) => void;

/**
 * The output and the metadata (docs/adr/0007), shown when no clip is
 * selected: what an export is made at, and the only metadata it writes.
 * Each committed change is one undo step.
 *
 * @internal
 */
export function OutputControls({
  plan,
  execute,
}: {
  readonly plan: VideoPlan;
  readonly execute: Execute;
}): ReactNode {
  return (
    <>
      <OutputGroup plan={plan} execute={execute} />
      <MetadataGroup plan={plan} execute={execute} />
    </>
  );
}

function OutputGroup({ plan, execute }: { readonly plan: VideoPlan; readonly execute: Execute }) {
  const { messages, locale, filePolicy } = useVideoEditor();
  const ids = useId();
  const policy = useMemo(() => videoLimits.resolve(filePolicy), [filePolicy]);
  const output = plan.output;
  const [refused, setRefused] = useState<OutputProblem | null>(null);
  // Pixels are counts, read digit by digit: no grouping, as in "1920".
  const pixels = useMemo(() => new Intl.NumberFormat(locale, { useGrouping: false }), [locale]);
  const rate = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 3, useGrouping: false }),
    [locale],
  );

  /** Sets the output, unless the file policy would refuse it: then the field says why. */
  const change = (what: OutputChange) => {
    const next = changedOutput(output, what);
    const problem = outputProblem(policy, next);
    setRefused(problem ?? null);
    if (problem) return;
    const command = outputCommand(plan, next);
    if (command) execute(command);
  };
  const error = refused
    ? refused.reason === "too-large"
      ? messages.t("inspector.outputTooLarge", { maximum: refused.maximum })
      : messages.t("inspector.rateTooHigh", { maximum: refused.maximum })
    : undefined;
  const channelLabel = (count: number) =>
    count === 1
      ? messages.t("inspector.mono")
      : count === 2
        ? messages.t("inspector.stereo")
        : messages.t("inspector.channels", { count });

  return (
    <fieldset className="hm-video-inspector-group">
      <legend className="hm-video-inspector-legend">{messages.t("inspector.output")}</legend>
      <p className="hm-video-inspector-note">{messages.t("inspector.outputNote")}</p>
      <Field
        label={messages.t("inspector.width")}
        error={refused?.reason === "too-large" ? error : undefined}
      >
        <NumberField
          min={2}
          step={2}
          largeStep={20}
          value={output.width}
          format={(value) => pixels.format(value)}
          onValueChange={(width) => change({ width })}
        />
      </Field>
      <Field label={messages.t("inspector.height")}>
        <NumberField
          min={2}
          step={2}
          largeStep={20}
          value={output.height}
          format={(value) => pixels.format(value)}
          onValueChange={(height) => change({ height })}
        />
      </Field>
      <Field
        label={messages.t("inspector.frameRate")}
        description={messages.t("inspector.frameRateNote")}
        error={refused?.reason === "rate-too-high" ? error : undefined}
      >
        <NumberField
          min={1}
          step={1}
          largeStep={10}
          value={output.frameRate.num / output.frameRate.den}
          format={(value) => rate.format(value)}
          onValueChange={(framesPerSecond) => change({ framesPerSecond })}
        />
      </Field>
      {/* A visible name for each group, which names it too (WCAG 2.5.3). */}
      <span className="hm-video-inspector-label" id={`${ids}-rate`}>
        {messages.t("inspector.sampleRate")}
      </span>
      <SegmentedControl
        aria-labelledby={`${ids}-rate`}
        label={messages.t("inspector.sampleRate")}
        size="small"
        value={String(output.sampleRate)}
        options={sampleRateChoices(output).map((value) => ({
          value: String(value),
          label: messages.t("inspector.kilohertz", { rate: value / 1_000 }),
        }))}
        onValueChange={(value) => change({ sampleRate: Number(value) })}
      />
      <span className="hm-video-inspector-label" id={`${ids}-channels`}>
        {messages.t("inspector.outputSound")}
      </span>
      <SegmentedControl
        aria-labelledby={`${ids}-channels`}
        label={messages.t("inspector.outputSound")}
        size="small"
        value={String(output.channels)}
        options={channelChoices(output).map((value) => ({
          value: String(value),
          label: channelLabel(value),
        }))}
        onValueChange={(value) => change({ channels: Number(value) })}
      />
    </fieldset>
  );
}

/** The metadata fields, in order, each a line or a paragraph. */
const FIELDS: readonly { readonly field: keyof VideoMetadata; readonly long: boolean }[] = [
  { field: "title", long: false },
  { field: "artist", long: false },
  { field: "date", long: false },
  { field: "description", long: true },
  { field: "comment", long: true },
];

function MetadataGroup({ plan, execute }: { readonly plan: VideoPlan; readonly execute: Execute }) {
  const { messages } = useVideoEditor();
  return (
    <fieldset className="hm-video-inspector-group">
      <legend className="hm-video-inspector-legend">{messages.t("inspector.metadata")}</legend>
      <p className="hm-video-inspector-note">{messages.t("inspector.metadataNote")}</p>
      {FIELDS.map(({ field, long }) => (
        // A new value from elsewhere, such as an undo, replaces what's typed.
        <MetadataField
          key={`${field}\u0000${plan.metadata[field]}`}
          plan={plan}
          field={field}
          long={long}
          execute={execute}
        />
      ))}
    </fieldset>
  );
}

/**
 * One metadata field. Typing changes nothing in the plan: the value is set
 * when it's committed, on Enter in a line or when focus leaves, as one undo
 * step. A value the export can't write says why, and isn't set.
 */
function MetadataField({
  plan,
  field,
  long,
  execute,
}: {
  readonly plan: VideoPlan;
  readonly field: keyof VideoMetadata;
  readonly long: boolean;
  readonly execute: Execute;
}) {
  const { messages } = useVideoEditor();
  const [draft, setDraft] = useState(plan.metadata[field]);
  const [problem, setProblem] = useState<"too-long" | "not-a-date" | undefined>(undefined);
  const commit = () => {
    const found = metadataProblem(field, draft);
    setProblem(found);
    const command = metadataCommand(plan, field, draft);
    if (command) execute(command);
  };
  const error =
    problem === "too-long"
      ? messages.t("inspector.tooLong")
      : problem === "not-a-date"
        ? messages.t("inspector.notADate")
        : undefined;
  return (
    <Field
      label={messages.t(`inspector.metadataFields.${field}`)}
      description={field === "date" ? messages.t("inspector.dateNote") : undefined}
      error={error}
    >
      {long ? (
        <TextArea rows={3} value={draft} onValueChange={setDraft} onBlur={commit} />
      ) : (
        <TextField
          value={draft}
          autoComplete="off"
          onValueChange={setDraft}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      )}
    </Field>
  );
}
