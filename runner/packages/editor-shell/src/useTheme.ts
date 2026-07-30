// Theme mode state. The *source of truth is the DOM attribute* on <html>, which an
// inline script in index.html sets before first paint — React reads it rather than
// re-deriving it, so the two can never disagree and there is no flash on load.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { THEME_ATTR, THEME_STORAGE_KEY, type ThemeMode } from "./theme.js";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

/** An explicit user choice, or `null` while the app should follow the OS. */
function storedChoice(): ThemeMode | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

/** Whatever the pre-paint script decided. Falls back if that script never ran. */
function currentMode(): ThemeMode {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute(THEME_ATTR);
  if (attr === "light" || attr === "dark") return attr;
  return storedChoice() ?? (prefersDark() ? "dark" : "light");
}

export interface ThemeContextValue {
  mode: ThemeMode;
  /** Persists the choice, so the app stops following the OS. */
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
}

/** Mount once, above everything — `CodeEditor` reads the mode from deep inside
 *  `EditorShell`, and the authoring app has early returns above its main tree. */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(currentMode);
  // Whether the user has chosen a mode — tracked here rather than read back out of
  // `localStorage`, because a blocked write must not silently demote the choice to
  // "still following the OS". Seeded from storage so a choice made in an earlier
  // session still counts.
  const chosen = useRef(storedChoice() !== null);

  // Push React's view back onto <html>. A no-op on first render when the
  // pre-paint script already agreed; the write that matters is on toggle.
  useEffect(() => {
    document.documentElement.setAttribute(THEME_ATTR, mode);
  }, [mode]);

  // Follow the OS, but only while the user has made no explicit choice.
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (!chosen.current) setModeState(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    chosen.current = true;
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Non-persistent, but still authoritative for this session — hence the ref.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, setMode, toggle: () => setMode(mode === "dark" ? "light" : "dark") }),
    [mode, setMode],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme() requires a <ThemeProvider> above it in the tree.");
  return ctx;
}
