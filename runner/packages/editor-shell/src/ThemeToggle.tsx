import { theme } from "./theme.js";
import { useTheme } from "./useTheme.js";

// Sun/moon are tabler-icons paths, inlined here because T0 ships before the icon
// system. T1 (DEV-2027 icon layer) centralises these into `src/icons/` — replace
// the two components below with imports from there, don't grow this file.

function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />
    </svg>
  );
}

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
