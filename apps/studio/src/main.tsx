import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("wurzel");
if (!container) throw new Error('Das Element #wurzel fehlt in index.html.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
