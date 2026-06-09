# Facilitator Guide — Render Agents Workshop

Everything you need to teach this workshop, even if you didn't build it. Read this
once end-to-end before you run it the first time, then keep the **Run sheet** and
**Solutions** sections open on a second screen while you present.

The companion learner-facing material is in [`../docs`](../docs) (`00`–`05`). This
guide is the teaching layer *on top* of those docs: objectives, timing, talk
tracks, demos, the "aha" moments, common failure modes, and the worked solutions.

---

## 1. What this workshop is

One sentence: **the agent never changes. The substrate does all the work.**

Learners deploy a single agentic code-review pipeline three ways on Render and
*feel* the trade-offs:

| # | Pattern | Substrate | The lesson |
| --- | --- | --- | --- |
| 1 | `naive-agent` | In-process, inside the web request | Simplest possible thing — and exactly where it breaks |
| 2 | `worker-agents` | Producer + background worker over a Valkey queue | Durability is real, but **you** hand-roll the coordination |
| 3 | `workflow-agents` | Each agent is a Render `task()` | The same guarantees become a config object |

The pipeline (`prepareDiff → filterDiff → [security ‖ performance ‖ ux?] → judge`)
lives in the shared [`@workshop/agent`](../shared/agent) package and is **byte-for-byte
identical** across all three. That invariance *is* the curriculum: every time a
learner says "but didn't we have to rewrite the agent?" the answer is no. Go look.

### Learning objectives

By the end, a learner can:

1. Explain the failure modes of running agent work inside an HTTP request.
2. Describe what a queue + worker buys you (durability, scale-out, retries) and
   what it *costs* you (acks, consumer groups, pub/sub — code you own and debug).
3. Hand-write at-least-once delivery semantics (ack on success, retry on failure).
4. Author and ship a Render Workflow `task()` — a plain async function + a config
   object — and get retries, isolation, timeouts, and traces for free.
5. Compose agents as tasks and fan them out, and articulate *why* the same
   guarantees took a whole queue in Pattern 2 and a config object in Pattern 3.

### Who it's for

Backend / full-stack engineers comfortable with TypeScript and async/await.
No prior Render, queue, or agent-framework experience required. Familiarity with
HTTP and a mental model of "a process handling requests" is enough.

---

## 2. Logistics

- **Total time:** ~1.5 hours, designed as **two sessions** with a break.
  - **Session 1 — Substrates & coordination** (~50 min): Patterns 1 & 2,
    including the hand-rolled ack exercise.
  - **Session 2 — Let the platform (and agents) do it** (~50 min): Pattern 3
    and the author-a-task finale, where coding agents come out.
- **Format:** live deploys + two hands-on labs. Learners follow along on their own
  Render accounts and machines.
- **Group size:** works 1:1 up to ~30 with a helper for debugging environments.
- **Delivery:** in-person or remote. Remote works fine. Have learners share service
  URLs, CLI output, and Dashboard screenshots when they get stuck.

### Compressed variants

TODO

---

## 3. The spine (the one mental model to land)

Draw this once, early, and return to it at every transition. It is the whole talk.

```
            SAME AGENT  ───────────────────────────────────▶  (never changes)

Pattern 1   [ web request runs the agent ]                 you own: nothing
            └ breaks: timeouts, lost on deploy, no scale       scales: no

Pattern 2   [ web ] → (Valkey queue) → [ worker runs agent ] you own: queue,
            └ durable, scales by adding workers                consumer group,
                                                               acks, retries, pub/sub

Pattern 3   [ web ] → Render Workflows → [ task per agent ]  you own: nothing
            └ same durability + scale, declarative             scales: yes
```

The emotional arc you're selling:

1. **Pattern 1 feels good** ("look, it's live") → then you break it on stage.
2. **Pattern 2 is powerful** ("now it's durable and scales!") → then they write
   the acks by hand and see how much coordination they now *own*.
3. **Pattern 3 feels like cheating** ("wait, that's it?") → the guarantees from
   Pattern 2 collapse into `retry: { maxRetries: 2 }`, a CLI-created Workflow, and
   a trace.

If learners leave able to recite "the agent never changed, the substrate did the
work," the workshop succeeded.

---

## 4. Pre-flight checklist

