// A host whose main thread gets stuck (I02B-C16, test code): it says it is ready, then runs a loop that
// never yields when the first job arrives, so only the backend's own clock can end it. Not the product
// host: handed to the spawner as `hostFile`.
process.on("message", (message: { type?: string }) => {
  if (message.type === "job") {
    for (;;) {
      // the main thread never gets back to its event loop
    }
  }
});
process.send?.({ type: "ready", processType: null, parentKind: "node-ipc" });
// a stuck host must not outlive its test: it leaves when the channel closes (when the loop is not running)
process.on("disconnect", () => process.exit(0));
