import { DocError } from "./errors"
import { lines } from "./markdown"

export interface Section {
  id: string
  title: string
  level: 1 | 2 | 3
  line: number
  from: number
  to: number
}

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-")
}

export function sections(text: string): Section[] {
  const result: Section[] = []
  const counts = new Map<string, number>()
  for (const [index, line] of lines(text).entries()) {
    if (line.kind !== "heading" || line.level! > 3) continue
    const title = text.slice(line.content, line.to).trim().replace(/#+$/, "").trim()
    const base = slug(title)
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    const previous = result.at(-1)
    if (previous) previous.to = line.from
    result.push({ id: count ? `${base}-${count}` : base, title,
      level: line.level as 1 | 2 | 3, line: index, from: line.from, to: text.length })
  }
  return result
}

export function findSection(text: string, id: string): Section {
  const query = id.trim().replace(/^#+/, "")
  const section = sections(text).find(section => section.id === query)
  if (!section) throw new DocError({ code: "not-found", message: `No section has the ID ${JSON.stringify(query)}` })
  return section
}

export function sectionText(text: string, id: string): string | null {
  const query = id.trim().replace(/^#+/, "")
  const section = sections(text).find(section => section.id === query)
  return section ? text.slice(section.from, section.to) : null
}