Do this **before** learners arrive (and have learners do the install ahead of time
if you can — environment setup is the #1 time sink).

Facilitator machine:

- [ ] Node >= 22.12 (`node -v`).
- [ ] `npm install` from the repo root completes clean.
- [ ] Render CLI installed, logged in, and pointed at the right workspace
      (`render login`, then `render workspace set`).
- [ ] A fork or workshop repo connected to Render.
- [ ] Pattern 1 and Pattern 2 Blueprints tested from that repo.
- [ ] Pattern 3 hybrid path rehearsed with the web+Postgres Blueprint and
      `render workflows create`.
- [ ] Optional local Postgres running with `createdb agents_workshop`.
- [ ] Optional local Redis/Valkey running with `redis-server &` or
      `docker run -p 6379:6379 redis`.
- [ ] `npm test` is green (this proves the whole thing works on the mock model).
- [ ] A couple of **demo PR URLs** picked out — one small, one with frontend files
      so the `ux` reviewer fires. Public repos need no token. e.g.
      `https://github.com/octocat/Hello-World/pull/9681`.
- [ ] Decide: real model or mock? With **no LLM provider API key** everything runs
      on a deterministic mock model — totally fine and fully offline. Set
      `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` only if you want live reviews. Have
      `AGENT_MODEL=mock` ready as a fallback if the gateway misbehaves on stage.

Room / screen:

- [ ] Terminal font large enough to read from the back.
- [ ] Browser tabs open to the Render Dashboard, the learner-facing docs, and one
      deployed service URL.
- [ ] Terminal tabs ready for `render services`, `render logs`, and
      `render workflows`.

Tell learners up front: **no LLM provider API key is required.** This removes the
single biggest source of "it doesn't work for me."

---

## 5. Run sheet (module by module)

Each module below has: **objective**, **talk track**, **do this live**, **the aha**,
**pitfalls**, and a **check for understanding (CFU)**.

### Module 0 — Setup & framing (10 min)

- **Objective:** everyone can deploy, and everyone holds the spine in §3.
- **Talk track:** "We're going to build a code reviewer once and run it three ways.
  Watch what *doesn't* change." Draw the spine.
- **Do this live:** confirm `render login`, `render workspace set`, and
  `npm install`. Point out the monorepo: `shared/*` is the constant, `packages/*`
  are the three substrates.
- **Pitfall:** learners without Git provider access in Render. Pair them with a
  helper or have them follow the facilitator deploy while they keep coding locally.
- **CFU:** "Which folder holds the agent itself?" (Answer: `shared/agent`, not any
  of the three packages.)

Reference: [`docs/00-setup.md`](../docs/00-setup.md).

### Module 1 — Pattern 1: the naive baseline (15 min)

- **Objective:** establish the baseline and make its breakage visceral.
- **Talk track:** "Simplest thing that works: the agent runs *inside the request*."
- **Do this live:**
  1. Deploy [`packages/naive-agent/render.yaml`](../packages/naive-agent/render.yaml)
     as a Blueprint.
  2. Open the live Web Service URL and submit a demo PR.
  3. Open the row → show per-agent findings and spans (LLM turns + tool calls).
  4. Tail logs with `render logs --resources <service-id> --tail`.
  5. Show the handler in [`packages/naive-agent/src/server.ts`](../packages/naive-agent/src/server.ts):
     the POST handler `await`s `runReview()` and *only then* responds. Read the
     file's top comment aloud — it names the three failure modes.
- **The aha:** it's complete and simple. Sit in that for a second before breaking it.
- **Break it on stage (the motivation for Pattern 2):**
  - Submit a large PR (or talk through it) → the request blocks. A slow model or a
    proxy timeout kills it.
  - "What happens if I redeploy mid-review?" → in-flight work is lost. Nowhere
    durable for it to live.
  - Concurrent users share one process. The "parallel" reviewers contend for one box.
- **Pitfall:** if using a real model, a big PR can genuinely time out. That's the
  point, but don't let it derail. Switch to a small PR to keep moving.
- **CFU:** "Name two reasons this design fails under load." (timeouts, lost on
  deploy/crash, no independent scale.)

Reference: [`docs/01-naive-agent.md`](../docs/01-naive-agent.md).

### Module 2 — Pattern 2: worker + queue (20 min, before the lab)

- **Objective:** show that moving the *substrate* (not the agent) buys durability
  and scale — and surface the coordination cost.
- **Talk track:** "Same `runReview()`. The web tier becomes a thin producer. A
  background worker consumes a Valkey queue and runs the review out-of-band."
- **Do this live:**
  1. Deploy [`packages/worker-agents/render.yaml`](../packages/worker-agents/render.yaml)
     as a Blueprint.
  2. Submit several PRs quickly → watch the web service enqueue and return 202.
  3. Tail the worker logs with `render logs --resources <worker-id> --tail`.
  4. Scale the Background Worker in the Dashboard or update `numInstances`.
  5. Restart or redeploy the web service mid-review → the worker keeps owning the job.
- **The aha:** the agent code is *identical to Pattern 1* — point at the comment in
  `kv.ts` that says `runReview()` is unchanged. Only *where it runs* moved.
- **Now flip it:** open [`packages/worker-agents/src/kv.ts`](../packages/worker-agents/src/kv.ts)
  and scroll the file slowly. "This is the price. The stream, the consumer group,
  blocking reads, acks, retry-on-failure, the pub/sub progress bus — all of this is
  coordination code *you* now own and debug." This sets up the lab.
- **Pitfall:** Blueprint sync or service deploy still running → the web app can open
  before the worker is ready. Check service health and worker logs first.
- **CFU:** "What did we have to add going from Pattern 1 to Pattern 2, and what did
  we change in the agent?" (Added: queue/worker/acks/pub-sub. Changed in agent:
  nothing.)

