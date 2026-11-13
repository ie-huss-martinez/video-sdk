import { Button, FileDropZone, ProgressBar } from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createVideoOutput } from "../adapters/video-output.js";
import { videoLimits } from "../core/errors/video-limits.js";
import { planFrames } from "../core/model/plan.js";
import { useVideoEditor, useVideoOutput, useVideoPlayhead, useVideoSession } from "./context.js";

/**
 * Props of {@link VideoStage}.
 *
 * @public
 */
export interface VideoStageProps {
  readonly className?: string;
}

/** The containers the drop zone and file picker accept. */
const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv";

/**
 * The preview (docs/adr/0007): the canvas the output draws into, letterboxed
 * in the stage, or the drop zone while the plan is empty.
 *
 * The canvas is created in an effect, never rendered by React: a canvas
 * transferred to a worker can't be transferred again, and StrictMode mounts
 * effects twice, so each mount gets a fresh canvas and output, and its
 * cleanup destroys both. Its backing size follows the stage and the device
 * pixel ratio.
 *
 * @public
 */
export function VideoStage(props: VideoStageProps): ReactNode {
  const { engine, messages, filePolicy, setOutput } = useVideoEditor();
  const { session, snapshot } = useVideoSession();
  const { output, snapshot: playback } = useVideoOutput();
  const frame = useVideoPlayhead();
  const frames = snapshot.plan ? planFrames(snapshot.plan) : 0;
  const surface = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const inserting = useRef<AbortController | null>(null);

  useEffect(() => {
    const container = surface.current;
    if (!container) return;
    const canvas = document.createElement("canvas");
    canvas.className = "hm-video-stage-canvas";
    canvas.setAttribute("role", "img");
    const { width, height } = container.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    container.append(canvas);
    let created: ReturnType<typeof createVideoOutput>;
    try {
      created = createVideoOutput({
        engine,
        canvas,
        filePolicy: videoLimits.resolve(filePolicy),
      });
    } catch {
      // Another engine, or a browser that can't draw in workers.
      canvas.remove();
      setUnavailable(true);
      return;
    }
    canvasRef.current = canvas;
    setOutput(created);

    const resize = () => {
      const box = container.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        created.resize(box.width, box.height, window.devicePixelRatio || 1);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    // A change of device pixel ratio, such as a move to another screen, resizes too.
    let ratio: MediaQueryList | undefined;
    const watchRatio = () => {
      ratio?.removeEventListener("change", onRatio);
      ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      ratio.addEventListener("change", onRatio);
    };
    const onRatio = () => {
      resize();
      watchRatio();
    };
    watchRatio();

    return () => {
      observer.disconnect();
      ratio?.removeEventListener("change", onRatio);
      setOutput(null);
      canvasRef.current = null;
      void created.destroy();
      canvas.remove();
    };
  }, [engine, filePolicy, setOutput]);

  useEffect(() => {
    if (output && snapshot.plan) output.load(snapshot.plan);
  }, [output, snapshot.plan]);

  // Named while paused, not every frame while playing: the time display is the live text.
  const paused = playback?.state !== "playing";
  useEffect(() => {
    if (!paused || !canvasRef.current) return;
    canvasRef.current.setAttribute(
      "aria-label",
      messages.t("stage.label", { frame: Math.min(frame + 1, frames), frames }),
    );
  }, [paused, frame, frames, messages]);

  const insert = (files: readonly File[]) => {
    const controller = new AbortController();
    inserting.current = controller;
    void (async () => {
      for (const file of files) {
        if (controller.signal.aborted) return;
        // A failure is in the session's snapshot, which the stage shows.
        await session.insert(file, { signal: controller.signal }).catch(() => {});
      }
    })();
  };

  const empty = snapshot.plan === null || frames === 0;
  return (
    <div className={["hm-video-stage", props.className].filter(Boolean).join(" ")}>
      <div className="hm-video-stage-surface" ref={surface} data-hm-empty={empty || undefined} />
      {unavailable ? (
        <p className="hm-video-stage-note">{messages.t("stage.unavailable")}</p>
      ) : null}
      {empty && snapshot.inserting === 0 ? (
        <FileDropZone
          className="hm-video-stage-drop"
          accept={ACCEPT}
          multiple
          onFiles={insert}
          hint={messages.t("stage.empty")}
        />
      ) : null}
      {snapshot.inserting > 0 ? (
        <div className="hm-video-stage-progress">
          <ProgressBar label={messages.t("insert.progress", { count: snapshot.inserting })} />
          <Button onClick={() => inserting.current?.abort()}>{messages.t("insert.cancel")}</Button>
        </div>
      ) : null}
      {snapshot.error ? (
        <p className="hm-video-stage-error" role="alert">
          {messages.error(snapshot.error)}
        </p>
      ) : null}
    </div>
  );
}
