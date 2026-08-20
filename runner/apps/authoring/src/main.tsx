// Must stay first: initialises error reporting before any other module runs, so a
// throw during module evaluation is still captured.
import { Sentry } from "./sentry.js";
// The code face the design specifies (Figma 48:6719 / 31:6597) — bundled, not a
// CDN link, so the editor never renders a fallback face first. Loaded here, not
// in the shell: editor-shell stays a side-effect-free source package, and the
// `theme.font.mono` stack degrades gracefully anywhere this import is absent.
import "@fontsource/fira-code/400.css";
// The drawer panels' stylesheet (Ask AI transcript/composer, CTA tooltips) —
// classes over inline objects; see panels.css for the rules and their reasons.
import "./panels.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@handsontable/demo-editor-shell";
import { App } from "./App.js";

// A render crash in the editor shell used to leave a blank page and no record of
// why. The boundary keeps the failure visible to the user and reports it. It sits
// outside ThemeProvider so a crash there is caught too; ThemeProvider wraps the
// rest: CodeEditor reads the mode from deep inside EditorShell, and App has early
// returns (NotFound / Splash) above its main tree.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ margin: 0, color: "#555" }}>
            Reload the page. If it keeps happening, the error has been reported.
          </p>
        </div>
      }
    >
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
