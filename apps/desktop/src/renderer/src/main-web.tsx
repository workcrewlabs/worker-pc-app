import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme } from "./lib/theme";
import { createWebBridge } from "./lib/web-bridge";
import "./styles.css";

// The browser entry point. Instead of the Electron preload injecting the
// bridge, the web bridge (REST against the backend) is installed here, and the
// exact same App renders. Desktop-only features throw DesktopOnlyError, which
// the UI turns into a "download the app" prompt.
window.workcrew = createWebBridge();

applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
