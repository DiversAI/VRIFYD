/**
 * Workflow service entry point.
 *
 * Auto-discovers workflows from `src/workflows/`, importing each so its
 * top-level `task()` calls (the root workflow task + one per shared agent)
 * register with the Render SDK. No web server, no store — just task registration.
 *
 * The SDK auto-starts its task server on the *first* `task()` call (via
 * `setImmediate`). Because `loadWorkflows` imports the workflow folders with
 * sequential `await import()`, that auto-start fires in the gap between the first
 * folder and the rest — so any workflow discovered after the first (e.g.
 * `your-review`) would register *after* the server started and be silently
 * dropped ("Task Not found" at dispatch time). We disable the auto-start, finish
 * discovery so every task is registered, then start the server once.
 */
import { startTaskServer } from "@renderinc/sdk/workflows";
import { loadWorkflows } from "./workflows/loader.js";

// Must be set before any `task()` runs (i.e. before loadWorkflows imports the
// workflow modules) so the SDK doesn't schedule its own early auto-start.
process.env.RENDER_SDK_AUTO_START = "false";

await loadWorkflows(new URL("./workflows", import.meta.url).pathname);

// Under `render workflows dev` the socket path is set; start the task server now
// that every discovered workflow has registered. Outside that harness (no
// socket) there is nothing to serve.
if (process.env.RENDER_SDK_SOCKET_PATH) {
  await startTaskServer();
}
