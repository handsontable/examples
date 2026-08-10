import { IconMoon, IconSun } from "./icons/index.js";
import { theme } from "./theme.js";
import { useTheme } from "./useTheme.js";

/** Light/dark switch for the whole app. Shows the mode you'd switch *to*. */
export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="hot-icon-btn"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      aria-pressed={mode === "dark"}
      title={`Switch to ${next} theme`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        padding: 0,
        border: "none",
        background: "transparent",
        borderRadius: theme.radius.md,
        color: theme.color.text,
        cursor: "pointer",
      }}
    >
      {mode === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
