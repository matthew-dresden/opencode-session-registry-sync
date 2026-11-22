/**
 * session-registry-sync: local opencode plugin (V2 `{ id, setup }` shape,
 * the only default-export shape opencode 2.3.x accepts for configured plugins).
 *
 * Standard implemented (owner-approved):
 * 1. Every opencode session auto-registers in the shared cross-session
 *    registry (`~/.local/state/opencode/agents-registry.json`) as soon as the
 *    session exists, no manual step.
 * 2. The registration is identified by the session NAME (`session.title`),
 *    stored in the additive `name` field.
 * 3. Session renames auto-sync: `session.renamed`/`session.updated` refresh
 *    `name`, and the previous name is appended to the capped additive
 *    `renamedFrom` trail so peers holding a stale name can re-resolve.
 * 4. Session deletion auto-removes the registry entry (`session.deleted`).
 * 5. Peers reference each other by name through the `find_session` tool,
 *    which fails with candidate lists on ambiguous or missing names and
 *    never guesses.
 * 6. Untitled sessions are auto-titled AT REGISTRATION TIME (first sync):
 *    the plugin derives `<project-dir-basename>-<session-id-short>` and sets
 *    it at the opencode level through the SDK session surface
 *    (`session.get` / `session.update`), so the entry is addressable by name
 *    from birth. An existing non-empty title is never overwritten; a manual
 *    rename always wins over the derived title and is recorded in
 *    `renamedFrom`. Auto-title is attempted once per session per plugin
 *    instance (`titleAttempts`), so update events cannot storm the API.
 * 7. Manual renames are the primary naming flow: the rename event itself is
 *    the authoritative name change; the trail is re-resolution support, not
 *    a second identity.
 *
 * Compatibility contract with the git plugin
 * (`opencode-cross-session-messaging@1.0.0`):
 * - Same registry file, same `{ version: 1, sessions }` shape, same atomic
 *   tmp+rename write discipline and stale-entry TTL. Extra per-entry fields
 *   (`name`) are ignored by that plugin's readers, so both writers coexist.
 * - Manual `register_session` keeps working and stays authoritative for
 *   `summary`; this plugin merges event data around it and never clobbers
 *   routing fields (`daemonId`, `serverUrl`) written by the other plugin.
 * - Registry entries written by this plugin carry THIS plugin's `daemonId`,
 *   and this plugin runs its own inbox watcher for them, so `ask_session`
 *   delivery works for auto-registered sessions without touching the git
 *   plugin's routing. Exactly one watcher owns each entry because each
 *   writer stamps a distinct daemonId.
 *
 * Event wire shapes (VERIFIED against the live opencode 2.3.2 HTTP event
 * feed by capturing raw SSE during a create/rename/delete cycle):
 * - `session.created` -> `{ type, data: { sessionID, slug, version, projectID,
 *   location: { directory }, subpath, title } }` (flat fields, no `info`)
 * - `session.renamed` -> `{ type, data: { sessionID, title } }` (renames are a
 *   dedicated event, not `session.updated`; the TUI rename and the CLI/SDK
 *   `session.update` both surface as this event)
 * - `session.deleted` -> `{ type, data: { sessionID } }`
 * - `session.updated` also handled (other mutable-session changes), same flat
 *   shape. The nested `info: Session` payload from the 2.0.x SDK types and
 *   the V1 `properties.info` shape are tolerated as fallbacks.
 *
 * Failure discipline mirrors the git plugin: per-event registry failures are
 * logged and skipped (registry sync is non-essential hygiene, the 24h TTL
 * is the backstop), while tool-level failures return readable error strings
 * and never throw into the host.
 */

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// Constants (mirroring opencode-cross-session-messaging src/constants.ts).
// Operational knobs are env-overridable; no other hard-coded environment.
// ---------------------------------------------------------------------------

const REGISTRY_SCHEMA_VERSION = 1 as const
const REGISTRY_FILENAME = "agents-registry.json"
const MESSAGES_DIR_NAME = "messages"
const LOG_FILENAME = "session-registry-sync.log"

/** Entries older than this in `updatedAt` are treated as stale. */
const STALE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000

/** File-inbox poll interval (same cadence as the git plugin's watcher). */
const INBOX_POLL_MS = 1_000

/** Reply-wait budget for a delivered inbox question. */
const INBOX_REQUEST_TIMEOUT_MS = 5 * 60_000

