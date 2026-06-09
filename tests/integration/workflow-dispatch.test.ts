/**
 * Regression tests for two workflow-agents bugs fixed together.
 *
 * Bug 1 — SDK results array unwrap: The Render SDK wraps task results in an
 *   array (`finished.results` is `[summary]`), but `runReviewWorkflow`
 *   expected a plain object. Verdict, findings, and token counts were silently
 *   lost. The fix unwraps the single-element array.
 *
 * Bug 2 — Workflow auto-discovery race: The SDK auto-starts its task server
 *   via `setImmediate` on the first `task()` call. Sequential `await import()`
 *   in `loadWorkflows` let that fire between workflows, so later-discovered
 *   workflows registered after the server started and were silently dropped.
 *
 * The tests below exercise the loader (bug 2) and the in-process dispatch
 * result normalization (bug 1) without requiring a live Render dev server.
 */
delete process.env.DATABASE_URL
process.env.RENDER_USE_LOCAL_DEV = 'true'

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { installGithubStub, TEST_PR_URL, waitFor } from '../helpers.js'
import { loadWorkflows } from '../../packages/workflow-agents/src/workflows/loader.js'
import { createApp } from '../../packages/workflow-agents/src/server.js'

let restoreFetch: () => void

before(() => {
  restoreFetch = installGithubStub()
})
after(() => restoreFetch())

// ── Bug 2 regression: all workflows are discovered ──────────────────────────

test('loadWorkflows discovers both code-review and your-review', async () => {
  const dir = new URL(
    '../../packages/workflow-agents/src/workflows',
    import.meta.url,
  ).pathname

  const { mapping, localTasks } = await loadWorkflows(dir)

  assert.ok('code-review' in mapping, 'code-review missing from mapping')
  assert.ok('your-review' in mapping, 'your-review missing from mapping')
  assert.ok('code-review' in localTasks, 'code-review missing from localTasks')
  assert.ok('your-review' in localTasks, 'your-review missing from localTasks')
})

// ── Bug 1 regression: verdict + findings persist through dispatch ────────────

test('your-review workflow is reachable and returns a structured result', async () => {
  const app = await createApp()

  const res = await app.fetch(
    new Request('http://test/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl: TEST_PR_URL, workflow: 'your-review' }),
    }),
  )
  assert.equal(res.status, 202)
  const { id } = (await res.json()) as { id: string }
  assert.ok(id)

  let final:
    | { review: { status: string; reason: string | null } }
    | undefined
  await waitFor(async () => {
    const detail = await app.fetch(new Request(`http://test/api/reviews/${id}`))
    final = (await detail.json()) as typeof final
    return final?.review.status !== 'running'
  })

  assert.equal(final?.review.status, 'done')
  assert.ok(final?.review.reason, 'your-review should produce a reason')
  assert.ok(
    final!.review.reason!.includes('overview') || final!.review.reason!.includes('fileCount'),
    'reason should contain the overview output from your-review',
  )
})

test('code-review verdict and findings persist through the dispatch path', async () => {
  const app = await createApp()

  const res = await app.fetch(
    new Request('http://test/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl: TEST_PR_URL }),
    }),
  )
  assert.equal(res.status, 202)
  const { id } = (await res.json()) as { id: string }
  assert.ok(id)

  let final:
    | {
        review: {
          status: string
          verdict: string | null
          reason: string | null
          input_tokens: number
          output_tokens: number
        }
        findings: Array<{ agent: string }>
      }
    | undefined
  await waitFor(async () => {
    const detail = await app.fetch(new Request(`http://test/api/reviews/${id}`))
    final = (await detail.json()) as typeof final
    return final?.review.status !== 'running'
  })

  // Before the fix, the in-process path worked but the SDK dispatch path
  // returned `finished.results` as an array — verdict, findings, and tokens
  // were all null/empty. This test pins the correct behavior.
  assert.equal(final?.review.status, 'done')
  assert.equal(final?.review.verdict, 'approve', 'verdict must persist (was null before fix)')
  assert.ok(final?.review.reason, 'reason must persist')
  assert.ok(
    (final?.findings.length ?? 0) >= 2,
    `expected ≥2 findings (security + performance + judge), got ${final?.findings.length}`,
  )
  assert.equal(typeof final?.review.input_tokens, 'number')
  assert.equal(typeof final?.review.output_tokens, 'number')
})
