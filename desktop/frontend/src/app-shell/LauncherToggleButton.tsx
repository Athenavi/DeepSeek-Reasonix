import { ClipboardList } from "lucide-react";
import { Tooltip } from "../components/Tooltip";
import type { Translator } from "../lib/i18n";

// Floating launcher card show/hide toggle, rendered in the topic bar's actions
// row. The pressed state mirrors whether the card is actually on screen; while
// the card cannot show at all (dock expanded or the surface too narrow) the
// button is inert and carries no tooltip.
export function LauncherToggleButton({ visible, renderable, t, onToggle }: {
  visible: boolean;
  renderable: boolean;
  t: Translator;
  onToggle: () => void;
}) {
  return (
    <div className="app__launcher-toggle">
      <Tooltip label={visible ? t("rightDock.hideLauncher") : renderable ? t("rightDock.showLauncher") : ""}>
        <button
          className={[
            "topicbar__chrome-btn",
            "topicbar__chrome-btn--launcher",
            visible ? "topicbar__chrome-btn--active" : "",
          ].filter(Boolean).join(" ")}
          type="button"
          onClick={onToggle}
          aria-label={visible ? t("rightDock.hideLauncher") : t("rightDock.showLauncher")}
          aria-pressed={visible}
        >
          <ClipboardList size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