/** Poll interval while waiting for the target session's reply. */
const RESPONSE_POLL_MS = 500

/**
 * Minimum gap between `updatedAt` heartbeats for live-but-unchanged
 * sessions, so long-running sessions do not drift past the 24h stale
 * cutoff. Override with SESSION_REGISTRY_SYNC_HEARTBEAT_MS.
 */
const DEFAULT_HEARTBEAT_MS = 60 * 60 * 1000

/** renamedFrom trail is capped; oldest names fall off first. */
const RENAMED_FROM_LIMIT = 10

/** Chars of the session id used for the derived auto-title suffix. */
const AUTO_TITLE_ID_CHARS = 8

/** Derived auto-title format: <project-dir-basename>-<session-id-short>. */
export function deriveAutoTitle(directory: string, sessionId: string): string {
  const rawBase = basename(directory ?? "").toLowerCase()
  const base = rawBase.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  const idShort = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-AUTO_TITLE_ID_CHARS)
  return `${base.length > 0 ? base : "session"}-${idShort}`
}

function heartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SESSION_REGISTRY_SYNC_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEARTBEAT_MS
}

/**
 * Registry/message/log root. Default follows the git plugin's XDG layout
 * (`$XDG_STATE_HOME/opencode` else `$HOME/.local/state/opencode`).
 * SESSION_REGISTRY_SYNC_STATE_DIR redirects everything for isolated tests.
 */
export function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SESSION_REGISTRY_SYNC_STATE_DIR?.trim()
  if (override && override.length > 0) return override
  const xdg = env.XDG_STATE_HOME?.trim()
  if (xdg && xdg.length > 0) return join(xdg, "opencode")
  const home = env.HOME?.trim()
  if (!home || home.length === 0) {
    throw new Error("session-registry-sync: neither XDG_STATE_HOME nor HOME is set")
  }
  return join(home, ".local", "state", "opencode")
}

export function getRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(env), REGISTRY_FILENAME)
}

export function getMessagesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(env), MESSAGES_DIR_NAME)
}

function getLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(env), LOG_FILENAME)
}

// ---------------------------------------------------------------------------
// Types (structural, zero runtime dependencies on the host or the git plugin).
// ---------------------------------------------------------------------------

/** Mirrors the git plugin's RegistryEntry plus the additive fields. */
export interface RegistryEntry {
  sessionId: string
  name?: string
  /** Previous names, most recent last, capped at RENAMED_FROM_LIMIT. */
  renamedFrom?: string[]
  summary: string
  directory: string
  projectId: string
  serverUrl?: string
  daemonId?: string
  deviceName?: string
  registeredAt: number
  updatedAt: number
}

export interface Registry {
  version: typeof REGISTRY_SCHEMA_VERSION
  sessions: Record<string, RegistryEntry>
}

interface SessionEventLike {
  type?: unknown
  data?: unknown
  properties?: unknown
}

/**
 * Session-identifying fields as extracted from a wire event. On opencode 2.3.x
 * the HTTP event feed serializes session payloads FLAT on `data`
 * (`{ sessionID, title, projectID, location: { directory } }`), and renames
 * arrive as a dedicated `session.renamed` event; the `info` nested shape from
 * earlier 2.0.x SDKs is tolerated as a fallback.
 */
export interface ExtractedSessionEvent {
  kind: "created" | "updated" | "deleted"
  sessionId: string
  title: string
  directory: string
  projectId: string
}

/** Structural subset of the V2 plugin context this plugin uses. */
export interface SyncPluginContext {
  readonly session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<readonly unknown[]>
    get?(input: { sessionID: string }): Promise<unknown>
    update?(input: { sessionID: string; title?: string }): Promise<unknown>
  }
  readonly tool: {
    transform(callback: (editor: ToolEditor) => void | Promise<void>): Promise<unknown>
  }
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<SessionEventLike>
  }
}

export interface ToolEditor {
  add(tool: SyncToolDefinition): void
}

export interface SyncToolContext {
  readonly sessionID: string
  readonly signal?: AbortSignal
}

export interface SyncToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: {
    readonly type: "object"
    readonly properties: Record<string, Record<string, unknown>>
    readonly required?: readonly string[]
    readonly additionalProperties: false
  }
  readonly execute: (
    input: Record<string, unknown>,
    context: SyncToolContext,
  ) => Promise<{ content: string }>
}

// ---------------------------------------------------------------------------
// Structured log (append-only, never throws into the host).
// ---------------------------------------------------------------------------

