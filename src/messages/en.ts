import { defineMessages, type MessageValue, plural, sdkCoreMessages } from "@hussmartinez/sdk-core";
import type { VideoErrorCode } from "../core/errors/video-error.js";
import type { VideoLimitName } from "../core/errors/video-limits.js";

/**
 * The video SDK's own messages, without sdk-core's. Kept apart so a test can
 * check they don't take any of sdk-core's or ui's keys (sdk-core ADR 0046).
 *
 * @internal
 */
export const videoOwnMessages = /* @__PURE__ */ defineMessages({
  "editor.label": "Video editor",
  "stage.label": "Video preview, frame {frame, number} of {frames, number}",
  "stage.empty": "Add a video to start editing.",
  "stage.unavailable": "The preview isn't available with this engine.",
  "insert.progress": /* @__PURE__ */ plural("count", {
    one: "Adding a video",
    other: "Adding {count, number} videos",
  }),
  "insert.cancel": "Cancel",
  "transport.label": "Playback",
  "transport.play": "Play",
  "transport.pause": "Pause",
  "transport.previousFrame": "Previous frame",
  "transport.nextFrame": "Next frame",
  "transport.time": "{position} of {length}",
  "transport.audioBlocked": "Sound is off: press play to turn it on.",
  "timeline.label": "Timeline",
  "timeline.tools": "Timeline tools",
  "timeline.clips": "Clips",
  "timeline.playhead": "Playhead",
  "timeline.clip": "Clip {index, number} of {count, number}, {start} to {end}",
  "timeline.clipMuted": "Clip {index, number} of {count, number}, {start} to {end}, muted",
  "timeline.trimStart": "Trim the clip's start to the playhead",
  "timeline.trimEnd": "Trim the clip's end to the playhead",
  "timeline.snap": "Snap to clip edges and the playhead",
  "toolbar.label": "Editing tools",
  "toolbar.file": "File",
  "toolbar.history": "History",
  "toolbar.edit": "Edit",
  "toolbar.playback": "Playback",
  "toolbar.view": "View",
  "toolbar.withKeys": "{label} ({keys})",
  "tools.insert": "Add videos",
  "tools.undo": "Undo",
  "tools.redo": "Redo",
  "tools.playPause": "Play or pause",
  "tools.previousFrame": "Previous frame",
  "tools.nextFrame": "Next frame",
  "tools.start": "Go to the start",
  "tools.end": "Go to the end",
  "tools.split": "Split at the playhead",
  "tools.delete": "Delete the selected clips",
  "tools.mute": "Mute the selected clips",
  "tools.zoomIn": "Zoom in",
  "tools.zoomOut": "Zoom out",
  "tools.zoomFit": "Fit the whole video",
  "announce.undone": "Undone",
  "announce.redone": "Redone",
  "errors.INVALID_VIDEO": "This file isn't a valid video, or it's too damaged to open.",
  "errors.UNSUPPORTED_FORMAT":
    "This video format isn't supported. Try converting the file to MP4 or WebM, then open it again.",
  "errors.UNSUPPORTED_CODEC":
    "This browser can't play or save this kind of video. Try another browser, or convert the file to MP4.",
  "errors.DECODE_FAILED":
    "This browser couldn't play part of this video. Try another browser, or convert the file to MP4.",
  "errors.ENCODE_FAILED": "The video couldn't be saved. Please try again.",
  "errors.INVALID_COMMAND": "This edit couldn't be made. Please try again.",
  "errors.INVALID_DOCUMENT": "This project file is damaged or incomplete, so it can't be opened.",
  "errors.BUSY": "A video is already being saved. Wait for it to finish, or cancel it.",
  "errors.FRAME_TOO_LARGE":
    "This video's picture is larger than the editor can handle. Try a smaller version of it.",
  "errors.FRAME_RATE_TOO_HIGH":
    "This video has {actual, number} frames per second, which is more than the limit of {maximum, number}.",
  // The limit, not the length: when the packet walk stops at its cap, it
  // knows only that the video is longer.
  "errors.DURATION_TOO_LONG":
    "This video is longer than the {maximum, duration} the editor can open.",
  "errors.BITRATE_TOO_HIGH":
    "This video holds more data per second than the editor can play. Try a version with a lower quality setting.",
  "errors.PACKET_TOO_LARGE":
    "Part of this video is larger than the editor can read. Try converting the file, then open it again.",
  "errors.TOO_MANY_TRACKS":
    "This file has {actual, number} tracks, which is over the {maximum, number}-track limit.",
  "errors.INDEX_TOO_LARGE":
    "This video's index is larger than the editor can read. Try converting the file, then open it again.",
  "errors.TOO_MANY_CHANNELS":
    "This video's audio has {actual, number} channels, which is over the {maximum, number}-channel limit.",
  "errors.SAMPLE_RATE_TOO_HIGH":
    "This video's audio sample rate is {actual, number} Hz, which is over the {maximum, number} Hz limit.",
  "errors.SESSION_TOO_LARGE":
    "The open videos' previews would use {actual, fileSize} of memory, which is over the {maximum, fileSize} limit. Remove a video, and try again.",
  "errors.TOO_MANY_CLIPS": /* @__PURE__ */ plural("maximum", {
    one: "A video can have {maximum} clip. Join or delete clips, and try again.",
    other: "A video can have up to {maximum, number} clips. Join or delete clips, and try again.",
  }),
  "warnings.maxFramePixels": "This video's picture is large, and may play slowly on some devices.",
  "warnings.maxFrameRate":
    "This video has {actual, number} frames per second, and may play slowly on some devices.",
  "warnings.maxDuration": "This video is long, and may be slow to open and save.",
  "warnings.maxBitrate":
    "This video holds a lot of data per second, and may play slowly on some devices.",
  "warnings.maxPacketSize": "Part of this video is very large, and may be slow to read.",
  "warnings.maxTracks":
    "This file has {actual, number} tracks. Only one video and one audio track are used.",
  "warnings.maxIndexSize": "This video's index is large, and may be slow to open.",
  "warnings.maxChannels":
    "This video's audio has {actual, number} channels, and may be slow to edit.",
  "warnings.maxSampleRate":
    "This video's audio sample rate is {actual, number} Hz, and it may be slow to edit.",
  "warnings.maxSessionSize":
    "The open videos' previews use {actual, fileSize} of memory. Removing videos frees memory.",
  "warnings.maxClips": /* @__PURE__ */ plural("actual", {
    one: "This video has {actual} clip. Many clips may be slow to play and save.",
    other: "This video has {actual, number} clips. Many clips may be slow to play and save.",
  }),
});