Reference: [`docs/02-worker-agents.md`](../docs/02-worker-agents.md).

### LAB 1 — Hand-write the ack semantics (20–25 min)

This is the Session 1 hands-on. It's deliberately small and done **by hand** (no
coding agents yet) — feeling the acks/retries you own is the entire point, and it
makes Pattern 3 land harder.

- **Setup:** learners open `processEntry` in
  [`packages/worker-agents/src/kv.ts`](../packages/worker-agents/src/kv.ts). It
  currently throws. The exercise contract is in the comment block right above it.
- **The task:** handle one delivered stream entry and decide whether to ack.
  - **Success** → `XACK` so the group never redelivers it.
  - **Failure** (handler throws) → **don't** ack. Log and return so the message
    stays pending and gets retried. **Never let the error escape the loop** (that
    would kill the consumer).
- **Verify (red → green):**
  ```sh
  REDIS_URL=redis://127.0.0.1:6379 npm run test:worker
  ```
  Two tests flip: one asserts a handled message is acked (leaves the pending list),
  one asserts a failed handler leaves it pending.
- **Facilitation:**
  - Give them ~8–10 min before showing anything. Circulate.
  - Hint ladder (escalate only as needed):
    1. "Parse first: `const job = fieldsToJob(fields)`."
    2. "Wrap the work + the ack in one try/catch."
    3. "In the catch, log and `return` — do not rethrow, do not ack."
  - The single most common bug: acking in a `finally`, or letting the error
    propagate. Both defeat the retry. Call this out explicitly.
- **The aha to name out loud:** "You just implemented at-least-once delivery. Hold
  onto this feeling — in Session 2 you get the exact same guarantee for free."
- **Deploy beat:** push the fix and redeploy the worker. The lab is local because it
  is a tight red-to-green loop, but the result runs live.
- **Solution:** see §8 and [`docs/02-worker-agents.md`](../docs/02-worker-agents.md).

> Break here between sessions.

### Module 3 — Pattern 3: Workflows (20 min)

- **Objective:** show the coordination from Lab 1 becoming declarative.
- **Talk track:** "Same fan-out, expressed as Render tasks. The queue, retries,
  coordination, and observability you hand-rolled are now declarative. The unit you
  author is a **task**: a plain async function + a config object."
- **Do this live:**
  ```sh
  # deploy packages/workflow-agents/render.yaml first
  render workflows create ...     # Workflow service
  render workflows tasks list
  render workflows start workflow-agents/code-review \
    --input='[{"url":"https://github.com/<owner>/<repo>/pull/<n>","labels":[]}]'
  ```
  Use [`docs/03-workflow-agents.md`](../docs/03-workflow-agents.md) for the full
  command block. Call out the required env-var step plainly: the web service and
  Workflow service need the same Postgres connection string.
- **Show the code that matters:**
  - [`agentTask.ts`](../packages/workflow-agents/src/agentTask.ts): the *entire*
    bridge — `task(agent.name, ({input}) => agent.run(input, ...))`. One function.
  - [`code-review/index.ts`](../packages/workflow-agents/src/workflows/code-review/index.ts):
    `prepareDiff`/`filterDiff` are plain in-process functions. Each reviewer is a
    `task()`. `Promise.all` fans them out. `ux` is conditional on frontend files.
