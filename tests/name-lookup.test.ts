/**
 * Name-lookup tests for the session-registry-sync find_session core.
 *
 * Isolation: every test points SESSION_REGISTRY_SYNC_STATE_DIR at a fresh
 * temp state dir; entries are registered through the real event pipeline and
 * listed through listLiveEntries before lookupByName runs. No network.
 *
 * Covered behaviors:
 *   3. exact-name lookup via lookupByName (status ok, via "name")
 *   4. case-insensitive name match
 *   5. ambiguity failure: two live entries with the same name -> status
 *      "ambiguous" with candidate entries
 *   6. absent-name failure: status "missing" with the allNames list, and no
 *      guessed entry
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import {
  handleSessionEvent,
  listLiveEntries,
  lookupByName,
  type LogFn,
  type SyncDeps,
} from "../src/index.js"

let stateDir = ""

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "srs-lookup-"))
  process.env.SESSION_REGISTRY_SYNC_STATE_DIR = stateDir
})

afterEach(() => {
  delete process.env.SESSION_REGISTRY_SYNC_STATE_DIR
  rmSync(stateDir, { recursive: true, force: true })
})

function makeDeps(): SyncDeps {
  const log: LogFn = (_event, _fields) => {}
  return {
    daemonId: "lookup-test-daemon",
    deviceName: "lookup-test-device",
    log,
    heartbeat: 60 * 60 * 1000,
  }
}

async function register(sessionId: string, title: string): Promise<void> {
  const outcome = await handleSessionEvent(
    {
      type: "session.created",
      data: {
        sessionID: sessionId,
        title,
        projectID: "proj_test",
        location: { directory: "/Users/dev/demo-project" },
      },
    },
    makeDeps(),
  )
  assert.equal(outcome?.action, "created", `fixture registration of ${sessionId} must land`)
}

test("lookupByName resolves an exact live name with status ok via name", async () => {
  await register("ses_a", "review-bridge")
  await register("ses_b", "docs-draft")
  const entries = await listLiveEntries()

  const result = lookupByName(entries, "review-bridge")
  assert.equal(result.status, "ok")
  assert.equal(result.via, "name")
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]?.sessionId, "ses_a")
})

test("lookupByName matches names case-insensitively", async () => {
  await register("ses_a", "review-bridge")
  const entries = await listLiveEntries()

  const upper = lookupByName(entries, "REVIEW-BRIDGE")
  assert.equal(upper.status, "ok")
  assert.equal(upper.via, "name")
  assert.equal(upper.entries[0]?.sessionId, "ses_a")

  const padded = lookupByName(entries, "  review-bridge  ")
  assert.equal(padded.status, "ok", "surrounding whitespace must be trimmed")
  assert.equal(padded.via, "name")
  assert.equal(padded.entries[0]?.sessionId, "ses_a")
})

test("two live entries with the same name resolve as ambiguous with candidates", async () => {
  await register("ses_x", "worker")
  await register("ses_y", "worker")
  const entries = await listLiveEntries()

  const result = lookupByName(entries, "worker")
  assert.equal(result.status, "ambiguous")
  assert.equal(result.entries.length, 2, "both candidate entries must be returned")
  const candidateIds = result.entries.map((e) => e.sessionId).sort()
  assert.deepEqual(candidateIds, ["ses_x", "ses_y"])
})

test("an absent name resolves as missing with the known names and no guess", async () => {
  await register("ses_a", "review-bridge")
  await register("ses_b", "docs-draft")
  const entries = await listLiveEntries()

  const result = lookupByName(entries, "no-such-name")
  assert.equal(result.status, "missing")
  assert.equal(result.entries.length, 0, "a missing name must never return a guessed entry")
  assert.ok(result.allNames.includes("review-bridge"), "allNames must list live names")
  assert.ok(result.allNames.includes("docs-draft"), "allNames must list live names")
})
