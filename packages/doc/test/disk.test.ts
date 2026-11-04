import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DocError, MAX_BYTES, readFile, stamp, writeAtomic } from "../src"

const dirs: string[] = []
const plain = { bom: false, crlf: false }
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "do-it-doc-test-"))
  dirs.push(dir)
  return dir
}
function code(action: () => unknown, expected: DocError["code"]): void {
  try { action() } catch (error) {
    expect(error).toBeInstanceOf(DocError)
    expect((error as DocError).code).toBe(expected)
    return
  }
  throw new Error(`Expected ${expected}`)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("atomic writes keep the mode, replace the inode, and leave no temporary file", () => {
  const dir = directory()
  const path = join(dir, "todo.md")
  writeFileSync(path, "a\n")
  chmodSync(path, 0o640)
  const before = readFile(path)
  const after = writeAtomic(path, "b\n", plain)
  expect(readFileSync(path, "utf8")).toBe("b\n")
  expect(statSync(path).mode & 0o777).toBe(0o640)
  expect(after.ino).not.toBe(before.stamp.ino)
  expect(after).toEqual(stamp(path)!)
  expect(readdirSync(dir)).toEqual(["todo.md"])
})

test("BOM and CRLF round trip, with first newline choosing the format", () => {
  const path = join(directory(), "todo.md")
  writeFileSync(path, "\ufeff- [ ] 😀中\r\n- [ ] b\r\n")
  const read = readFile(path)
  expect(read.text).toBe("- [ ] 😀中\n- [ ] b\n")
  expect(read.format).toEqual({ bom: true, crlf: true })
  writeAtomic(path, read.text.replace("[ ]", "[x]"), read.format)
  expect(readFileSync(path, "utf8")).toBe("\ufeff- [x] 😀中\r\n- [ ] b\r\n")
  writeFileSync(path, "a\nb\r\n")
  expect(readFile(path)).toMatchObject({ text: "a\nb\n", format: plain })
})

test("missing stamp is null, missing read is not-found, and a new file can be written", () => {
  const path = join(directory(), "new.md")
  expect(stamp(path)).toBeNull()
  code(() => readFile(path), "not-found")
  const after = writeAtomic(path, "created\n", plain)
  expect(after.size).toBe(8)
  expect(readFile(path).text).toBe("created\n")
})

test("bounded reads refuse oversized files, directories, and invalid UTF-8", () => {
  const dir = directory()
  const path = join(dir, "large.md")
  writeFileSync(path, "")
  truncateSync(path, MAX_BYTES + 1)
  code(() => readFile(path), "too-large")
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]))
  code(() => readFile(path), "invalid")
  code(() => readFile(dir), "invalid")
  writeFileSync(path, "x".repeat(MAX_BYTES))
  expect(readFile(path).text.length).toBe(MAX_BYTES)
})

test("encoded size is capped, failed writes preserve the destination and clean up", () => {
  const dir = directory()
  const path = join(dir, "todo.md")
  writeFileSync(path, "old\n")
  code(() => writeAtomic(path, "x".repeat(MAX_BYTES + 1), plain), "too-large")
  code(() => writeAtomic(path, "x".repeat(MAX_BYTES), { bom: true, crlf: false }), "too-large")
  code(() => writeAtomic(path, "\n".repeat(MAX_BYTES / 2 + 1), { bom: false, crlf: true }), "too-large")
  expect(readFileSync(path, "utf8")).toBe("old\n")
  expect(readdirSync(dir)).toEqual(["todo.md"])
  const destination = join(dir, "directory.md")
  mkdirSync(destination)
  code(() => writeAtomic(destination, "new", plain), "invalid")
  expect(readdirSync(dir).sort()).toEqual(["directory.md", "todo.md"])
})
