import { describe, expect, test } from "bun:test"
import {
  applyEdits,
  findTodo,
  formatLasted,
  formatStamp,
  setTodoStateStamped,
  stampTodo,
  startedAt,
  todoChanges,
  unstampTodo,
  withoutStamps,
} from "../src"

const date = new Date(2026, 10, 4, 21, 32)

function change(text: string, edits: ReturnType<typeof stampTodo>): string {
  return applyEdits(text, edits)
}

describe("PlainTasks stamps", () => {
  test("formats local dates and stamps plain task labels", () => {
    expect(formatStamp(date)).toBe("26-11-04 21:32")
    for (const tag of ["done", "cancelled", "started"] as const) {
      const text = "- [ ] Ship\n"
      const expected = tag === "started" ? "- [ ] Ship @started(26-11-04 21:32)\n" : `- [ ] Ship @${tag} (26-11-04 21:32)\n`
      expect(change(text, stampTodo(text, findTodo(text, "Ship"), tag, date))).toBe(expected)
    }
  })

  test("replaces existing spellings without duplicating the tag", () => {
    for (const existing of ["@done(25-01-02 03:04)", "@done (25-01-02 03:04)", "@done()"]) {
      const text = `- [ ] Ship ${existing}\n`
      const next = change(text, stampTodo(text, findTodo(text, "Ship"), "done", date))
      expect(next).toBe("- [ ] Ship @done (26-11-04 21:32)\n")
      expect(next.match(/@done/g)).toHaveLength(1)
    }
  })

  test("places stamps before project tags, preserves trailing whitespace, and keeps CRLF", () => {
    const text = "- [ ] Ship @project(Tasks)   \r\n"
    expect(change(text, stampTodo(text, findTodo(text, "Ship"), "done", date))).toBe("- [ ] Ship @done (26-11-04 21:32) @project(Tasks)   \r\n")
  })

  test("keeps labels ending in t or a backslash intact", () => {
    const endingT = "- [ ] Write a test\n"
    expect(change(endingT, stampTodo(endingT, findTodo(endingT, "Write a test"), "started", date))).toBe("- [ ] Write a test @started(26-11-04 21:32)\n")
    const endingBackslash = "- [ ] Path\\\\\n"
    expect(change(endingBackslash, stampTodo(endingBackslash, findTodo(endingBackslash, "Path\\\\"), "started", date))).toBe("- [ ] Path\\\\ @started(26-11-04 21:32)\n")
  })

  test("sets every task state while keeping started and replacing state tags", () => {
    let text = "- [-] Ship @started(25-01-02 03:04) @done (25-01-02 03:04)\n"
    text = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "done", date))
    expect(text).toBe("- [x] Ship @started(25-01-02 03:04) @done (26-11-04 21:32) @lasted(671 days, 18:28)\n")
    text = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "cancelled", date))
    expect(text).toBe("- [-] Ship @started(25-01-02 03:04) @cancelled (26-11-04 21:32)\n")
    text = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "open", date))
    expect(text).toBe("- [ ] Ship @started(25-01-02 03:04)\n")
  })

  test("unstamps all supported spellings and normalizes labels for matching", () => {
    for (const existing of ["@done(25-01-02 03:04)", "@done (25-01-02 03:04)", "@done()"]) {
      const text = `- [ ] Ship @started(25-01-02 03:04) ${existing} @project(work)\n`
      expect(change(text, unstampTodo(text, findTodo(text, "Ship"), "done"))).toBe("- [ ] Ship @started(25-01-02 03:04) @project(work)\n")
    }
    expect(withoutStamps("  Ship @started(25-01-02 03:04) @cancelled (25-01-02 03:04)  ")).toBe("Ship")
  })

  test("never removes a bare tag word from the text, only stamps with parentheses", () => {
    const words = "- [ ] Ship, especially with @started, which should be set, and @done or @lasted words\n"
    const started = change(words, stampTodo(words, findTodo(words, 1), "started", date))
    expect(started).toBe("- [ ] Ship, especially with @started, which should be set, and @done or @lasted words @started(26-11-04 21:32)\n")
    const done = change(started, setTodoStateStamped(started, findTodo(started, 1), "done", date))
    expect(done).toBe("- [x] Ship, especially with @started, which should be set, and @done or @lasted words @started(26-11-04 21:32) @done (26-11-04 21:32) @lasted(0:00)\n")
    const reopened = change(done, setTodoStateStamped(done, findTodo(done, 1), "open", date))
    expect(reopened).toBe(started)
    expect(change(words, unstampTodo(words, findTodo(words, 1), "started"))).toBe(words)
    expect(withoutStamps("Ship @started, @done @started(26-11-04 21:32)")).toBe("Ship @started, @done")
  })

  test("formats how long a task lasted as PlainTasks does", () => {
    const minutes = (value: number) => value * 60_000
    expect(formatLasted(0)).toBe("0:00")
    expect(formatLasted(minutes(5))).toBe("0:05")
    expect(formatLasted(minutes(150))).toBe("2:30")
    expect(formatLasted(minutes(24 * 60))).toBe("1 day")
    expect(formatLasted(minutes(24 * 60 + 5))).toBe("1 day, 0:05")
    expect(formatLasted(minutes(26 * 60 + 30))).toBe("1 day, 2:30")
    expect(formatLasted(minutes(3 * 24 * 60))).toBe("3 days")
    expect(formatLasted(minutes(-10))).toBe("0:00")
    expect(formatLasted(59_999)).toBe("0:00")
    expect(startedAt("Ship @started(26-11-04 09:02)")).toEqual(new Date(2026, 10, 4, 9, 2))
    expect(startedAt("Ship @started")).toBeNull()
  })

  test("done adds @lasted after a start, keeps it on repeats, and unchecking or cancelling removes it", () => {
    const text = "- [ ] Ship @started(26-11-04 19:02) @project(Tasks)\n"
    let next = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "done", date))
    expect(next).toBe("- [x] Ship @started(26-11-04 19:02) @done (26-11-04 21:32) @lasted(2:30) @project(Tasks)\n")
    expect(setTodoStateStamped(next, findTodo(next, "Ship"), "done", new Date(2026, 10, 5, 9, 0))).toEqual([])
    next = change(next, setTodoStateStamped(next, findTodo(next, "Ship"), "open", date))
    expect(next).toBe(text)
    const stale = "- [ ] Ship @started(26-11-04 21:00) @lasted(9:99)\n"
    expect(change(stale, setTodoStateStamped(stale, findTodo(stale, "Ship"), "done", date)))
      .toBe("- [x] Ship @started(26-11-04 21:00) @done (26-11-04 21:32) @lasted(0:32)\n")
    const cancelled = change(stale, setTodoStateStamped(stale, findTodo(stale, "Ship"), "cancelled", date))
    expect(cancelled).toBe("- [-] Ship @started(26-11-04 21:00) @cancelled (26-11-04 21:32)\n")
    const plain = "- [ ] Ship\n"
    expect(change(plain, setTodoStateStamped(plain, findTodo(plain, "Ship"), "done", date))).toBe("- [x] Ship @done (26-11-04 21:32)\n")
    const seconds = new Date(2026, 10, 4, 21, 32, 59)
    expect(change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "done", seconds))).toContain("@lasted(2:30)")
  })

  test("task changes compare labels without stamps", () => {
    const oldText = "- [ ] Ship @started(25-01-02 03:04)\n"
    const nextText = "- [x] Ship @started(26-11-04 21:32) @done (26-11-04 21:32)\n"
    expect(todoChanges(oldText, nextText)).toEqual([
      { kind: "checked", number: 1, text: "Ship", line: 0, oldLine: 0 },
    ])
  })
})
