import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import { initTauriBridge } from "./preview/events";
import { useShellStore } from "./store";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

initTauriBridge().catch((err) => {
  useShellStore.getState().setError(String(err));
});
