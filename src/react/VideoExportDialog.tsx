import { Button, Dialog, ProgressBar, SegmentedControl, useAnnounce } from "@hussmartinez/ui/react";
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import { asVideoError } from "../core/errors/error-helpers.js";
import { isVideoError } from "../core/errors/video-error.js";
import { metadataDate } from "../core/model/metadata-date.js";
import { planFrames, type VideoMetadata } from "../core/model/plan.js";
import { frameTime } from "../core/model/time.js";
import type {
  VideoExportContainer,
  VideoExportQuality,
  VideoExportResult,
} from "../core/ports/video-processor.js";
import { exportFileName } from "../features/export-name/export-name.js";
import { useVideoEditor, useVideoSession } from "./context.js";
import { ElementListenersContext } from "./element/listeners.js";
import { formatTimecode } from "./timecode.js";

/**
 * Props of {@link VideoExportDialog}.
 *
 * @public
 */
export interface VideoExportDialogProps {
  /**
   * Takes the exported file instead of the dialog's download button: the
   * dialog closes once it's called.
   */
  readonly onExport?: (blob: Blob, result: VideoExportResult) => void;
  /**
   * The downloaded file's name, without its extension, such as `"Holiday"`.
   * Without it, the video's title is used, or else `video`. It's cleaned as
   * the family cleans a file name (pdf-sdk ADR 0009): the last path segment,
   * without control or bidirectional formatting characters or characters
   * Windows refuses, and at most 128 characters. Then a video extension is
   * dropped, as the export adds its own.
   */
  readonly fileName?: string;
  readonly className?: string;
}

type Choice = "auto" | VideoExportContainer;

type Phase =
  | { readonly kind: "choose" }
  | { readonly kind: "exporting"; readonly progress: number; readonly large: boolean }
  | { readonly kind: "done"; readonly result: VideoExportResult };

const CHOICES: readonly Choice[] = ["auto", "mp4", "webm"];
const QUALITIES: readonly VideoExportQuality[] = ["low", "medium", "high"];
const FIELDS: readonly (keyof VideoMetadata)[] = [
  "title",
  "description",
  "artist",
  "date",
  "comment",
];

/**
 * The export dialog (docs/adr/0007). Export is irreversible, so it shows a
 * summary first: the picture, the frame rate and length, the audio, and
 * that nothing from the source files is copied, only the metadata the plan
 * sets. Then a progress bar that can stop the export, and a download
 * button, which gets focus, with the file's size, and an announcement.
 *
 * It opens with the export tool. Whatever closes it, such as Escape, Done,
 * or the plan emptying, stops its export and resets it, so it reopens
 * fresh; a result that arrives after that is dropped. Unmounting stops the
 * export too.
 *
 * @public
 */
