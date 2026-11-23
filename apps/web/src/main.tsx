import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient, loadSession } from "./api.ts";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./screens.css";

// Electron takes the session from the preload, browser development from the dev
// server. Nothing else differs between the two (V01-R3).
const session = await loadSession();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App api={createApiClient(session)} />
  </StrictMode>,
);
