import type { TaskState } from "./todo"

/** The small block parser shared by sections and task operations, as in Herdr. */
export interface Line {
  from: number
  to: number
  indent: number
  depth: number
  content: number
  kind: "blank" | "paragraph" | "heading" | "item" | "quote" | "fence" | "code" | "rule"
  level?: number
  state?: TaskState
  checkbox?: number
}

export function lines(text: string): Line[] {
  const out: Line[] = []
  let fence: { marker: string; count: number } | null = null
  let from = 0
  while (true) {
    const newline = text.indexOf("\n", from)
    const end = newline === -1 ? text.length : newline
    const to = end > from && text[end - 1] === "\r" ? end - 1 : end
    const raw = text.slice(from, to)
    const lead = /^[ \t]*/.exec(raw)![0]
    const rest = raw.slice(lead.length)
    const at = from + lead.length
    const line: Line = {
      from, to, indent: lead.length,
      depth: [...lead].reduce((n, ch) => n + (ch === "\t" ? 4 : 1), 0),
      content: at, kind: "paragraph",
    }
    if (fence) {
      let run = 0
      while (rest[run] === fence.marker) run++
      if (run >= fence.count && !rest.slice(run).trim()) {
        line.kind = "fence"
        fence = null
      } else line.kind = "code"
    } else {
      const opening = /^(`{3,}|~{3,})(.*)$/.exec(rest)
      const heading = /^(#{1,6})(?: |$)/.exec(rest)
      const list = /^(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)/.exec(rest)
      if (opening && (opening[1]![0] === "~" || !opening[2]!.includes("`"))) {
        fence = { marker: opening[1]![0]!, count: opening[1]!.length }
        line.kind = "fence"
      } else if (!rest) line.kind = "blank"
      else if (heading) {
        line.kind = "heading"
        line.level = heading[1]!.length
        line.content = at + heading[0].length
      } else if (/^(?:-(?: *-){2,}|\*(?: *\*){2,}|_(?: *_){2,})\s*$/.test(rest)) {
        line.kind = "rule"
      } else if (rest.startsWith(">")) line.kind = "quote"
      else if (list) {
        line.kind = "item"
        line.content = at + list[0].length
        const task = /^\[([ xX-])\](?:[ \t]|$)/.exec(rest.slice(list[0].length))
        if (task) {
          line.checkbox = line.content
          line.content += task[0].length
          line.state = task[1] === " " ? "open" : task[1] === "-" ? "cancelled" : "done"
        }
      }
    }
    out.push(line)
    if (newline === -1) return out
    from = end + 1
  }
}

export function blockEnd(all: Line[], index: number): number {
  const depth = all[index]!.depth
  let end = index + 1
  for (let probe = end; probe < all.length; probe++) {
    const line = all[probe]!
    if (line.kind === "blank") continue
    if (line.depth <= depth || line.kind === "heading") break
    end = probe + 1
  }
  return end
}