- **The aha:** put the three "fan-out" implementations side by side (this table is
  the punchline of the whole workshop):

  | Pattern | How fan-out is written | You maintain |
  | --- | --- | --- |
  | naive | `Promise.all([...])` in one process | nothing, but no scale/durability |
  | worker | `XADD` → consumer group → acks → pub/sub | the whole queue (Lab 1!) |
  | workflow | `Promise.all([agent.run(), ...])` where `agent` is a `task()` | nothing |

- **Pitfall:** if a live task list is empty, the Workflow version might not be
  released yet, or the workflow didn't auto-discover. It must be
  `src/workflows/<name>/index.ts` exporting a `task()`.
- **CFU:** "Where are the retries in Pattern 3?" (In the task's config object —
  compare to the hand-written retry you wrote in Lab 1.)

Reference: [`docs/03-workflow-agents.md`](../docs/03-workflow-agents.md).

### LAB 2 — Author a task (25–35 min, the finale)

This is the highest-value segment. **Now coding agents come out.** The `task()` API
is small enough that an agent reasons about it directly. Learners compose tasks,
force retries, and inspect the live trace.

- **Starter:** [`your-review/index.ts`](../packages/workflow-agents/src/workflows/your-review/index.ts)
  is already a working sandbox. It auto-discovered with zero registration.
- **Sequence (each step has a payoff):**
  1. **Preview what's there.** `render workflows tasks list --local` → `your-review`
     → run with `{ "url": "...pull/<n>" }`. Payoff: "you authored a task and never
     registered it anywhere — `loader.ts` found it because the folder exists."
  2. **Compose an agent as a task.** Extend the sandbox to run a reviewer as its own
     task and return its findings. Encourage learners to point their coding agent
     (Cursor/Claude/etc.) at the ideas at the bottom of the file.
  3. **See the power — force a retry.** Add `if (Math.random() < 0.5) throw new
     Error("flaky!")` at the top of the body. Re-run a few times and watch Render retry
     in a fresh instance per the `retry` config — no try/catch, no dead-letter, no
     queue. **Remove it when done.**
  4. **Bonus — fan out** both reviewers with `Promise.all` (mirrors `code-review`).
  5. **Ship it live.** Push the task, release a Workflow version, start the live
     `your-review` task, and open the trace in the Dashboard.
