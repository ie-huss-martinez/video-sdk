import { Button, Dialog, ProgressBar, SegmentedControl, useAnnounce } from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isVideoError } from "../core/errors/video-error.js";
import { planFrames, type VideoMetadata } from "../core/model/plan.js";
import { frameTime } from "../core/model/time.js";
import type { VideoExportContainer, VideoExportQuality } from "../core/ports/video-processor.js";
import { useVideoEditor, useVideoSession } from "./context.js";
import { formatTimecode } from "./timecode.js";

/**
 * What an export produced, for a host's `onExport`.
 *
 * @public
 */
export interface VideoExportResult {
  /** `mp4` or `webm`, as the browser could encode it. */
  readonly container: VideoExportContainer;
  readonly size: number;
}

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
  /** The downloaded file's name, without its extension. Defaults to `video`. */
  readonly fileName?: string;
  readonly className?: string;
}

type Choice = "auto" | VideoExportContainer;

type Phase =
  | { readonly kind: "choose" }
  | { readonly kind: "exporting"; readonly progress: number; readonly large: boolean }
  | { readonly kind: "done"; readonly blob: Blob; readonly container: VideoExportContainer };

const CHOICES: readonly Choice[] = ["auto", "mp4", "webm"];
const QUALITIES: readonly VideoExportQuality[] = ["low", "medium", "high"];
const FIELDS: readonly (keyof VideoMetadata)[] = [
  "title",
  "description",
  "artist",
  "date",
  "comment",
];

const containerOf = (blob: Blob): VideoExportContainer =>
  blob.type.includes("webm") ? "webm" : "mp4";

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
  const { onExport, fileName = "video" } = props;
  const { messages, locale, dialog, setDialog, processor } = useVideoEditor();
  const { snapshot } = useVideoSession();
  const announce = useAnnounce();
  const [choice, setChoice] = useState<Choice>("auto");
  const [quality, setQuality] = useState<VideoExportQuality>("medium");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);

  const plan = snapshot.plan;
  const frames = plan ? planFrames(plan) : 0;
  const open = dialog === "export" && plan !== null && frames > 0;

  // Whatever closes the dialog ends its export and drops its choices and
  // result, so it reopens fresh. The controller is cleared before the
  // abort, so the export's own handlers know it isn't theirs any more.
  useEffect(() => {
    if (open) return;
    const running = controller.current;
    controller.current = null;
    running?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setChoice("auto");
    setQuality("medium");
    setPhase((now) => (now.kind === "choose" ? now : { kind: "choose" }));
    setError(null);
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

  const run = async () => {
    setError(null);
    const running = new AbortController();
    controller.current = running;
    setPhase({ kind: "exporting", progress: 0, large: false });
    try {
      const blob = await processor().export(
        { plan, quality, ...(choice === "auto" ? {} : { container: choice }) },
        {
          signal: running.signal,
          onProgress: (progress) =>
            setPhase((now) => (now.kind === "exporting" ? { ...now, progress } : now)),
          onWarning: (limit) => {
            if (limit !== "maxFileSize") return;
            setPhase((now) => (now.kind === "exporting" ? { ...now, large: true } : now));
          },
        },
      );
      // Closed while it ran: the result belongs to no one.
      if (controller.current !== running) return;
      controller.current = null;
      const container = containerOf(blob);
      const containerName = messages.t(`export.containers.${container}`);
      announce(messages.t("export.ready", { container: containerName, size: blob.size }));
      if (onExport) {
        onExport(blob, { container, size: blob.size });
        close();
        return;
      }
      setPhase({ kind: "done", blob, container });
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
    }
  };

  const stop = () => controller.current?.abort();

  const download = () => {
    if (phase.kind !== "done") return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(phase.blob);
    const link = document.createElement("a");
    link.href = objectUrl.current;
    link.download = `${fileName}.${phase.container}`;
    link.click();
  };

  const { output } = plan;
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
    output.frameRate.num / output.frameRate.den,
  );
  const kept = FIELDS.filter((field) => plan.metadata[field] !== "");
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
        <Button variant="primary" onClick={() => void run()}>
          {messages.t("export.confirm")}
        </Button>
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
        <p className="hm-video-export-result">
          {messages.t("export.ready", {
            container: messages.t(`export.containers.${phase.container}`),
            size: phase.blob.size,
          })}
        </p>
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
              {messages.t("export.audio", {
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
          </section>
          <fieldset className="hm-video-export-choices" disabled={exporting}>
            <SegmentedControl
              label={messages.t("export.container")}
              size="small"
              value={choice}
              options={CHOICES.map((value) => ({
                value,
                label: messages.t(`export.containers.${value}`),
              }))}
              onValueChange={setChoice}
            />
            <SegmentedControl
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
                : messages.error(error)}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
