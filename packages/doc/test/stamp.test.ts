import { describe, expect, test } from "bun:test"
import {
  applyEdits,
  findTodo,
  formatStamp,
  setTodoStateStamped,
  stampTodo,
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
    for (const existing of ["@done", "@done(25-01-02 03:04)", "@done (25-01-02 03:04)"]) {
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
    expect(text).toBe("- [x] Ship @started(25-01-02 03:04) @done (26-11-04 21:32)\n")
    text = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "cancelled", date))
    expect(text).toBe("- [-] Ship @started(25-01-02 03:04) @cancelled (26-11-04 21:32)\n")
    text = change(text, setTodoStateStamped(text, findTodo(text, "Ship"), "open", date))
    expect(text).toBe("- [ ] Ship @started(25-01-02 03:04)\n")
  })

  test("unstamps all supported spellings and normalizes labels for matching", () => {
    for (const existing of ["@done", "@done(25-01-02 03:04)", "@done (25-01-02 03:04)"]) {
      const text = `- [ ] Ship @started(25-01-02 03:04) ${existing} @project(work)\n`
      expect(change(text, unstampTodo(text, findTodo(text, "Ship"), "done"))).toBe("- [ ] Ship @started(25-01-02 03:04) @project(work)\n")
    }
    expect(withoutStamps("  Ship @started(25-01-02 03:04) @cancelled (25-01-02 03:04)  ")).toBe("Ship")
  })

  test("task changes compare labels without stamps", () => {
    const oldText = "- [ ] Ship @started(25-01-02 03:04)\n"
    const nextText = "- [x] Ship @started(26-11-04 21:32) @done (26-11-04 21:32)\n"
    expect(todoChanges(oldText, nextText)).toEqual([
      { kind: "checked", number: 1, text: "Ship", line: 0, oldLine: 0 },
    ])
  })
})
