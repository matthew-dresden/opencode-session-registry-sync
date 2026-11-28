/**
 * Registry sync behavior tests for the session-registry-sync pure core.
 *
 * Isolation: every test points SESSION_REGISTRY_SYNC_STATE_DIR at a fresh
 * temp state dir, so registry reads/writes never touch the operator's real
 * state. No network: handleSessionEvent operates on the registry file only.
 *
 * Covered behaviors:
 *   1. registration: session.created writes a registry entry carrying the
 *      session name.
 *   2. rename trail preservation: a name change appends the previous name to
 *      renamedFrom, capped at the trail limit, most recent last.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import {
  handleSessionEvent,
  readRegistry,
  type LogFn,
  type SyncDeps,
} from "../src/index.js"

let stateDir = ""

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "srs-sync-"))
  process.env.SESSION_REGISTRY_SYNC_STATE_DIR = stateDir
})

afterEach(() => {
  delete process.env.SESSION_REGISTRY_SYNC_STATE_DIR
  rmSync(stateDir, { recursive: true, force: true })
})

function makeDeps(): SyncDeps {
  const log: LogFn = (_event, _fields) => {
    // Structured log events are not asserted here; registry state is.
  }
  return {
    daemonId: "sync-test-daemon",
    deviceName: "sync-test-device",
    log,
    heartbeat: 60 * 60 * 1000,
  }
}

function createdEvent(sessionId: string, title: string): Record<string, unknown> {
  return {
    type: "session.created",
    data: {
      sessionID: sessionId,
      title,
      projectID: "proj_test",
      location: { directory: "/Users/dev/demo-project" },
    },
  }
}

function renamedEvent(sessionId: string, title: string): Record<string, unknown> {
  return {
    type: "session.renamed",
    data: { sessionID: sessionId, title },
  }
}

test("session.created writes a registry entry carrying the session name", async () => {
  const outcome = await handleSessionEvent(
    createdEvent("ses_reg_1", "review-bridge"),
    makeDeps(),
  )

  assert.ok(outcome, "session.created must produce an outcome")
  assert.equal(outcome.action, "created")
  assert.equal(outcome.sessionId, "ses_reg_1")
  assert.equal(outcome.name, "review-bridge")

  const file = await readRegistry()
  assert.equal(file.version, 1)
  const entry = file.sessions["ses_reg_1"]
  assert.ok(entry, "registry entry must exist after session.created")
  assert.equal(entry.name, "review-bridge")
  assert.equal(entry.sessionId, "ses_reg_1")
  assert.equal(entry.directory, "/Users/dev/demo-project")
  assert.equal(entry.projectId, "proj_test")
  assert.equal(entry.summary, "review-bridge")
})

test("session.renamed appends the previous name to renamedFrom, most recent last, capped", async () => {
  const deps = makeDeps()
  await handleSessionEvent(createdEvent("ses_ren_1", "alpha"), deps)

  const renames = [
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliett",
    "kilo",
    "lima",
  ]
  for (const name of renames) {
    const outcome = await handleSessionEvent(renamedEvent("ses_ren_1", name), deps)
    assert.equal(outcome?.action, "renamed", `rename to ${name} must land as renamed`)
  }

  const entry = (await readRegistry()).sessions["ses_ren_1"]
  assert.ok(entry, "registry entry must exist after renames")
  assert.equal(entry.name, "lima")

  const trail = entry.renamedFrom ?? []
  // Trail is capped: after 11 renames past "alpha", the oldest name fell off.
  assert.equal(trail.length, 10)
  assert.ok(!trail.includes("alpha"), "oldest name must fall off the capped trail")
  assert.equal(trail[0], "bravo", "trail starts at the oldest surviving name")
  assert.equal(trail[9], "kilo", "trail ends with the most recent previous name")
})
