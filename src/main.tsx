import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import { initTauriBridge } from "./preview/events";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

initTauriBridge().catch((err) => {
  window.dispatchEvent(new CustomEvent("rsmd:banner", { detail: String(err) }));
});