export function VideoExportDialog(props: VideoExportDialogProps): ReactNode {
  const { onExport, fileName } = props;
  const { messages, locale, dialog, setDialog, reportEvent } = useVideoEditor();
  const { session, snapshot } = useVideoSession();
  const announce = useAnnounce();
  const [choice, setChoice] = useState<Choice>("auto");
  const [quality, setQuality] = useState<VideoExportQuality>("medium");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  /** Whether the export leaves the sound out, as the user chose after the browser couldn't encode it. */
  const [withoutSound, setWithoutSound] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const listeners = useContext(ElementListenersContext);
  const objectUrl = useRef<string | null>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);
  const ids = useId();

  const plan = snapshot.plan;
  const frames = plan ? planFrames(plan) : 0;
  const open = dialog === "export" && plan !== null && frames > 0;

  // Reset as it renders when it opens or closes, React's pattern for state
  // that resets when a value changes. Closing drops the result, which holds
  // the exported file, so a closed dialog keeps no video in memory; a result
  // that arrives after that finds the phase isn't "exporting" any more, and
  // is dropped. Opening starts fresh, with the choices back to their defaults.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setPhase({ kind: "choose" });
    setError(null);
    if (open) {
      setChoice("auto");
      setQuality("medium");
      setWithoutSound(false);
    }
  }

  // Whatever closes the dialog ends its export and frees a download's URL.
  // The controller is cleared before the abort, so the export's own handlers
  // know it isn't theirs any more.
  useEffect(() => {
    if (open) return;
    const running = controller.current;
    controller.current = null;
    running?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    // The plan emptied under an open dialog: close it for good.
    if (dialog === "export") setDialog(null);
  }, [open, dialog, setDialog]);

  // Unmounting ends an export too, and frees a download's URL.
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const done = phase.kind === "done";
  useEffect(() => {
    if (done) downloadButton.current?.focus();
  }, [done]);

  if (!plan) return null;

  const close = () => setDialog(null);

  /** Whether the browser couldn't encode the plan's sound, which an export without it can avoid. */
  const noSoundEncoder =
    isVideoError(error, "UNSUPPORTED_CODEC") &&
    (error.details as { readonly track?: unknown } | undefined)?.track === "audio";

  const run = async (audio: "include" | "omit" = withoutSound ? "omit" : "include") => {
    setError(null);
    setWithoutSound(audio === "omit");
    const running = new AbortController();
    controller.current = running;
    setPhase({ kind: "exporting", progress: 0, large: false });
    try {
      // The session exports with the editor's processor (ADR 0005).
      const result = await session.export({
        quality,
        ...(choice === "auto" ? {} : { container: choice }),
        ...(audio === "omit" ? { audio } : {}),
        signal: running.signal,
        onProgress: (progress) =>
          setPhase((now) => (now.kind === "exporting" ? { ...now, progress } : now)),
        onWarning: (limit) => {
          if (limit !== "maxFileSize") return;
          setPhase((now) => (now.kind === "exporting" ? { ...now, large: true } : now));
        },
      });
      // Closed while it ran: the result belongs to no one.
      if (controller.current !== running) return;
      controller.current = null;
      // The element's `export` event: what was written, never the file.
      listeners.onExport?.({
        container: result.container,
        size: result.size,
        peakDb: result.peakDb,
        clippedFrames: result.clippedFrames,
      });
      const containerName = messages.t(`export.containers.${result.container}`);
      announce(messages.t("export.ready", { container: containerName, size: result.size }));
      if (onExport) {
        onExport(result.blob, result);
        close();
        return;
      }
      // Only over this export's progress: closing reset the phase.
      setPhase((now) => (now.kind === "exporting" ? { kind: "done", result } : now));
    } catch (reason) {
      // Closed while it ran: the reset dialog shows nothing of it.
      if (controller.current !== running) return;
      controller.current = null;
      setPhase({ kind: "choose" });
      if (isVideoError(reason, "ABORTED")) {
        announce(messages.t("export.cancelled"));
        return;
      }
      setError(reason);
      // The element's `error` event: an export's failure never reaches the
      // session's snapshot, so the dialog, which shows it, reports it.
      const failure = asVideoError(reason);
      listeners.onError?.({ code: failure.code, details: { ...(failure.details ?? {}) } });
    }
  };

  const stop = () => controller.current?.abort();

  const download = () => {
    if (phase.kind !== "done") return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(phase.result.blob);
    const link = document.createElement("a");
    link.href = objectUrl.current;
    link.download = `${exportFileName(fileName, snapshot.plan?.metadata.title ?? "")}.${phase.result.container}`;
    link.click();
    // The file is the browser's now: the usage event says so, after export's.
    reportEvent({ type: "download", outcome: "done", commands: [] });
  };

  const { output } = plan;
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
    output.frameRate.num / output.frameRate.den,
  );
  // The date is written only as a real calendar date (ADR 0005): one that
  // isn't is left out, and the summary says so before anything is written.
  const unwrittenDate = plan.metadata.date !== "" && !metadataDate(plan.metadata.date);
  const kept = FIELDS.filter(
    (field) => plan.metadata[field] !== "" && !(field === "date" && unwrittenDate),
  );
  const exporting = phase.kind === "exporting";

  const footer =
    phase.kind === "done" ? (
      <>
        <Button variant="secondary" onClick={close}>
          {messages.t("export.done")}
        </Button>
        <Button ref={downloadButton} variant="primary" onClick={download}>
          {messages.t("export.download")}
        </Button>
      </>
    ) : exporting ? (
      <Button variant="secondary" onClick={stop}>
        {messages.t("export.stop")}
      </Button>
    ) : (
      <>
        <Button variant="secondary" onClick={close}>
          {messages.t("export.cancel")}
        </Button>
        {/* Sound the browser can't encode: an export without it, said plainly, never silently. */}
        {noSoundEncoder ? (
          <Button variant="primary" onClick={() => void run("omit")}>
            {messages.t("export.withoutSound")}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void run()}>
            {messages.t("export.confirm")}
          </Button>
        )}
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={messages.t("export.title")}
      description={messages.t("export.description")}
      footer={footer}
      className={["hm-video-export", props.className].filter(Boolean).join(" ")}
    >
      {phase.kind === "done" ? (
        <>
          <p className="hm-video-export-result">
            {messages.t("export.ready", {
              container: messages.t(`export.containers.${phase.result.container}`),
              size: phase.result.size,
            })}
          </p>
          {/* The sound was clamped: say by how much, and what to do about it. */}
          {phase.result.clippedFrames > 0 ? (
            <p className="hm-video-export-note" role="status">
              {messages.t("export.clipped", {
                db: Math.round(phase.result.peakDb * 10) / 10,
              })}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <section className="hm-video-export-summary" aria-label={messages.t("export.summary")}>
            <p>
              {messages.t("export.picture", {
                width: output.width,
                height: output.height,
                rate,
                length: formatTimecode(frameTime(frames, output.frameRate), locale),
              })}
            </p>
            <p>
              {withoutSound
                ? messages.t("export.noSound")
                : messages.t("export.audio", {
                    channels: output.channels,
                    sampleRate: output.sampleRate,
                  })}
            </p>
            <p>{messages.t("export.private")}</p>
            {kept.length > 0 ? (
              <p>
                {messages.t("export.kept", {
                  fields: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                    kept.map((field) => messages.t(`export.field.${field}`)),
                  ),
                })}
              </p>
            ) : null}
            {unwrittenDate ? <p>{messages.t("export.dateNotWritten")}</p> : null}
          </section>
          <fieldset className="hm-video-export-choices" disabled={exporting}>
            {/* A visible name for each group, which names it too (WCAG 2.5.3). */}
            <span className="hm-video-export-label" id={`${ids}-container`}>
              {messages.t("export.container")}
            </span>
            <SegmentedControl
              aria-labelledby={`${ids}-container`}
              label={messages.t("export.container")}
              size="small"
              value={choice}
              options={CHOICES.map((value) => ({
                value,
                label: messages.t(`export.containers.${value}`),
              }))}
              onValueChange={setChoice}
            />
            <span className="hm-video-export-label" id={`${ids}-quality`}>
              {messages.t("export.quality")}
            </span>
            <SegmentedControl
              aria-labelledby={`${ids}-quality`}
              label={messages.t("export.quality")}
              size="small"
              value={quality}
              options={QUALITIES.map((value) => ({
                value,
                label: messages.t(`export.qualities.${value}`),
              }))}
              onValueChange={setQuality}
            />
          </fieldset>
          {phase.kind === "exporting" ? (
            <>
              <ProgressBar
                label={messages.t("export.progress")}
                value={Math.round(phase.progress * 100)}
                max={100}
              />
              {phase.large ? (
                <p className="hm-video-export-note" role="status">
                  {messages.t("export.largeFile")}
                </p>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p className="hm-video-export-error" role="alert">
              {/* A TypeError: no processor, as with a host's engine and none of its own. */}
              {error instanceof TypeError
                ? messages.t("export.unavailable")
                : noSoundEncoder
                  ? messages.t("export.noSoundEncoder")
                  : messages.error(error)}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
