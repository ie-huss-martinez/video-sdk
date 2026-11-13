import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DeleteIcon,
  DownloadIcon,
  FitIcon,
  IconButton,
  type IconComponent,
  MutedIcon,
  PlayIcon,
  RedoIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SplitIcon,
  ToggleButton,
  Toolbar,
  ToolbarGroup,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { useVideoEditor } from "./context.js";
import { ACCEPT } from "./files.js";
import { useVideoTools } from "./tools.js";

/**
 * Props of {@link VideoToolbar}.
 *
 * @public
 */
export interface VideoToolbarProps {
  readonly className?: string;
}

/** The icons the tools name, from ui's set. */
const ICONS: Readonly<Record<string, IconComponent>> = {
  add: AddIcon,
  undo: UndoIcon,
  redo: RedoIcon,
  split: SplitIcon,
  delete: DeleteIcon,
  download: DownloadIcon,
  muted: MutedIcon,
  play: PlayIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "skip-back": SkipBackIcon,
  "skip-forward": SkipForwardIcon,
  "zoom-in": ZoomInIcon,
  "zoom-out": ZoomOutIcon,
  fit: FitIcon,
};

/** The message key that names each default toolbar group. */
const GROUP_LABELS = {
  file: "toolbar.file",
  history: "toolbar.history",
  edit: "toolbar.edit",
  playback: "toolbar.playback",
  view: "toolbar.view",
} as const;

/**
 * The editor's toolbar (docs/adr/0007): a `ui` Toolbar of the present tools,
 * in the groups the `toolbar` prop sets. Each button has the tool's label,
 * its shortcuts as `aria-keyshortcuts`, and a tooltip with the keys. A tool
 * that can't run now stays in the keyboard order, with `aria-disabled`.
 *
 * @public
 */
export function VideoToolbar(props: VideoToolbarProps): ReactNode {
  const { messages, tools, fileChooser, insertFiles } = useVideoEditor();
  const { flags, run, ariaKeyShortcuts, labelWithKeys } = useVideoTools();
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const chooser = () => picker.current?.click();
    fileChooser.current = chooser;
    return () => {
      if (fileChooser.current === chooser) fileChooser.current = null;
    };
  }, [fileChooser]);

  return (
    <>
      <Toolbar
        className={["hm-video-toolbar", props.className].filter(Boolean).join(" ")}
        label={messages.t("toolbar.label")}
      >
        {tools.toolbar.map((group) => {
          const name = group[0]?.group as keyof typeof GROUP_LABELS | undefined;
          const label = name && GROUP_LABELS[name] ? messages.t(GROUP_LABELS[name]) : undefined;
          return (
            <ToolbarGroup key={group.map((tool) => tool.id).join(" ")} label={label ?? ""}>
              {group.map((tool) => {
                const state = flags.get(tool.id) ?? { enabled: false, active: false };
                const Icon = ICONS[tool.icon] ?? AddIcon;
                const common = {
                  label: messages.t(tool.label as "tools.undo"),
                  icon: <Icon />,
                  title: labelWithKeys(tool.id),
                  "aria-keyshortcuts": ariaKeyShortcuts(tool.id),
                  disabled: !state.enabled,
                  focusableWhenDisabled: true,
                  "data-hm-tool": tool.id,
                };
                return tool.isActive ? (
                  <ToggleButton
                    key={tool.id}
                    {...common}
                    pressed={state.active}
                    onPressedChange={() => run(tool.id)}
                  />
                ) : (
                  <IconButton key={tool.id} {...common} onClick={() => run(tool.id)} />
                );
              })}
            </ToolbarGroup>
          );
        })}
      </Toolbar>
      {/* Outside the toolbar, so it's no toolbar item; the insert tool opens it. */}
      <input
        ref={picker}
        className="hm-video-toolbar-picker"
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) insertFiles(files);
        }}
      />
    </>
  );
}