/**
 * The video SDK's English message catalogue: sdk-core's messages, and text
 * for every {@link VideoErrorCode} and every limit's warning. Pass it to
 * `createMessages` from `@hussmartinez/sdk-core`, with the host's locale and
 * overrides. It also holds the editor's text; the React editor adds
 * `uiMessages` from `@hussmartinez/ui` to it, for `ui`'s own components.
 *
 * Error text is looked up by code, with the error's `details` as
 * parameters, and never taken from `error.message` (ADR 0019).
 *
 * @example
 * ```ts
 * const messages = createMessages(videoMessages, { locale: "en", overrides: props.messages });
 * messages.error(error); // "This video has 240 frames per second, which is more than the limit of 120."
 * messages.t("warnings.maxSessionSize", { actual: 300e6 });
 * ```
 *
 * @public
 */
export const videoMessages = /* @__PURE__ */ defineMessages({
  ...sdkCoreMessages,
  ...videoOwnMessages,
}) satisfies Record<`errors.${VideoErrorCode}`, MessageValue> &
  Record<`warnings.${VideoLimitName}`, MessageValue>;

/**
 * The type of {@link videoMessages}, for typing a host's overrides with
 * `MessageOverrides<VideoMessageCatalogue>`.
 *
 * @public
 */
export type VideoMessageCatalogue = typeof videoMessages;
