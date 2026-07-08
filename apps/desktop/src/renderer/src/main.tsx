import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme } from "./lib/theme";
import "./styles.css";

// Stamp the saved appearance onto the root element before anything renders, so
// a light-mode user never sees a dark flash (and vice versa).
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
