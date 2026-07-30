import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@handsontable/demo-editor-shell";
import { App } from "./App.js";

// ThemeProvider wraps everything: CodeEditor reads the mode from deep inside
// EditorShell, and App has early returns (NotFound / Splash) above its main tree.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
