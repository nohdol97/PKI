// Sandboxed preload (V01-R4): exposes window.pki with exactly the bridge functions.
// Sandboxed preloads can require only "electron", so the channel names are a copy of
// bridge.ts (preload.test.ts keeps them equal). Arguments pass through unchanged;
// the main process checks sender and schema (bridge.ts).
"use strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a sandboxed preload is CommonJS
const { contextBridge, ipcRenderer } = require("electron");

/** @param {string} channel */
const call =
  (channel) =>
  /** @param {unknown[]} args */
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("pki", {
  getSession: call("pki:get-session"),
  setSecret: call("pki:set-secret"),
  hasSecret: call("pki:has-secret"),
  deleteSecret: call("pki:delete-secret"),
  openExternal: call("pki:open-external"),
  pickLocation: call("pki:pick-location"),
});
