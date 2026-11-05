import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { LoroDoc, LoroText } from "loro-crdt"
import { COMPACT_KEEP, Document, DocError, KEPT, MAX_BYTES, addTodo, describeOrigin, findTodo,
  replaceUnique, setTodoState, type Origin, type WriteTicket } from "../src"
import type { History } from "../src/version"

const agent: Origin = { kind: "agent", name: "worker" }
const opened: Document[] = []
function open(text: string, version?: number): Document {
  const doc = Document.open(text, version)
  opened.push(doc)
  return doc
}
function internals(doc: Document) {
  return doc as unknown as { doc: LoroDoc; history: History; writing: WriteTicket[] }
}
function peers(doc: Document): number {
  const vv = internals(doc).doc.oplogVersion()
  try { return vv.length() } finally { vv.free() }
}
function edit(doc: Document, old: string, next: string, origin = agent) {
  return doc.agentEdit(origin, { version: doc.version }, text => replaceUnique(text, old, next))
}
function error(action: () => unknown, code: DocError["code"]): DocError {
  try { action() } catch (error) {
    expect(error).toBeInstanceOf(DocError)
    expect((error as DocError).code).toBe(code)
    return error as DocError
  }
  throw new Error(`Expected ${code}`)
}
afterEach(() => { for (const doc of opened.splice(0)) doc.free() })

test("forkAt gives every fork a fresh peer", () => {
  const doc = new LoroDoc()
  const body = doc.getText("markdown")
  body.insert(0, "base")
  doc.commit()
  const a = doc.forkAt(doc.frontiers())
  const b = doc.forkAt(doc.frontiers())
  try {
    expect(a.peerIdStr).not.toBe(doc.peerIdStr)
    expect(b.peerIdStr).not.toBe(doc.peerIdStr)
    expect(a.peerIdStr).not.toBe(b.peerIdStr)
  } finally { a.free(); b.free(); body.free(); doc.free() }
})

