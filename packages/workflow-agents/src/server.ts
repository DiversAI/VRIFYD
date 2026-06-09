/**
 * Pattern 3 — gateway (web service).
 *
 * A Hono server that turns inbound PR submissions / GitHub webhooks into Render
 * Workflow runs, and serves the shared telemetry viewer.
 *
 * In local dev there are two modes:
 *   - `RENDER_USE_LOCAL_DEV=true` (no URL) → in-process function calls (fast; host `npm run dev`)
 *   - `RENDER_LOCAL_DEV_URL` set → SDK dispatches to the Render CLI dev server (Docker / `dev:workflows`)
 * In production the Render SDK dispatches real Workflow task runs on separate instances.
 * @workshop/db so the viewer shows the same reviews table as Patterns 1 & 2.
 */
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { addFinding, createReview, migrate, setReviewResult } from "@workshop/db";
import { createUiRouter } from "@workshop/ui";
import { loadWorkflows } from "./workflows/loader.js";
import { matchPullRequest, verifyGithubSignature } from "./github.js";

/** What the code-review workflow returns (see workflows/code-review). */
interface CodeReviewResult {
  verdict?: string;
  reason?: string;
  reviews?: Array<{ agent: string; note: string }>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Build the gateway app. Exported so tests can drive it via `app.fetch`. */
export async function createApp(): Promise<Hono> {
  const isLocalDev = process.env.RENDER_USE_LOCAL_DEV === "true";
  const localDevUrl = process.env.RENDER_LOCAL_DEV_URL?.trim();
  const useInProcess = isLocalDev && !localDevUrl;
  const { mapping, localTasks } = await loadWorkflows(
    new URL("./workflows", import.meta.url).pathname,
  );

  /**
   * Run a workflow to completion and return its result.
   *   - in-process: direct function call (host npm run dev, tests)
   *   - local dev server: SDK → Render CLI task server on RENDER_LOCAL_DEV_URL
   *   - production: SDK → Render Workflows API
   */
  async function runWorkflow(name: string, input: unknown): Promise<unknown> {
    if (useInProcess) {
      const fn = localTasks[name];
      if (!fn) throw new Error(`no local task for workflow "${name}"`);
      return fn(input);
    }
    const slug = mapping[name];
    if (!slug) throw new Error(`unknown workflow "${name}"`);
    const { Render } = await import("@renderinc/sdk");
    const render = new Render({
      token: process.env.RENDER_API_KEY || "local-dev",
      useLocalDev: isLocalDev || Boolean(localDevUrl),
      ...(localDevUrl ? { localDevUrl } : {}),
    });
    const started = await render.workflows.startTask(slug, [input]);
    const finished = await started.get();
    const ok = finished.status === "succeeded" || finished.status === "completed";
    if (!ok) throw new Error(finished.error ? String(finished.error) : "workflow failed");
    // The SDK returns the task's return value wrapped in a results array (one
    // entry per invocation). Unwrap the single result so callers see the same
    // shape the in-process path returns directly.
    const results = finished.results;
    return Array.isArray(results) ? results[0] : results;
  }

  /**
   * Start a review: create the review row immediately (so the viewer shows it as
   * running), then run the named workflow in the background and persist the
   * outcome. Defaults to `code-review`, but any auto-discovered workflow (e.g. an
   * attendee's `your-review`) can be dispatched the same way.
   */
  async function runReviewWorkflow(
    prUrl: string,
    labels: string[] = [],
    workflowName = "code-review",
  ): Promise<string> {
    const reviewId = await createReview(prUrl, {
      source: "workflow-agents",
      workflow: workflowName,
    });
    void (async () => {
      try {
        const result = (await runWorkflow(workflowName, {
          url: prUrl,
          labels,
          _runId: reviewId,
        })) as CodeReviewResult & Record<string, unknown>;

        for (const f of result.reviews ?? []) await addFinding(reviewId, f.agent, f.note);

        // Persist the judge's decision as its own finding so it shows up next to
        // the specialist reviewers in the viewer (otherwise it only lives in the
        // review summary + the judge span's output).
        if (result.reason || result.verdict) {
          await addFinding(reviewId, "judge", result.reason ?? result.verdict ?? "");
        }

        // Workflows that don't return a verdict (e.g. an authored your-review)
        // still get their raw output surfaced as the reason so the viewer shows
        // something useful rather than an empty row.
        const isReviewSummary =
          result.verdict != null || result.reason != null || result.reviews != null;
        const reason =
          result.reason ?? (isReviewSummary ? undefined : JSON.stringify(result, null, 2));

        await setReviewResult(reviewId, {
          status: "done",
          ...(result.verdict ? { verdict: result.verdict } : {}),
          ...(reason ? { reason } : {}),
          ...(result.usage
            ? {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              }
            : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[workflow-agents] review ${reviewId} failed:`, message);
        await setReviewResult(reviewId, { status: "error", reason: message }).catch(() => {});
      }
    })();
    return reviewId;
  }

  const app = new Hono();

  // API-key auth for the review + webhook write paths. Open when WORKFLOW_API_KEY
  // is unset. (Reads — the viewer and its APIs — are always open.)
  const apiKey = process.env.WORKFLOW_API_KEY;
  if (apiKey) {
    const expected = `Bearer ${apiKey}`;
    app.use("/webhooks/*", async (c, next) => {
      if (c.req.header("authorization") === expected) return next();
      return c.json({ error: "unauthorized" }, 401);
    });
    app.use("/api/reviews", async (c, next) => {
      if (c.req.method !== "POST") return next();
      if (c.req.header("authorization") === expected) return next();
      return c.json({ error: "unauthorized" }, 401);
    });
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  // The workflows available to dispatch. The viewer uses this to offer a picker
  // when more than one exists (code-review plus any authored your-review).
  app.get("/api/workflows", (c) => c.json(Object.keys(mapping)));

  // Trigger a review (same shape as Patterns 1 & 2). `workflow` is optional and
  // defaults to code-review; any auto-discovered workflow can be named instead,
  // so an attendee's your-review is reachable straight from the UI.
  app.post("/api/reviews", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prUrl?: string; workflow?: string };
    if (!body.prUrl) return c.json({ error: "prUrl is required" }, 400);
    const workflowName = body.workflow ?? "code-review";
    if (!mapping[workflowName]) {
      return c.json({ error: `workflow "${workflowName}" not available` }, 503);
    }
    const reviewId = await runReviewWorkflow(body.prUrl, [], workflowName);
    return c.json({ id: reviewId }, 202);
  });

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    if (!verifyGithubSignature(rawBody, c.req.header())) {
      return c.json({ error: "signature verification failed" }, 401);
    }
    let event: unknown;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const matched = matchPullRequest(event, c.req.header());
    if (!matched) return c.json({ ignored: true }, 202);
    const reviewId = await runReviewWorkflow(matched.url, matched.labels);
    return c.json({ runId: reviewId, status: "running" }, 202);
  });

  // The same telemetry viewer as Patterns 1 & 2 (reviews + findings + spans).
  // Deep per-agent traces live in the Render Dashboard.
  app.route("/", createUiRouter("Pattern 3 — Workflow agents"));

  const dispatchMode = useInProcess
    ? "in-process"
    : localDevUrl
      ? `local-dev-server (${localDevUrl})`
      : "render";
  console.info(
    `[workflow-agents] workflows: ${Object.keys(mapping).join(", ")} (dispatch: ${dispatchMode})`,
  );
  return app;
}

// Run as a server only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  await migrate();
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.info(`[workflow-agents] listening on http://localhost:${info.port}`);
  });
}
