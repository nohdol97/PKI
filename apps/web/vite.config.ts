import { defineConfig } from "vite";
import { webConfig } from "./dev/dev-server.ts";

// `pnpm --filter @pki/web dev`: the screens at http://127.0.0.1:5173 on the dev backend.
export default defineConfig(webConfig());
