import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient, fetchDevSession } from "./api.ts";
import { App } from "./App.tsx";

// Browser development takes the session from the dev server; Electron (T06) will take it
// from the preload instead. Nothing else differs between the two (V01-R3).
const session = await fetchDevSession();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App api={createApiClient(session)} />
  </StrictMode>,
);
