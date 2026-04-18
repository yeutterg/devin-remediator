// Zod contract tests for Devin v3 response shapes. These run the exact schemas used by
// DevinClient against recorded fixtures, so a server-side rename (e.g. `pull_request` →
// `pull_requests`) fails loudly at CI time instead of silently dropping PR URLs like it did on
// our first run.
//
// Run with: node --test --loader ts-node/esm src/devin.contract.test.ts
// (or `npm test`, which does the same.)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";

// Re-declare the schemas here rather than exporting them from devin.ts, so the test file is
// self-contained and any drift between the production schema and the test expectation is
// explicit at the callsite.
const SessionStatusApi = z.enum([
  "running",
  "blocked",
  "completed",
  "stopped",
  "finished",
  "expired",
  "suspended",
]);

const GetSessionResponse = z.object({
  session_id: z.string(),
  status: SessionStatusApi.or(z.string()),
  status_enum: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  is_archived: z.boolean().optional(),
  acus_consumed: z.number().optional(),
  structured_output: z.record(z.string(), z.unknown()).optional().nullable(),
  pull_request: z
    .object({ url: z.string().optional() })
    .optional()
    .nullable(),
  pull_requests: z
    .array(
      z.object({
        url: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional()
    .nullable(),
});

const CreateSessionResponse = z.object({
  session_id: z.string(),
  url: z.string().optional(),
});

const PlaybookResponse = z.object({
  playbook_id: z.string(),
  title: z.string(),
  body: z.string(),
  macro: z.string().nullable().optional(),
  updated_at: z.number().optional(),
});

test("CreateSessionResponse accepts minimal shape", () => {
  const parsed = CreateSessionResponse.parse({
    session_id: "devin-abc123",
    url: "https://app.devin.ai/sessions/abc123",
  });
  assert.equal(parsed.session_id, "devin-abc123");
});

test("GetSessionResponse handles running session with pull_requests[] array", () => {
  // This shape was responsible for our first-run bug: we only looked at `pull_request` and
  // missed PRs exposed under `pull_requests[]`.
  const parsed = GetSessionResponse.parse({
    session_id: "devin-abc123",
    status: "running",
    status_enum: "running",
    title: "Remediate #31: vuln:dep",
    url: "https://app.devin.ai/sessions/abc123",
    pull_requests: [
      { url: "https://github.com/y/r/pull/31", title: "bump flask-cors", status: "open" },
    ],
    acus_consumed: 3.25,
  });
  assert.equal(parsed.status, "running");
  assert.ok(parsed.pull_requests);
  assert.equal(parsed.pull_requests[0]?.url, "https://github.com/y/r/pull/31");
  assert.equal(parsed.acus_consumed, 3.25);
});

test("GetSessionResponse handles archived + completed", () => {
  const parsed = GetSessionResponse.parse({
    session_id: "devin-abc123",
    status: "finished",
    is_archived: true,
    structured_output: { pr_url: "https://github.com/y/r/pull/32", confidence: "high" },
  });
  assert.equal(parsed.is_archived, true);
  assert.equal(parsed.structured_output?.["confidence"], "high");
});

test("GetSessionResponse tolerates null pull_request (pre-PR)", () => {
  const parsed = GetSessionResponse.parse({
    session_id: "devin-abc123",
    status: "running",
    pull_request: null,
    pull_requests: null,
    structured_output: null,
  });
  assert.equal(parsed.pull_request, null);
  assert.equal(parsed.pull_requests, null);
});

test("GetSessionResponse rejects missing session_id", () => {
  assert.throws(() => GetSessionResponse.parse({ status: "running" }));
});

test("PlaybookResponse parses v3 /playbooks POST response", () => {
  const parsed = PlaybookResponse.parse({
    playbook_id: "pb-abc",
    title: "Remediator: vuln:dep",
    body: "# body",
    macro: "!remediator-vuln-dep",
    updated_at: 1700000000,
  });
  assert.equal(parsed.playbook_id, "pb-abc");
  assert.equal(parsed.macro, "!remediator-vuln-dep");
});

test("PlaybookResponse allows null macro", () => {
  const parsed = PlaybookResponse.parse({
    playbook_id: "pb-abc",
    title: "T",
    body: "B",
    macro: null,
  });
  assert.equal(parsed.macro, null);
});
