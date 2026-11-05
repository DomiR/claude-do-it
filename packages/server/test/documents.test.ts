import { afterEach, expect, test } from "bun:test"
import { COMPACT_KEEP, appendBlock, replaceUnique } from "@do-it/doc"
import { Effect, Stream } from "effect"
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Auth } from "../src/auth"
import { DocumentRegistry } from "../src/documents"
import { watchDocument } from "../src/handlers"
import { Log } from "../src/log"
import { Versions } from "../src/versions"
import { isolateDaemonEnvironment } from "../../client/test/environment"

isolateDaemonEnvironment()
const fixtures: Array<{ home: string; registry: DocumentRegistry }> = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "do-it-documents-"))
  const log = new Log(home)
  const versions = new Versions(home, log)
  const registry = new DocumentRegistry(versions, log)
  fixtures.push({ home, registry })
  let counter = 0
  return { home, log, versions, registry, file(text = "# Tasks\n- [ ] ship\n") {
    const path = join(home, `${counter++}.md`)
    writeFileSync(path, text)
    return path
  } }
}
afterEach(() => {
  for (const { home, registry } of fixtures.splice(0)) {
    registry.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("a slow watch pull coalesces a burst into one Change from A to N", async () => {
  const { registry, file } = fixture()
  const path = file()
  const entry = registry.get(path)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pull = yield* Stream.toPull(watchDocument(registry, { path, text: true }))
    expect(yield* pull).toEqual([{ _tag: "Watching", version: 1, text: entry.doc.text }])
    expect(entry.watchers).toBe(1)
    for (let i = 0; i < 20; i++) {
      const previous = entry.doc.version
      entry.doc.agentEdit({ kind: "agent", name: "burst" }, { version: previous }, text => appendBlock(text, `note ${i}`))
      registry.changed(entry, previous)
    }
    const result = yield* pull
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ _tag: "Change", from: 1, to: 21, by: [{ _tag: "Agent", name: "burst" }], text: entry.doc.text })
    if (result[0]._tag === "Change") expect(result[0].diff).toContain("+note 19")
    // A new pull subscribes to the fresh signal; it cannot lose this next edit.
    yield* Effect.forkChild(Effect.gen(function* () {
      yield* Effect.sleep(5)
      const previous = entry.doc.version
      entry.doc.userEdit(previous, `${entry.doc.text}next\n`)
      registry.changed(entry, previous)
    }))
    expect((yield* pull)[0]).toMatchObject({ _tag: "Change", from: 21, to: 22, by: [{ _tag: "User" }] })
  })))
  expect(entry.watchers).toBe(0)
  expect(registry.totalWatchers).toBe(0)
})

test("watch resyncs forgotten history as its first event and includes full text for a section", async () => {
  const { registry, file } = fixture()
  const path = file("## A\na\n## B\nb\n")
  const entry = registry.get(path)
  for (let i = 0; i < COMPACT_KEEP + 1; i++) {
    const previous = entry.doc.version
    entry.doc.userEdit(previous, `${entry.doc.text}note ${i}\n`)
    registry.changed(entry, previous)
  }
  registry.flush(entry)
  entry.doc.compact(0, 0)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pull = yield* Stream.toPull(watchDocument(registry, { path, since: 1, section: "a", text: true }))
    expect(yield* pull).toEqual([{ _tag: "Resync", version: entry.doc.version, text: entry.doc.text }])
  })))
})

test("watch starts with Watching for kept history and then delivers the change", async () => {
  const { registry, file } = fixture()
  const path = file()
  const entry = registry.get(path)
  entry.doc.userEdit(1, `${entry.doc.text}before\n`)
  registry.changed(entry, 1)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pull = yield* Stream.toPull(watchDocument(registry, { path, since: 1, text: false }))
    expect(yield* pull).toEqual([{ _tag: "Watching", version: 2 }])
    expect(yield* pull).toMatchObject([{ _tag: "Change", from: 1, to: 2 }])
  })))
})

for (const text of [false, true]) {
  test(`watch resyncs a future version and delivers the next change (text: ${text})`, async () => {
    const { registry, file } = fixture()
    const path = file()
    const entry = registry.get(path)
    const version = entry.doc.version
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pull = yield* Stream.toPull(watchDocument(registry, { path, since: version + 5, text }))
      expect(yield* pull).toEqual([{ _tag: "Resync", version, ...(text ? { text: entry.doc.text } : {}) }])
      entry.doc.userEdit(version, `${entry.doc.text}next\n`)
      registry.changed(entry, version)
      const event = (yield* pull)[0]
      expect(event).toMatchObject({ _tag: "Change", from: version, to: version + 1, by: [{ _tag: "User" }] })
      if (text) expect(event).toHaveProperty("text", entry.doc.text)
      else expect(event).not.toHaveProperty("text")
    })).pipe(Effect.timeout(1000)))
    expect(entry.watchers).toBe(0)
  })
}

test("all three writers survive when disk changes during the write debounce", () => {
  const { registry, file } = fixture()
  const base = "# Todo\n- [ ] alpha\n- [ ] beta\n"
  const path = file(base)
  const entry = registry.get(path)
  entry.doc.userEdit(1, base.replace("alpha", "alpha USER"))
  registry.changed(entry, 1)
  entry.doc.agentEdit({ kind: "agent", name: "agent" }, { version: 2 }, text => replaceUnique(text, "beta", "beta AGENT"))
  registry.changed(entry, 2)
  writeFileSync(path, "# Todo\n- [ ] alpha\n- [x] beta\n- [ ] gamma\n")
  registry.flush(entry)
  expect(entry.doc.text).toBe("# Todo\n- [ ] alpha USER\n- [x] beta AGENT\n- [ ] gamma\n")
  expect(readFileSync(path, "utf8")).toBe(entry.doc.text)
  expect(entry.doc.version).toBe(4)
  expect(entry.doc.origin(4)).toEqual({ kind: "file" })
  registry.poll(entry)
  expect(entry.doc.version).toBe(4)
})