- **Bonus points (for fast finishers or a take-home):** [04 — Bonus points](../docs/04-author-a-task.md#bonus-points)
  has three guided, independent challenges — a **judge reflection loop**, **wiring
  in an MCP tool**, and a **human-in-the-loop gate**. Each reinforces the spine:
  the agentic capability is yours to write. Durability/isolation/tracing stay the
  platform's. Point a coding agent at them and let learners drive.
- **The aha (say this verbatim-ish):** "You just added durable, retried, isolated,
  traced, parallel execution by writing a plain function and a config object. In
  Lab 1 that same guarantee took a queue, a consumer group, acks, and a pub/sub bus
  — all code you owned. The agent never changed. The substrate did the work."
- **Pitfall:** import path is `../../agentTask.js` (note the `.js`, NodeNext). If a
  learner's agent writes `.ts`, it'll fail to resolve.
- **CFU:** "What's the difference between a *step* and a *task* here?" (A step is a
  plain function for pure logic. A task is wrapped in `task()` for isolation/retries/
  traces. See `overview()` vs the exported task in `your-review`.)
- **Solution:** §8 and [`docs/04-author-a-task.md`](../docs/04-author-a-task.md).

### Module 4 — Close (10 min)

- Pattern 1 and Pattern 2 use Blueprints: web+Postgres (naive), then web+worker+
  Key Value+Postgres (worker).
- Pattern 3 uses a Blueprint for web+Postgres and the CLI for the Workflow service,
  task runs, logs, and versions.
- In production, leave `RENDER_USE_LOCAL_DEV` unset so the Pattern 3 gateway
  dispatches real Workflow tasks.
- **Close on the spine.** Re-draw it. Ask the room: "What changed in the agent
  across all three?" (Nothing.) That's the takeaway.
- **Send them home with the map.** Point at [05 — Future iterations](../docs/05-future-iterations.md):
  an eval harness, guardrails, circuit breakers, and observability deep-dives — the
  production road, framed as "more steps, tasks, budgets, and tracers. Still the
  same agent."

---

## 6. The demo flow at a glance (print this)

```
Setup        render login → render workspace set → npm install → draw the spine
Pattern 1    Blueprint deploy → live URL → submit PR → show spans/logs → break it
Pattern 2    Blueprint deploy → submit PRs → tail worker logs → scale worker
             → open kv.ts: "this is the price"
LAB 1        implement processEntry → npm run test:worker (red→green)
── break ──
Pattern 3    Blueprint web+DB → workflows create → run code-review → show trace
             → side-by-side fan-out table
LAB 2        preview your-review → compose agent → force retry → ship live
Close        re-draw spine: "the agent never changed"
```

---

## 7. Troubleshooting & FAQ

| Symptom | Cause / fix |
| --- | --- |
| Reviews never run / agent output looks canned | No LLM provider API key → it's the **mock model**. Expected. Set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for real reviews. |
| Pattern 2 web errors on submit | Redis/Valkey not running, or `REDIS_URL` wrong. `redis-server &`. |
| `npm run test:worker` can't connect | Same — needs a live Redis. Prefix with `REDIS_URL=redis://127.0.0.1:6379`. |
| Postgres connection refused | `createdb agents_workshop` or fix `DATABASE_URL`. For Pattern 1 you can leave it unset (in-memory). |
| `render workflows tasks list --local` is empty | The `dev:workflows` process isn't running (terminal A), or the workflow folder isn't `src/workflows/<name>/index.ts` exporting a `task()`. |
| New task won't load | Auto-discovery requires the folder + an `index.ts` default-exporting `task()`. No manual registration needed — and none possible to "forget." |
| Module resolution error in Lab 2 | NodeNext needs the `.js` extension in relative imports (`../../agentTask.js`). |
| UX reviewer never fires | It only runs when the diff has frontend files (`.tsx/.jsx/.vue/.css`…). Use a PR that touches them. |
| Big PR times out (real model) | That's literally Pattern 1's failure mode. Switch to a small PR to keep pace. |

Common conceptual questions:

- **"Didn't we rewrite the agent each time?"** No. It's the same `@workshop/agent`
  import everywhere. Open all three packages and grep — the diff is the substrate.
- **"Why hand-write acks if Workflows does it?"** So you understand what the
  platform is doing *for* you. The lab is the setup for the payoff.
- **"Is a step the same as a task?"** No — a step is plain logic (no `task()`). A
  task gets isolation/retries/traces. Show `overview()` vs the exported task.

---

## 8. Solutions

### Lab 1 — `processEntry` (worker-agents/src/kv.ts)

```ts
export async function processEntry(
  client: Redis,
  id: string,
  fields: string[],
  handler: (job: ReviewJob) => Promise<void>,
): Promise<void> {
  const job = fieldsToJob(fields)
  try {
    if (job) await handler(job)
    await client.xack(STREAM, GROUP, id)
  } catch (err) {
    console.error('[kv] handler failed, leaving message un-acked for retry:', err)
  }
}
```

Why it's correct: the `xack` is *inside* the `try`, after a successful handler, so a
failure skips it and the message stays pending. The `catch` logs and returns —
never rethrows — so the blocking consumer loop in `consumeReviews` keeps running.

### Lab 2 — `your-review` (compose an agent as a task)

```ts
import { securityReviewer } from "@workshop/agent";
import { agentTask } from "../../agentTask.js";

const securityTask = agentTask(securityReviewer);

// inside yourReview, after you have filtered.patches:
const review = await securityTask({ patches: filtered.patches });
return { ...existingReturn, review: review.text };
```

Bonus (fan out both reviewers):

```ts
import { REVIEWERS } from "@workshop/agent";
const reviewerTasks = REVIEWERS.map(agentTask);
const reviews = await Promise.all(
  reviewerTasks.map((run) => run({ patches: filtered.patches })),
);
```

This is the same fan-out as the built-in `code-review` workflow — have learners diff
their file against
[`code-review/index.ts`](../packages/workflow-agents/src/workflows/code-review/index.ts).

---

## 9. Assessment / exit ticket

Quick checks that learners hit the objectives (use any 2–3):

1. "Give one failure mode of Pattern 1 and the Pattern 2 feature that fixes it."
2. "In Lab 1, why must the handler error *not* escape `processEntry`?"
3. "What two things make up a Render `task()`?" (a config object + an async fn)
4. "Where did the retry logic live in Pattern 2 vs Pattern 3?"
5. One-liner: "What changed in the agent across all three patterns?" (Nothing.)

If they can answer #5 with conviction, they got it.