describe("versions and strict edits", () => {
  test("opens at 1 or N, starts synced, every visible change takes the next version", () => {
    const doc = open("one\ntwo\n")
    expect(doc.version).toBe(1)
    expect(open("x", 41).version).toBe(41)
    expect(doc.origin(1)).toBeNull()
    expect(doc.synced).toEqual({ text: doc.text, version: 1 })
    expect(doc.dirty).toBe(false)
    expect(doc.userEdit(1, "ONE\ntwo\n")).toEqual({ version: 2, changed: true, others: null })
    expect(edit(doc, "two", "TWO").version).toBe(3)
    doc.wrote(doc.toWrite())
    expect(doc.mergeFile("ONE\nTWO\nfile\n")).toBe(true)
    expect(doc.version).toBe(4)
    expect(doc.origin(2)).toEqual({ kind: "user" })
    expect(doc.origin(3)).toEqual(agent)
    expect(doc.origin(4)).toEqual({ kind: "file" })
    expect(doc.origin(99)).toBeNull()
    expect(edit(doc, "file", "file").changed).toBe(false)
    expect(doc.userEdit(4, doc.text).changed).toBe(false)
    expect(doc.mergeFile(doc.text)).toBe(false)
    expect(doc.version).toBe(4)
    expect(describeOrigin({ kind: "user" })).toBe("the user")
    expect(describeOrigin(agent)).toBe("worker")
    expect(describeOrigin({ kind: "file" })).toBe("file")
  })

  test("stale edits refuse before calling make and return the exact conflict", () => {
    const doc = open("one\ntwo\n")
    doc.userEdit(1, "one\nTWO two\n")
    let called = false
    const failure = error(() => doc.agentEdit(agent, { version: 1 }, () => {
      called = true
      return [{ from: 0, to: 0, insert: "nope" }]
    }), "conflict")
    expect(called).toBe(false)
    expect(failure.conflict).toEqual({ expected: 1, current: 2, forgotten: false,
      diff: doc.changes(1)!.diff })
    expect(failure.conflict!.diff).toContain("-two\n+TWO two\n")
    expect(doc.text).toBe("one\nTWO two\n")
    expect(doc.version).toBe(2)
  })

  test("the ring holds at most KEPT versions, older and future versions are forgotten", () => {
    const doc = open("a")
    for (let i = 0; i < KEPT + 2; i++) {
      doc.userEdit(doc.version, doc.text + "x")
      expect(internals(doc).history.size).toBeLessThanOrEqual(KEPT)
    }
    expect(internals(doc).history.size).toBe(KEPT)
    expect(doc.textAt(1)).toBeNull()
    expect(doc.textAt(doc.version - KEPT)).toBeNull()
    expect(doc.textAt(doc.version - KEPT + 1)).not.toBeNull()
    expect(doc.changes(1)).toBeNull()
    expect(doc.origin(1)).toBeNull()
    for (const expected of [1, 999_999]) {
      const failure = error(() => doc.agentEdit(agent, { version: expected }, () => []), "conflict")
      expect(failure.conflict).toEqual({ expected, current: doc.version, diff: null, forgotten: true })
      error(() => doc.userEdit(expected, doc.text), "forgotten")
    }
  })

  test("changes deduplicate origins in first occurrence order and isolate caller mutations", () => {
    const doc = open("a\n")
    const mutable = { kind: "agent" as const, name: "worker" }
    edit(doc, "a", "ab", mutable)
    mutable.name = "changed outside"
    doc.userEdit(doc.version, "abc\n")
    edit(doc, "abc", "abcd")
    doc.wrote(doc.toWrite())
    doc.mergeFile("abcde\n")
    expect(doc.changes(1)!.by).toEqual([agent, { kind: "user" }, { kind: "file" }])
    expect(doc.changes(doc.version)).toEqual({ from: doc.version, to: doc.version, by: [], diff: "", todos: [] })
  })

  test("invalid and oversize edits leave text, version, and oplog unchanged", () => {
    const doc = open("😀中hello")
    const initialOps = internals(doc).doc.opCount()
    for (const edits of [
      [{ from: -1, to: 0, insert: "x" }],
      [{ from: 1, to: 2, insert: "x" }],
      [{ from: 0.5, to: 2, insert: "x" }],
      [{ from: 0, to: 99, insert: "x" }],
      [{ from: 3, to: 5, insert: "x" }, { from: 4, to: 5, insert: "y" }],
    ]) error(() => doc.agentEdit(agent, { version: 1 }, () => edits), "invalid")
    const huge = "x".repeat(MAX_BYTES + 1)
    error(() => Document.open(huge), "too-large")
    error(() => doc.userEdit(1, huge), "too-large")
    error(() => doc.mergeFile(huge), "too-large")
    error(() => doc.agentEdit(agent, { version: 1 }, () => [{ from: 0, to: 0, insert: huge }]), "too-large")
    error(() => Document.open("中".repeat(Math.floor(MAX_BYTES / 3) + 1)), "too-large")
    error(() => Document.open("\ud800"), "invalid")
    for (const v of [0, -1, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) error(() => Document.open("x", v), "invalid")
    expect(doc.text).toBe("😀中hello")
    expect(doc.version).toBe(1)
    expect(internals(doc).doc.opCount()).toBe(initialOps)
  })

  test("unsorted agent edits use original UTF-16 offsets and one version", () => {
    const doc = open("😀中alpha漢🙂beta尾")
    doc.agentEdit(agent, { version: 1 }, text => [
      { from: text.indexOf("beta"), to: text.indexOf("beta") + 4, insert: "乙🚀" },
      { from: text.indexOf("alpha"), to: text.indexOf("alpha") + 5, insert: "甲✨" },
    ])
    expect(doc.text).toBe("😀中甲✨漢🙂乙🚀尾")
    expect(doc.version).toBe(2)
    doc.userEdit(2, "😀中甲✨漢🐱乙🚀尾")
    expect(doc.text).toBe("😀中甲✨漢🐱乙🚀尾")
    expect(doc.textAt(1)).toBe("😀中alpha漢🙂beta尾")
  })
})

describe("section scope", () => {
  const initial = "# One\n- [ ] a\n# Two\n- [ ] b\n"
  test("unchanged stale section applies against current text with others diff", () => {
    const doc = open(initial)
    doc.agentEdit(agent, { version: 1, section: "one" }, text => addTodo(text, "a2", "one"))
    const priorDiff = doc.changes(1)!.diff
    let madeFrom = ""
    const result = doc.agentEdit({ kind: "agent", name: "second" }, { version: 1, section: "two" }, text => {
      madeFrom = text
      return addTodo(text, "b2", "two")
    })
    expect(madeFrom).toContain("a2")
    expect(result).toEqual({ version: 3, changed: true, others: { since: 1, diff: priorDiff } })
    expect(doc.text).toBe("# One\n- [ ] a\n- [ ] a2\n# Two\n- [ ] b\n- [ ] b2\n")
  })
  test("changed stale sections conflict, unknown sections are not-found even at current", () => {
    const doc = open(initial)
    edit(doc, "a\n", "changed\n")
    error(() => doc.agentEdit(agent, { version: 1, section: "one" }, () => []), "conflict")
    for (const version of [1, 2]) error(() => doc.agentEdit(agent, { version, section: "missing" }, () => []), "not-found")
    expect(doc.version).toBe(2)
  })
  test("section changes retain global todo numbers, including removed sections", () => {
    const doc = open(initial)
    doc.agentEdit(agent, { version: 1 }, text => setTodoState(text, findTodo(text, 2), "done"))
    expect(doc.changes(1, "one")!.diff).toBe("")
    expect(doc.changes(1, "one")!.todos).toEqual([])
    expect(doc.changes(1, "two")!.todos[0]).toMatchObject({ kind: "checked", number: 2 })
    expect(doc.changes(1, "two")!.diff).not.toContain("# One")
    doc.userEdit(2, "# One\n- [ ] a\n")
    expect(doc.changes(2, "two")!.todos).toEqual([{ kind: "removed", number: 2, text: "b", line: 3, oldLine: 3 }])
    expect(doc.changes(2, "two")!.diff).toContain("-# Two")
    expect(doc.changes(2, "missing")!.diff).toBe("")
  })
})

describe("user and file merges", () => {
  test("current edits use the main peer, agent peers are stable", () => {
    const doc = open("a\n")
    const initialPeer = internals(doc).doc.peerIdStr
    const forks = spyOn(LoroDoc.prototype, "fork")
    const oldForks = spyOn(LoroDoc.prototype, "forkAt")
    try {
      doc.userEdit(1, "ab\n")
      doc.userEdit(2, "abc\n")
      expect(peers(doc)).toBe(1)
      expect(internals(doc).doc.peerIdStr).toBe(initialPeer)
      expect(forks).not.toHaveBeenCalled()
      expect(oldForks).not.toHaveBeenCalled()
      edit(doc, "abc", "abcd")
      edit(doc, "abcd", "abcde")
      expect(peers(doc)).toBe(2)
      expect(forks).toHaveBeenCalledTimes(2)
    } finally { forks.mockRestore(); oldForks.mockRestore() }
  })
  test("stale user edits preserve agent and other user edits", () => {
    const doc = open("alpha\nbeta\ngamma\n")
    edit(doc, "beta", "BETA")
    doc.userEdit(1, "alpha USER\nbeta\ngamma\n")
    expect(doc.text).toBe("alpha USER\nBETA\ngamma\n")
    doc.userEdit(1, "alpha\nbeta\ngamma SECOND\n")
    expect(doc.text).toBe("alpha USER\nBETA\ngamma SECOND\n")
    expect(doc.version).toBe(4)
    expect(peers(doc)).toBe(4)
    expect(doc.userEdit(1, "alpha\nbeta\ngamma\n").changed).toBe(false)
    expect(doc.version).toBe(4)
  })
  test("stale Unicode edits on the same line retain both writers", () => {
    const base = "😀中alpha漢🙂beta尾\n"
    const doc = open(base)
    edit(doc, "alpha", "甲")
    doc.userEdit(1, base.replace("beta", "乙🚀"))
    expect(doc.text).toBe("😀中甲漢🙂乙🚀尾\n")
  })
  test("a person types inside a line an agent edited elsewhere in that line", () => {
    const base = "one\nthe quick fox jumps\nthree\n"
    const doc = open(base)
    edit(doc, "quick", "slow")
    doc.userEdit(1, base.replace("fox", "fox USER"))
    expect(doc.text).toBe("one\nthe slow fox USER jumps\nthree\n")
    expect(doc.version).toBe(3)
  })
  test("concurrent insertions at the same position retain both writers", () => {
    const doc = open("one two three\n")
    doc.userEdit(1, "one USER two three\n")
    doc.mergeFile("one DISK two three\n")
    expect(doc.text).toContain("USER ")
    expect(doc.text).toContain("DISK ")
    expect(doc.text.startsWith("one ")).toBe(true)
    expect(doc.text.endsWith("two three\n")).toBe(true)
  })
  test("concurrent identical deletions take no extra visible version", () => {
    const doc = open("one\ntwo\nthree\n")
    edit(doc, "two\n", "")
    expect(doc.userEdit(1, "one\nthree\n")).toEqual({ version: 2, changed: false, others: null })
    expect(doc.mergeFile("one\nthree\n")).toBe(false)
    expect(doc.version).toBe(2)
    expect(doc.dirty).toBe(false)
  })
  test("a file checking beta and adding gamma merges exactly with user and agent edits", () => {
    const base = "# Todo\n- [ ] alpha\n- [ ] beta\n"
    const doc = open(base)
    doc.userEdit(1, base.replace("alpha", "alpha USER"))
    edit(doc, "beta", "beta AGENT")
    expect(doc.mergeFile(base.replace("[ ] beta", "[x] beta") + "- [ ] gamma\n")).toBe(true)
    expect(doc.text).toBe("# Todo\n- [ ] alpha USER\n- [x] beta AGENT\n- [ ] gamma\n")
    expect(doc.version).toBe(4)
    expect(doc.synced.version).toBe(1)
    expect(doc.dirty).toBe(true)
    expect(doc.mergeFile(doc.synced.text + "- [ ] delta\n")).toBe(true)
    expect(doc.text).toBe("# Todo\n- [ ] alpha USER\n- [x] beta AGENT\n- [ ] gamma\n- [ ] delta\n")
    expect(doc.version).toBe(5)
  })
  test("independent file, user and agent regions merge, then merge again from disk", () => {
    const base = "# Todo\n- [ ] alpha\n- [ ] beta\n"
    const doc = open(base)
    doc.userEdit(1, base.replace("alpha", "alpha USER"))
    edit(doc, "# Todo", "# Tasks (agent)")
    expect(doc.mergeFile(base.replace("[ ] beta", "[x] beta") + "- [ ] gamma\n")).toBe(true)
    expect(doc.text).toBe("# Tasks (agent)\n- [ ] alpha USER\n- [x] beta\n- [ ] gamma\n")
    expect(doc.synced.version).toBe(1)
    expect(doc.dirty).toBe(true)
    expect(doc.mergeFile(doc.synced.text + "- [ ] delta\n")).toBe(true)
    expect(doc.text).toBe("# Tasks (agent)\n- [ ] alpha USER\n- [x] beta\n- [ ] gamma\n- [ ] delta\n")
    expect(doc.version).toBe(5)
  })
  test("a synced current file updates the main doc without a fork", () => {
    const doc = open("one\n")
    const forks = spyOn(LoroDoc.prototype, "forkAt")
    try {
      doc.mergeFile("two\n")
      doc.mergeFile("three\n")
      expect(forks).not.toHaveBeenCalled()
      expect(peers(doc)).toBe(1)
      expect(doc.dirty).toBe(false)
    } finally { forks.mockRestore() }
  })
  test("own writes and writes in flight do not echo or take versions", () => {
    const doc = open("base\n")
    doc.userEdit(1, "a base\n")
    const ticket = doc.toWrite()
    doc.userEdit(2, "ab base\n")
    expect(doc.mergeFile(ticket.text)).toBe(false)
    expect(doc.version).toBe(3)
    expect(doc.text).toBe("ab base\n")
    expect(doc.synced).toEqual({ text: ticket.text, version: 2 })
    doc.wrote(ticket)
    expect(doc.dirty).toBe(true)
    const latest = doc.toWrite()
    doc.wrote(latest)
    expect(doc.mergeFile(latest.text)).toBe(false)
    expect(doc.version).toBe(3)
    expect(doc.dirty).toBe(false)
  })
  test("recognizes current text and remembers no more than eight writes", () => {
    const doc = open("a")
    for (let i = 0; i < 12; i++) { doc.userEdit(doc.version, doc.text + "x"); doc.toWrite() }
    expect(internals(doc).writing.length).toBe(8)
    const ticket = doc.toWrite()
    doc.notWritten(ticket)
    expect(internals(doc).writing.length).toBe(7)
    const version = doc.version
    expect(doc.mergeFile(doc.text)).toBe(false)
    expect(doc.dirty).toBe(false)
    expect(doc.version).toBe(version)
    error(() => open("other").wrote(ticket), "invalid")
  })
  test("oversize merged results are refused atomically, including external files", () => {
    // Both branches fit individually; their independent insertions do not.
    // Use bounded lines so the diff refines just the insertion points rather
    // than deliberately replacing an entire 2 MiB line on each branch.
    const line = "x".repeat(1023) + "\n"
    const base = line.repeat(2047) + "x".repeat(1016)
    expect(new TextEncoder().encode(base).length).toBe(MAX_BYTES - 8)
    for (const external of [false, true]) {
      const doc = open(base)
      doc.userEdit(1, "USER!" + base)
      const before = doc.text
      const ops = internals(doc).doc.opCount()
      const frees = spyOn(LoroDoc.prototype, "free")
      try {
        error(() => external ? doc.mergeFile(base + "FILE!") : doc.userEdit(1, base + "USER!"), "too-large")
        expect(frees).toHaveBeenCalledTimes(1)
      } finally { frees.mockRestore() }
      expect(doc.text).toBe(before)
      expect(doc.version).toBe(2)
      expect(doc.synced.text).toBe(base)
      expect(internals(doc).doc.opCount()).toBe(ops)
    }
  })
  test("large rewrites use splices and no edit path calls Loro's whole-text update APIs", () => {
    const doc = open("a".repeat(60_000) + "\n")
    const update = spyOn(LoroText.prototype, "update").mockImplementation(() => { throw new Error("Unexpected update") })
    const byLine = spyOn(LoroText.prototype, "updateByLine").mockImplementation(() => { throw new Error("Unexpected updateByLine") })
    try {
      doc.userEdit(1, "b".repeat(60_000) + "\n")
      expect(doc.text).toBe("b".repeat(60_000) + "\n")
      doc.userEdit(2, "finished\n")
      expect(doc.text).toBe("finished\n")
      doc.wrote(doc.toWrite())
      doc.mergeFile("finished\nfile\n")
      const base = doc.version
      edit(doc, "finished", "done")
      doc.userEdit(base, "finished\nfile USER\n")
      doc.mergeFile("finished\nfile\nexternal\n")
      expect(doc.text).toBe("done\nfile USER\nexternal\n")
      expect(update).not.toHaveBeenCalled()
      expect(byLine).not.toHaveBeenCalled()
    } finally { update.mockRestore(); byLine.mockRestore() }
  })
  test("temporary forks are freed on reads, changes, edits and merges", () => {
    const doc = open("a\nb\n")
    doc.userEdit(1, "A\nb\n")
    const frees = spyOn(LoroDoc.prototype, "free")
    const forks = spyOn(LoroDoc.prototype, "forkAt")
    try {
      expect(doc.textAt(1)).toBe("a\nb\n")
      expect(doc.changes(1)!.diff).toContain("+A")
      expect(forks).toHaveBeenCalledTimes(2)
      expect(frees).toHaveBeenCalledTimes(2)
      doc.userEdit(1, "a\nB\n")
      doc.mergeFile("a\nb\nC\n")
      expect(frees).toHaveBeenCalledTimes(4)
    } finally { frees.mockRestore(); forks.mockRestore() }
  })
  test("the synced frontier remains usable after its numbered version is forgotten", () => {
    const doc = open("base\n")
    for (let i = 0; i < KEPT + 1; i++) {
      doc.userEdit(doc.version, `base\nuser ${i}\n`)
    }
    expect(doc.textAt(1)).toBeNull()
    expect(doc.mergeFile("disk\nbase\n")).toBe(true)
    expect(doc.text).toBe(`disk\nbase\nuser ${KEPT}\n`)
  })
})

describe("compaction", () => {
  test("thresholds, dirty and pending writes gate compaction, later edits still work", () => {
    const doc = open("one\ntwo\n")
    expect(doc.compact()).toBeNull()
    edit(doc, "two", "TWO")
    expect(doc.compact(0, 0)).toBeNull()
    const write = doc.toWrite()
    doc.wrote(write)
    const inFlight = doc.toWrite()
    expect(doc.compact(0, 0)).toBeNull()
    doc.notWritten(inFlight)
    const version = doc.version
    const text = doc.text
    expect(doc.compact(0, 256)).toMatchObject({ reason: "ops", kept: 2, oldest: 1 })
    expect(doc.version).toBe(version)
    expect(doc.text).toBe(text)
    expect(doc.textAt(1)).toBe("one\ntwo\n")
    expect(doc.changes(1)).not.toBeNull()
    expect(doc.textAt(version)).toBe(text)
    expect(internals(doc).history.size).toBe(2)
    doc.mergeFile("zero\n" + text)
    edit(doc, "TWO", "three")
    doc.userEdit(doc.version, doc.text + "four\n")
    expect(doc.version).toBe(version + 3)
    expect(doc.text).toBe("zero\none\nthree\nfour\n")
    expect(doc.changes(version)!.diff).toContain("+zero")
  })
  test("the peer threshold alone triggers compaction", () => {
    const doc = open("a")
    edit(doc, "a", "b")
    doc.wrote(doc.toWrite())
    expect(peers(doc)).toBe(2)
    expect(doc.compact(Number.MAX_SAFE_INTEGER, 2)).toBeNull()
    expect(doc.compact(Number.MAX_SAFE_INTEGER, 1)).toMatchObject({ reason: "peers", peers: 2 })
    expect(peers(doc)).toBe(1)
    edit(doc, "b", "c")
    expect(doc.text).toBe("c")
  })

  test("keeps the last COMPACT_KEEP versions and merges stale edits inside the window", () => {
    const doc = open("base\n")
    for (let i = 0; i < COMPACT_KEEP + 4; i++) doc.userEdit(doc.version, `${doc.text}v${i}\n`)
    const before = doc.text
    const current = doc.version
    const inside = current - COMPACT_KEEP + 1
    const older = inside - 1
    const insideText = doc.textAt(inside)
    expect(insideText).not.toBeNull()
    doc.wrote(doc.toWrite())
    expect(doc.compact(0, 0)).toMatchObject({ reason: "ops", kept: COMPACT_KEEP, oldest: inside })
    expect(doc.text).toBe(before)
    expect(doc.textAt(inside)).toBe(insideText)
    expect(doc.changes(inside)).not.toBeNull()
    expect(doc.textAt(older)).toBeNull()
    expect(doc.changes(older)).toBeNull()
    doc.userEdit(inside, `${insideText}stale\n`)
    expect(doc.text).toContain("stale\n")
  })
})
