// Test-only Electron main (I02B-T03c, I02B-R37, I02B-C25): the local-files flow E2E starts Electron on this
// file in place of the app folder. The folder picker is an OS dialog nobody can answer in a test, so
// `dialog.showOpenDialog` answers with the folder the E2E names (PKI_E2E_PICK_PATH); then the Provider-double
// main (double-main.ts) runs, which runs the shell's own main (src/main.ts) unchanged. Everything after the
// dialog is the product's: the preload's `pickLocation`, the one-time ticket, the backend's approval. No product
// module holds this stand-in, and the bundler refuses everything under e2e/ (T15). Not importable from Node.
import { dialog } from "electron";

const picked = process.env.PKI_E2E_PICK_PATH;
if (!picked) throw new Error("PKI E2E: PKI_E2E_PICK_PATH names the folder the dialog answers with");

(dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({
  canceled: false,
  filePaths: [picked],
});
process.stderr.write("PKI E2E: folder dialog answers with the E2E's folder\n");

await import("./double-main.ts");
