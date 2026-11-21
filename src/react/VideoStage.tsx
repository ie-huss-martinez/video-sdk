import { Button, FileDropZone, ProgressBar } from "@hussmartinez/ui/react";
import {
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { canCreateVideoOutput, createVideoOutput } from "../adapters/video-output.js";
import { videoLimits } from "../core/errors/video-limits.js";
import { planFrames } from "../core/model/plan.js";
import { useVideoEditor, useVideoOutput, useVideoPlayhead, useVideoSession } from "./context.js";
import { ElementListenersContext } from "./element/listeners.js";
import { ACCEPT } from "./files.js";
import { StageNotices } from "./StageNotices.js";

/**
 * Props of {@link VideoStage}.
 *
 * @public
 */
export interface VideoStageProps {
  readonly className?: string;
}

/** What a browser's capabilities change through: nothing, while a page lives. */
const subscribeToNothing = () => () => {};

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
  const {
    engine,
    messages,
    filePolicy,
    setOutput,
    insertFiles,
    cancelInsert,
    preview,
    setPreview,
  } = useVideoEditor();
  const { snapshot } = useVideoSession();
  const { output, snapshot: playback } = useVideoOutput();
  const frame = useVideoPlayhead();
  const frames = snapshot.plan ? planFrames(snapshot.plan) : 0;
  const surface = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Another engine, or a browser that can't draw in workers: known from the
  // engine and the browser, never from a failed attempt. Available on the
  // server, which renders no canvas, so hydration matches.
  const unsupported = useSyncExternalStore(
    subscribeToNothing,
    () => !canCreateVideoOutput(engine),
    () => false,
  );
  // Or the output failed for a reason that check can't foresee, such as a
  // worker that wouldn't start: the same notice, never a thrown effect.
  const [failed, setFailed] = useState(false);
  const unavailable = unsupported || failed;
  // No output will come, as with a host's own engine: the element's play()
  // stops waiting for one (docs/adr/0007).
  const { onPreviewSettled } = useContext(ElementListenersContext);
  useEffect(() => {
    if (unavailable) onPreviewSettled?.();
  }, [unavailable, onPreviewSettled]);

  useEffect(() => {
    const container = surface.current;
    // Checked here too, not taken from the render: hydration commits the
    // server's answer first.
    if (!container || !canCreateVideoOutput(engine)) return;
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
      canvas.remove();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- an external call failed; nothing to derive during render
      setFailed(true);
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

  // The session's plan, or a gesture's preview of it while one is under way
  // (docs/adr/0007). A plan that differs only in sound keeps the picture
  // playing (docs/adr/0006).
  const shown = preview ?? snapshot.plan;
  useEffect(() => {
    if (output && shown) output.load(shown);
  }, [output, shown]);
  // Every edit ends a preview: it was of the plan before.
  // The plan is the trigger, not an input.
  useEffect(() => setPreview(null), [snapshot.plan, setPreview]);

  // Named while paused, not every frame while playing: the time display is the live text.
  const paused = playback?.state !== "playing";
  useEffect(() => {
    if (!paused || !canvasRef.current) return;
    canvasRef.current.setAttribute(
      "aria-label",
      messages.t("stage.label", { frame: Math.min(frame + 1, frames), frames }),
    );
  }, [paused, frame, frames, messages]);

  const empty = snapshot.plan === null || frames === 0;
  const error = snapshot.error ? (
    <p className="hm-video-stage-error" role="alert">
      {messages.error(snapshot.error)}
    </p>
  ) : null;
  // A playback failure, such as a decoder that stopped: playback pauses, and
  // without this the stage would stay as it was, with nothing to say why.
  // Playing again clears it.
  const playbackError = playback?.error ? (
    <p className="hm-video-stage-error" role="alert">
      {messages.error(playback.error)}
    </p>
  ) : null;
  return (
    // Focusable by a click, not by Tab: after a click on the preview, focus is
    // in the editor on no control, so Space plays and the arrows step.
    <div className={["hm-video-stage", props.className].filter(Boolean).join(" ")} tabIndex={-1}>
      <div className="hm-video-stage-surface" ref={surface} data-hm-empty={empty || undefined} />
      {unavailable ? (
        <p className="hm-video-stage-note">{messages.t("stage.unavailable")}</p>
      ) : null}
      {empty && snapshot.inserting === 0 ? (
        <FileDropZone
          className="hm-video-stage-drop"
          accept={ACCEPT}
          multiple
          onFiles={insertFiles}
          hint={messages.t("stage.empty")}
        >
          {/* With no clip, a failure sits in the drop zone, by the button that retries. */}
          {error}
        </FileDropZone>
      ) : null}
      {snapshot.inserting > 0 ? (
        <div className="hm-video-stage-progress">
          <ProgressBar label={messages.t("insert.progress", { count: snapshot.inserting })} />
          <Button onClick={cancelInsert}>{messages.t("insert.cancel")}</Button>
        </div>
      ) : null}
      {/* Over the clips, the warnings and failures are banners at the foot of the stage.
          The notices stay mounted while the stage is empty, as after undoing the only
          insert, so what was dismissed or announced is remembered when a redo brings
          the clips back. */}
      <div className="hm-video-stage-foot">
        <StageNotices hidden={empty && snapshot.inserting === 0} />
        {empty && snapshot.inserting === 0 ? null : error}
        {empty ? null : playbackError}
      </div>
    </div>
  );
}
