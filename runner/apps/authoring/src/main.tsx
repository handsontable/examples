// Must stay first: initialises error reporting before any other module runs, so a
// throw during module evaluation is still captured.
import { Sentry } from "./sentry.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// A render crash in the editor shell used to leave a blank page and no record of
// why. The boundary keeps the failure visible to the user and reports it.
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
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