export type LogFn = (event: string, fields?: Record<string, unknown>) => void

function createLogger(stateDir: string): LogFn {
  const path = join(stateDir, LOG_FILENAME)
  return (event, fields) => {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n"
    void fs
      .mkdir(stateDir, { recursive: true })
      .then(() => fs.appendFile(path, line, "utf8"))
      .catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Registry I/O (same file, same atomic tmp+rename discipline as the git
// plugin; in-process writes serialized through one promise chain).
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve()

function emptyRegistry(): Registry {
  return { version: REGISTRY_SCHEMA_VERSION, sessions: {} }
}

/** ENOENT -> empty registry; invalid JSON / wrong shape -> throw "corrupt". */
export async function readRegistry(env: NodeJS.ProcessEnv = process.env): Promise<Registry> {
  const path = getRegistryPath(env)
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return emptyRegistry()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Registry file at ${path} corrupt: invalid JSON (${msg})`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Registry file at ${path} corrupt: root is not an object`)
  }
  const candidate = parsed as { version?: unknown; sessions?: unknown }
  if (candidate.version !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Registry file at ${path} corrupt: unknown schema version ${String(candidate.version)}`,
    )
  }
  if (typeof candidate.sessions !== "object" || candidate.sessions === null) {
    throw new Error(`Registry file at ${path} corrupt: sessions is not an object`)
  }
  return {
    version: REGISTRY_SCHEMA_VERSION,
    sessions: candidate.sessions as Registry["sessions"],
  }
}

async function writeRegistry(next: Registry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = getRegistryPath(env)
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const json = JSON.stringify(next, null, 2)
  try {
    await fs.writeFile(tmp, json, "utf8")
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/** Serialized read-modify-write; the mutator returns undefined to skip writing. */
function mutate(mutator: (file: Registry) => Promise<Registry | undefined>): Promise<void> {
  const run = async (): Promise<void> => {
    const file = await readRegistry()
    const next = await mutator(file)
    if (next) await writeRegistry(next)
  }
  const next: Promise<void> = writeChain.then(run, run)
  writeChain = next
  return next
}

// ---------------------------------------------------------------------------
// Event -> registry sync core (exported for the isolated validation harness).
// ---------------------------------------------------------------------------

export interface SyncDeps {
  daemonId: string
  deviceName: string
  log: LogFn
  heartbeat: number
  /**
   * Claim an addressable title for an untitled session: returns the session's
   * authoritative title if it already has one, otherwise sets `candidate` at
   * the opencode level and returns it. Installed by setup() from the plugin
   * context; absent in the pure-core validation harness.
   */
  claimSessionTitle?: (sessionId: string, candidate: string) => Promise<string>
  /**
   * Authoritative session info for the registration path: wire events may be
   * partial (session.renamed carries only sessionID+title), so registration
   * fills missing directory/projectId/title from the live session.
   */
  describeSession?: (sessionId: string) => Promise<{
    title?: string
    directory?: string
    projectId?: string
  }>
  /** One auto-title attempt per session per plugin instance. */
  titleAttempts?: Set<string>
}

export interface SyncEventOutcome {
  action: "created" | "renamed" | "touched" | "updated-fields" | "removed" | "skipped"
  sessionId: string
  name?: string
}

function fieldString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function payloadDirectory(payload: Record<string, unknown>): string {
  const location = payload.location
  if (location && typeof location === "object") {
    const dir = fieldString((location as Record<string, unknown>).directory)
    if (dir.length > 0) return dir
  }
  return fieldString(payload.directory)
}

/**
 * Extract session fields from a wire event. Verified shapes:
 * - opencode 2.3.x HTTP feed (flat): `session.created` ->
 *   `{ sessionID, slug, version, projectID, location: { directory }, title }`,
 *   `session.renamed` -> `{ sessionID, title }`, `session.deleted` ->
 *   `{ sessionID }`.
 * - earlier 2.0.x SDK shape (nested, tolerated): `{ sessionID, info: Session }`.
 * - V1 legacy (tolerated): `properties: { sessionID, info: Session }`.
 * Returns null for events this plugin does not own or malformed payloads.
 */
export function extractSessionEvent(event: SessionEventLike): ExtractedSessionEvent | null {
  const type = typeof event.type === "string" ? event.type : ""
  let kind: ExtractedSessionEvent["kind"]
  if (type === "session.created") kind = "created"
  else if (type === "session.renamed" || type === "session.updated") kind = "updated"
  else if (type === "session.deleted") kind = "deleted"
  else return null
  const payload = (event.data ?? event.properties ?? {}) as Record<string, unknown>
  const info = (payload.info ?? {}) as Record<string, unknown>
  const sessionId =
    fieldString(payload.sessionID) ||
    fieldString(info.id)
  if (!sessionId) return null
  return {
    kind,
    sessionId,
    title: fieldString(payload.title) || fieldString(info.title),
    directory: payloadDirectory(payload) || fieldString(info.directory),
    projectId: fieldString(payload.projectID) || fieldString(info.projectID),
  }
}

function mergedEntry(
  existing: RegistryEntry | undefined,
  extracted: ExtractedSessionEvent,
  deps: SyncDeps,
  now: number,
): RegistryEntry {
  const keptSummary =
    typeof existing?.summary === "string" && existing.summary.trim().length > 0
      ? existing.summary
      : extracted.title
  return {
    sessionId: extracted.sessionId,
    name: extracted.title.length > 0 ? extracted.title : undefined,
    renamedFrom: existing?.renamedFrom,
    summary: keptSummary,
    directory: extracted.directory.length > 0 ? extracted.directory : (existing?.directory ?? ""),
    projectId: extracted.projectId.length > 0 ? extracted.projectId : (existing?.projectId ?? ""),
    // Preserve the owning writer's routing fields; stamp ours only when absent.
    serverUrl: existing?.serverUrl,
    daemonId: existing?.daemonId ?? deps.daemonId,
    deviceName: existing?.deviceName ?? deps.deviceName,
    registeredAt: existing?.registeredAt ?? now,
    updatedAt: now,
  }
}

async function entryName(sessionId: string): Promise<string | undefined> {
  try {
    const file = await readRegistry()
    const entry = file.sessions[sessionId]
    return typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : undefined
  } catch {
    return undefined
  }
}

async function resolveUntitledName(
  extracted: ExtractedSessionEvent,
  deps: SyncDeps,
): Promise<string> {
  const attempts = deps.titleAttempts
  const claim = deps.claimSessionTitle
  if (!attempts || !claim) return ""
  if (attempts.has(extracted.sessionId)) return ""
  attempts.add(extracted.sessionId)
  const candidate = deriveAutoTitle(extracted.directory, extracted.sessionId)
  try {
    const effective = await claim(extracted.sessionId, candidate)
    deps.log("autotitle:ok", { sessionId: extracted.sessionId, title: effective })
    return effective
  } catch (err: unknown) {
    deps.log("autotitle:fail", {
      sessionId: extracted.sessionId,
      title: candidate,
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

async function enrichFromLiveSession(
  extracted: ExtractedSessionEvent,
  deps: SyncDeps,
): Promise<ExtractedSessionEvent> {
  const describe = deps.describeSession
  if (!describe) return extracted
  const missingFields =
    extracted.title.length === 0 ||
    extracted.directory.length === 0 ||
    extracted.projectId.length === 0
  if (!missingFields) return extracted
  try {
    const info = await describe(extracted.sessionId)
    return {
      ...extracted,
      title: extracted.title.length > 0 ? extracted.title : (info.title?.trim() ?? ""),
      directory:
        extracted.directory.length > 0 ? extracted.directory : (info.directory ?? ""),
      projectId: extracted.projectId.length > 0 ? extracted.projectId : (info.projectId ?? ""),
    }
  } catch (err: unknown) {
    deps.log("describe:fail", {
      sessionId: extracted.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return extracted
  }
}

async function applySessionCreated(
  extracted: ExtractedSessionEvent,
  deps: SyncDeps,
): Promise<SyncEventOutcome> {
  let effectiveTitle = extracted.title
  let claimedExtracted = extracted
  if (effectiveTitle.length === 0 && !(await entryName(extracted.sessionId))) {
    claimedExtracted = await enrichFromLiveSession(extracted, deps)
    effectiveTitle = claimedExtracted.title
    if (effectiveTitle.length === 0) {
      effectiveTitle = await resolveUntitledName(claimedExtracted, deps)
    }
  }
  const claimed: ExtractedSessionEvent = { ...claimedExtracted, title: effectiveTitle }
  let outcome: SyncEventOutcome | undefined
  await mutate(async (file) => {
    const now = Date.now()
    const existingEntry = file.sessions[claimed.sessionId]
    if (existingEntry && existingEntry.name !== undefined && existingEntry.name.length > 0) {
      // The entry already carries its name (another writer or a beat event);
      // leave it untouched so we never clobber the owning writer's fields.
      outcome = { action: "skipped", sessionId: claimed.sessionId }
      return undefined
    }
    file.sessions[claimed.sessionId] = mergedEntry(existingEntry, claimed, deps, now)
    outcome = {
      action: "created",
      sessionId: claimed.sessionId,
      name: effectiveTitle.length > 0 ? effectiveTitle : undefined,
    }
    return file
  })
  return outcome ?? { action: "skipped", sessionId: extracted.sessionId }
}

async function applySessionUpdated(
  extracted: ExtractedSessionEvent,
  deps: SyncDeps,
): Promise<SyncEventOutcome> {
  let effectiveTitle = extracted.title
  const named = await entryName(extracted.sessionId)
  let claimedExtracted = extracted
  if (!named) {
    claimedExtracted = await enrichFromLiveSession(extracted, deps)
    effectiveTitle = claimedExtracted.title
    if (effectiveTitle.length === 0) {
      effectiveTitle = await resolveUntitledName(claimedExtracted, deps)
    }
  }
  const claimed: ExtractedSessionEvent = { ...claimedExtracted, title: effectiveTitle }
  let outcome: SyncEventOutcome | undefined
  await mutate(async (file) => {
    const now = Date.now()
    const existing = file.sessions[claimed.sessionId]
    const title = claimed.title
    if (!existing) {
      // Self-heal: sessions created before this plugin activated register on
      // their next update event.
      file.sessions[claimed.sessionId] = mergedEntry(undefined, claimed, deps, now)
      outcome = {
        action: "created",
        sessionId: claimed.sessionId,
        name: title.length > 0 ? title : undefined,
      }
      return file
    }
    const previousName = typeof existing.name === "string" ? existing.name : ""
    const dirty: string[] = []
    if (title.length > 0 && previousName !== title) {
      if (previousName.length > 0) {
        const trail = (existing.renamedFrom ?? []).filter((n) => n !== title)
        trail.push(previousName)
        existing.renamedFrom = trail.slice(-RENAMED_FROM_LIMIT)
        dirty.push("renamedFrom")
      }
      existing.name = title
      dirty.push("name")
    }
    if (typeof existing.summary !== "string" || existing.summary.trim().length === 0) {
      existing.summary = title
      dirty.push("summary")
    }
    if (claimed.directory.length > 0 && existing.directory !== claimed.directory) {
      existing.directory = claimed.directory
      dirty.push("directory")
    }
    if (claimed.projectId.length > 0 && existing.projectId !== claimed.projectId) {
      existing.projectId = claimed.projectId
      dirty.push("projectId")
    }
    if (dirty.length > 0) {
      existing.updatedAt = now
      outcome = {
        action: dirty.includes("name") ? "renamed" : "updated-fields",
        sessionId: claimed.sessionId,
        name: title.length > 0 ? title : undefined,
      }
      return file
    }
    if (now - existing.updatedAt >= deps.heartbeat) {
      existing.updatedAt = now
      outcome = {
        action: "touched",
        sessionId: claimed.sessionId,
        name: title.length > 0 ? title : undefined,
      }
      return file
    }
    outcome = { action: "skipped", sessionId: claimed.sessionId }
    return undefined
  })
  return outcome ?? { action: "skipped", sessionId: extracted.sessionId }
}

async function applySessionDeleted(sessionId: string, deps: SyncDeps): Promise<SyncEventOutcome> {
  let outcome: SyncEventOutcome | undefined
  await mutate(async (file) => {
    if (!(sessionId in file.sessions)) {
      outcome = { action: "skipped", sessionId }
      return undefined
    }
    delete file.sessions[sessionId]
    outcome = { action: "removed", sessionId }
    return file
  })
  return outcome ?? { action: "skipped", sessionId }
}

/** Handle one wire event; per-event failures are logged, never thrown. */
export async function handleSessionEvent(
  event: SessionEventLike,
  deps: SyncDeps,
): Promise<SyncEventOutcome | null> {
  const extracted = extractSessionEvent(event)
  if (!extracted) return null
  try {
    switch (extracted.kind) {
      case "created":
        return await applySessionCreated(extracted, deps)
      case "updated":
        return await applySessionUpdated(extracted, deps)
      case "deleted":
        return await applySessionDeleted(extracted.sessionId, deps)
    }
  } catch (err: unknown) {
    deps.log("sync:fail", {
      kind: extracted.kind,
      sessionId: extracted.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Live-entry listing and name lookup (find_session core).
// ---------------------------------------------------------------------------

export async function listLiveEntries(env: NodeJS.ProcessEnv = process.env): Promise<RegistryEntry[]> {
  const file = await readRegistry(env)
  const cutoff = Date.now() - STALE_ENTRY_TTL_MS
  return Object.values(file.sessions)
    .filter((e) => e.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface LookupResult {
  status: "ok" | "missing" | "ambiguous"
  /** How the ok match was made: current name, or the renamedFrom trail. */
  via?: "name" | "renamedFrom"
  entries: RegistryEntry[]
  near: RegistryEntry[]
  allNames: string[]
}

/**
 * Resolve a session NAME against live entries. Exact match on the current
 * name is case-insensitive; if no current name matches, the capped
 * `renamedFrom` trail is consulted so peers holding a stale name still
 * re-resolve (reported via `via: "renamedFrom"`). Anything else fails with
 * candidates, never guesses.
 */
export function lookupByName(entries: RegistryEntry[], rawName: string, selfSessionId?: string): LookupResult {
  const query = rawName.trim().toLowerCase()
  const pool = entries.filter((e) => selfSessionId === undefined || e.sessionId !== selfSessionId)
  const nameOf = (e: RegistryEntry) => (e.name ?? "").trim().toLowerCase()
  const exact = pool.filter((e) => query.length > 0 && nameOf(e) === query)
  if (exact.length === 1) return { status: "ok", via: "name", entries: exact, near: [], allNames: [] }
  const trail = pool.filter(
    (e) => query.length > 0 && (e.renamedFrom ?? []).some((n) => n.trim().toLowerCase() === query),
  )
  if (trail.length === 1) {
    return { status: "ok", via: "renamedFrom", entries: trail, near: [], allNames: [] }
  }
  const near = pool.filter(
    (e) =>
      query.length > 0 &&
      nameOf(e).length > 0 &&
      (nameOf(e).includes(query) || query.includes(nameOf(e))),
  )
  return {
    status: exact.length > 1 || trail.length > 1 ? "ambiguous" : "missing",
    entries: exact.length > 0 ? exact : trail,
    near: exact.length > 1 || trail.length > 1 ? [] : near,
    allNames: pool.map((e) => e.name ?? "(unnamed)"),
  }
}

function formatEntryBrief(e: RegistryEntry, now: number): string {
  const ageMin = Math.max(0, Math.floor((now - e.updatedAt) / 60_000))
  const lines = [
    `- sessionId: ${e.sessionId}`,
    `  name: ${e.name ?? "(unnamed)"}`,
    `  directory: ${e.directory}`,
    `  summary: ${e.summary}`,
    `  device: ${e.deviceName ?? "unknown"} | updated: ${ageMin}m ago`,
  ]
  if (e.renamedFrom && e.renamedFrom.length > 0) {
    lines.push(`  renamed from: ${e.renamedFrom.join(", ")}`)
  }
  return lines.join("\n")
}

function createFindSessionTool(deps: { log: LogFn }): SyncToolDefinition {
  return {
    name: "find_session",
    description:
      "Resolve ANOTHER session by its NAME (the session title) to its registry entry. " +
      "Returns the target's sessionId for use with `ask_session`. Exact name match, case-insensitive. " +
      "Sessions are auto-titled at birth (<project-dir>-<short-id>) when never named, so every " +
      "registered session is addressable. If the exact name matches only a session's rename trail " +
      "(it was renamed), the match is reported as renamed-from rather than failing. " +
      "Ambiguous or missing names fail with candidate lists, the tool never guesses.",
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "The peer session's name (its title, as shown in `list_sessions` output).",
        },
        includeSelf: {
          type: "boolean",
          description: "If true, include this session's own entry. Default false.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const rawName = typeof input.name === "string" ? input.name : ""
      const includeSelf = input.includeSelf === true
      try {
        const entries = await listLiveEntries()
        const result = lookupByName(entries, rawName, includeSelf ? undefined : context.sessionID)
        const now = Date.now()
        if (result.status === "ok") {
          const match = result.entries[0]
          if (!match) {
            return { content: "find_session failed: internal, ok status without a match entry" }
          }
          const prefix =
            result.via === "renamedFrom"
              ? `Match found (session was renamed; current name: "${match.name ?? "(unnamed)"}"):\n`
              : "Match found:\n"
          return { content: `${prefix}${formatEntryBrief(match, now)}` }
        }
        if (result.status === "ambiguous") {
          const list = result.entries.map((e) => formatEntryBrief(e, now)).join("\n")
          return {
            content:
              `Ambiguous name "${rawName}" matches ${result.entries.length} sessions. ` +
              `Pick one explicitly by sessionId, do not guess:\n${list}`,
          }
        }
        const nearList = result.near.length
          ? result.near.map((e) => formatEntryBrief(e, now)).join("\n")
          : result.allNames.length
            ? result.allNames.slice(0, 20).map((n) => `- ${n}`).join("\n")
            : "(no live sessions registered)"
        return {
          content:
            `No session named "${rawName}". ` +
            (result.near.length ? "Near matches (verify before use):\n" : "Known live session names:\n") +
            nearList,
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.log("find_session:fail", { error: msg })
        return { content: `find_session failed: ${msg}` }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Inbox: deliver ask_session questions targeted at entries this plugin owns.
// Same wire protocol as the git plugin's InboxWatcher (one .req.json per
// question, one .res.json per answer); ownership is keyed on daemonId, so
// each question is processed by exactly one watcher.
// ---------------------------------------------------------------------------

interface FileRequest {
  requestId: string
  toSessionId: string
  question: string
  createdAt: number
}

interface FileResponse {
  requestId: string
  reply?: string
  error?: string
  createdAt: number
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value), "utf8")
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/** Abortable delay with listener cleanup (no leaked per-poll listeners). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error("Aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Polling send-and-wait (same rationale as the git plugin's
 * askAndWaitForReply: the plugin API offers no reliable completion signal,
 * so the reply is polled with abort + deadline). Sends via
 * `session.prompt`, then polls `session.context` for the newest assistant
 * message created after the send.
 */
async function askAndWaitForReply(
  session: SyncPluginContext["session"],
  targetSessionId: string,
  question: string,
  timeoutMs: number,
  abort: AbortSignal | undefined,
): Promise<string> {
  const sentAt = Date.now()
  await session.prompt({ sessionID: targetSessionId, text: question })
  const deadline = sentAt + timeoutMs
  while (true) {
    if (abort?.aborted) throw new Error("Aborted")
    await delay(RESPONSE_POLL_MS, abort)
    if (Date.now() >= deadline) {
      throw new Error(`Session ${targetSessionId} did not respond within ${timeoutMs}ms`)
    }
    const items = await session.context({ sessionID: targetSessionId })
    const candidates = items
      .map((raw) => (raw ?? {}) as Record<string, unknown>)
      .filter((m) => m.type === "assistant")
      .map((m) => {
        const time = (m.time ?? {}) as Record<string, unknown>
        const created = typeof time.created === "number"
          ? time.created
          : typeof time.created === "string" && time.created !== ""
            ? Number(time.created)
            : 0
        return { created, content: m.content }
      })
      .filter((m) => m.created >= sentAt)
    if (candidates.length === 0) continue
    const last = candidates.reduce((a, b) => (a.created >= b.created ? a : b))
    const parts = Array.isArray(last.content) ? last.content : []
    const text = parts
      .map((p) => (p ?? {}) as Record<string, unknown>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
    if (text.length > 0) return text
  }
}

// startInbox is exported as a test seam (the git plugin injects `env` for the
// same reason): the validation harness exercises routing against a temp
// registry without a live daemon.
export function startInbox(
  ctx: SyncPluginContext,
  deps: SyncDeps,
  env: NodeJS.ProcessEnv,
  onDispose: (task: () => Promise<void>) => void,
): void {
  const processing = new Set<string>()
  let disposed = false
  const tick = async (): Promise<void> => {
    if (disposed) return
    let files: string[]
    try {
      files = await fs.readdir(getMessagesDir(env))
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith(".req.json")) continue
      const requestId = file.replace(".req.json", "")
      if (processing.has(requestId)) continue
      if (files.includes(`${requestId}.res.json`)) continue
      let req: FileRequest | null
      try {
        req = JSON.parse(await fs.readFile(join(getMessagesDir(env), file), "utf8")) as FileRequest
      } catch {
        continue
      }
      if (!req?.toSessionId || !req.question) continue
      let entry: RegistryEntry | undefined
      try {
        entry = (await readRegistry(env)).sessions[req.toSessionId]
      } catch (err: unknown) {
        deps.log("inbox:registry-read-fail", {
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      if (!entry?.daemonId || entry.daemonId !== deps.daemonId) continue
      processing.add(requestId)
      void (async () => {
        deps.log("inbox:processing", { requestId, toSessionId: req.toSessionId })
        let response: FileResponse
        try {
          const reply = await askAndWaitForReply(
            ctx.session,
            req.toSessionId,
            req.question,
            INBOX_REQUEST_TIMEOUT_MS,
            undefined,
          )
          response = { requestId, reply, createdAt: Date.now() }
          deps.log("inbox:responded", { requestId, replyChars: reply.length })
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          response = { requestId, error: errMsg, createdAt: Date.now() }
          deps.log("inbox:process-error", { requestId, error: errMsg })
        }
        await writeJsonAtomic(join(getMessagesDir(env), `${requestId}.res.json`), response).catch(() => {})
        processing.delete(requestId)
      })()
    }
  }
  const timer = setInterval(() => void tick(), INBOX_POLL_MS)
  timer.unref?.()
  onDispose(async () => {
    disposed = true
    clearInterval(timer)
  })
}

// ---------------------------------------------------------------------------
// Plugin entrypoint.
// ---------------------------------------------------------------------------

const PLUGIN_ID = "session-registry-sync"

async function setup(rawCtx: SyncPluginContext): Promise<() => Promise<void>> {
  const ctx = rawCtx
  const env = process.env
  const stateDir = getStateDir(env)
  const deps: SyncDeps = {
    daemonId: randomUUID(),
    deviceName: hostname(),
    log: createLogger(stateDir),
    heartbeat: heartbeatMs(env),
  }
  const titleAttempts = new Set<string>()
  const sessionGet = ctx.session.get
  const sessionUpdate = ctx.session.update
  if (typeof sessionGet === "function" && typeof sessionUpdate === "function") {
    deps.titleAttempts = titleAttempts
    deps.claimSessionTitle = async (sessionId, candidate) => {
      const info = (await sessionGet.call(ctx.session, { sessionID: sessionId })) as
        | { title?: unknown }
        | undefined
      const current = typeof info?.title === "string" ? info.title.trim() : ""
      if (current.length > 0) return current
      await sessionUpdate.call(ctx.session, { sessionID: sessionId, title: candidate })
      return candidate
    }
    deps.describeSession = async (sessionId) => {
      const info = (await sessionGet.call(ctx.session, { sessionID: sessionId })) as
        | {
            title?: unknown
            projectID?: unknown
            directory?: unknown
            location?: { directory?: unknown }
          }
        | undefined
      const title = typeof info?.title === "string" ? info.title : ""
      const locationDirectory =
        info?.location && typeof info.location === "object"
          ? (info.location as Record<string, unknown>).directory
          : undefined
      const directory =
        typeof locationDirectory === "string" && locationDirectory.length > 0
          ? locationDirectory
          : typeof info?.directory === "string"
            ? info.directory
            : ""
      const projectId = typeof info?.projectID === "string" ? info.projectID : ""
      return { title, directory, projectId }
    }
  } else {
    deps.log("autotitle:unavailable", {})
  }
  deps.log("plugin:init", { daemonId: deps.daemonId, device: deps.deviceName })

  const disposeTasks: Array<() => Promise<void>> = []
  const onDispose = (task: () => Promise<void>): void => {
    disposeTasks.push(task)
  }

  // Event loop: session.created / session.updated / session.deleted -> registry.
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) return
        const outcome = await handleSessionEvent(event, deps)
        if (outcome && outcome.action !== "skipped") {
          deps.log(`event:${outcome.action}`, { sessionId: outcome.sessionId, name: outcome.name })
        }
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        deps.log("event:stream-fail", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })()
  onDispose(async () => {
    controller.abort()
  })

  // Inbox watcher for entries this plugin owns.
  startInbox(ctx, deps, env, onDispose)

  // Name-based lookup tool.
  await ctx.tool.transform((editor) => {
    editor.add(createFindSessionTool(deps))
  })

  return async () => {
    for (const task of disposeTasks) {
      await task().catch((err: unknown) => {
        deps.log("dispose:fail", { error: err instanceof Error ? err.message : String(err) })
      })
    }
    deps.log("plugin:dispose")
  }
}

export default {
  id: PLUGIN_ID,
  setup,
}