test("transient disappearance is tolerated and a missing file is never recreated by a pending write", async () => {
  const { registry, file } = fixture()
  const path = file("old\n")
  const entry = registry.get(path)
  entry.doc.userEdit(1, "new\n")
  registry.changed(entry, 1)
  unlinkSync(path)
  registry.flush(entry)
  expect(existsSync(path)).toBe(false)
  writeFileSync(path, "old\n")
  registry.poll(entry)
  await Bun.sleep(550)
  expect(entry.deleted).toBe(false)
  expect(readFileSync(path, "utf8")).toBe("new\n")
})

test("64 open documents evict the oldest idle document, but never one with subscribers", () => {
  const { registry, file } = fixture()
  const first = registry.get(file())
  first.lastUsed = 0
  for (let i = 1; i < 64; i++) registry.get(file())
  registry.get(file())
  expect(registry.status()).toHaveLength(64)
  expect(registry.status().some(entry => entry.path === first.path)).toBe(false)
  const releases = registry.status().map(entry => registry.subscribe(registry.get(entry.path)))
  expect(() => registry.get(file())).toThrow(expect.objectContaining({ _tag: "Refused", code: "too-large" }))
  for (const release of releases) release()
})

test("subscriber counts are capped per document and globally, and release restores capacity", () => {
  const { registry, file } = fixture()
  const entries = Array.from({ length: 9 }, () => registry.get(file()))
  const releases: Array<() => void> = []
  for (const entry of entries.slice(0, 8)) {
    for (let i = 0; i < 32; i++) releases.push(registry.subscribe(entry))
    expect(() => registry.subscribe(entry)).toThrow(expect.objectContaining({ _tag: "Refused", code: "too-large" }))
  }
  expect(registry.totalWatchers).toBe(256)
  expect(() => registry.subscribe(entries[8]!)).toThrow(expect.objectContaining({ _tag: "Refused", code: "too-large" }))
  releases.pop()!()
  const release = registry.subscribe(entries[8]!)
  release()
  for (const release of releases) release()
  expect(registry.totalWatchers).toBe(0)
})

test("versions persist at most 256 LRU entries and offline changes are authored by file", () => {
  const { home, log, versions } = fixture()
  for (let i = 0; i < 256; i++) versions.record(`/notes/${i}.md`, i + 1, `text ${i}`)
  versions.record("/notes/0.md", 1, "text 0")
  versions.record("/notes/new.md", 17, "before")
  versions.flush()
  const json = JSON.parse(readFileSync(join(home, "versions.json"), "utf8"))
  expect(Object.keys(json)).toHaveLength(256)
  expect(json["/notes/0.md"]).toBeDefined()
  expect(json["/notes/1.md"]).toBeUndefined()
  const restored = new Versions(home, log)
  const same = restored.open("/notes/0.md", "text 0")
  const changed = restored.open("/notes/new.md", "after")
  try {
    expect(same.version).toBe(1)
    expect(changed.version).toBe(18)
    expect(changed.origin(18)).toEqual({ kind: "file" })
    expect(changed.textAt(17)).toBeNull()
  } finally { same.free(); changed.free(); restored.flush() }
})

test("auth caps codes, expires them after five minutes, and keeps cookies across restarts", () => {
  const { home } = fixture()
  const auth = new Auth(home)
  const codes = Array.from({ length: 64 }, () => auth.mint("/notes.md", 1000))
  expect(() => auth.mint("/notes.md", 1000)).toThrow(expect.objectContaining({ code: "too-large" }))
  expect(auth.consume(codes[0]!, "/different.md", 2000)).toBe(false)
  expect(auth.consume(codes[0]!, "/notes.md", 2000)).toBe(true)
  expect(auth.consume(codes[0]!, "/notes.md", 2000)).toBe(false)
  expect(auth.consume(codes[1]!, "/notes.md", 301000)).toBe(false)
  expect(auth.mint("/notes.md", 301000)).toHaveLength(64)
  const restarted = new Auth(home)
  expect(restarted.token).toBe(auth.token)
  expect(restarted.cookie).toBe(auth.cookie)
  expect(restarted.authorized(undefined, auth.cookie)).toBe(true)
  expect(restarted.authorized(undefined, auth.token)).toBe(false)
})

test("log rotation keeps one old file", () => {
  const { home, log } = fixture()
  const path = join(home, "daemon.log")
  writeFileSync(path, "a".repeat(1024 * 1024))
  log.write("first")
  expect(readFileSync(`${path}.old`, "utf8").length).toBe(1024 * 1024)
  expect(readFileSync(path, "utf8")).toContain("first")
  writeFileSync(path, "b".repeat(1024 * 1024))
  log.write("second")
  expect(readFileSync(`${path}.old`, "utf8")[0]).toBe("b")
  expect(readFileSync(path, "utf8")).toContain("second")
  const inherited = openSync(path, "a")
  try {
    writeFileSync(path, "c".repeat(1024 * 1024))
    log.rotate()
    writeFileSync(inherited, "inherited stderr\n")
    expect(readFileSync(path, "utf8")).toBe("inherited stderr\n")
    expect(readFileSync(`${path}.old`, "utf8").length).toBe(1024 * 1024)
  } finally { closeSync(inherited) }
})
