import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { DisplayIdentifier, parseIdentify } from "./components/DisplayIdentifier";

// The identify overlay windows load this same page with ?identify=...
const identify = parseIdentify(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  identify ? (
    <DisplayIdentifier {...identify} />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
