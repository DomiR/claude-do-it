import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import ts from "typescript"
import * as text from "@do-it/doc/text"

const entry = resolve(import.meta.dir, "../src/text.ts")

test("the text subpath exports pure operations that work without a Document", () => {
  const original = "# Tasks\n- [ ] Ship\n"
  const next = text.applyEdits(original, text.setTodoState(original, text.findTodo(original, "Ship"), "done"))
  expect(next).toBe("# Tasks\n- [x] Ship\n")
  expect(text.formatTodoChange(text.todoChanges(original, next)[0]!)).toBe("checked 1. Ship")
  expect(Object.keys(text).sort()).toEqual([
    "COMPACT_KEEP", "DocError", "KEPT", "MAX_BYTES", "MAX_DIFF", "MAX_ITEM", "addTodo", "appendBlock", "applyEdits",
    "blockEnd", "findSection", "findTodo", "formatLasted", "formatStamp", "formatTodoChange", "lines", "replaceUnique", "sectionText", "sections",
    "setTodoState", "setTodoStateStamped", "stampTodo", "startedAt", "textEdits", "todoChanges", "todos", "unstampTodo", "withoutStamps",
  ].sort())
})

test("every transitive relative text dependency, including type imports, is Loro free", () => {
  const visited = new Set<string>()
  function walk(path: string): void {
    if (visited.has(path)) return
    visited.add(path)
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
    function dependency(specifier: string): void {
      expect(specifier === "loro-crdt" || specifier.startsWith("loro-crdt/")).toBe(false)
      expect(specifier.startsWith("node:") || specifier.startsWith("bun:")).toBe(false)
      if (specifier.startsWith(".")) walk(resolve(dirname(path), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`))
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text)
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument)) dependency(argument.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  walk(entry)
  expect(visited.has(resolve(import.meta.dir, "../src/errors.ts"))).toBe(true)
  expect(visited.has(resolve(import.meta.dir, "../src/types.ts"))).toBe(true)
  expect(visited.has(resolve(import.meta.dir, "../src/document.ts"))).toBe(false)
  expect(visited.has(resolve(import.meta.dir, "../src/disk.ts"))).toBe(false)
})

test("the text entry bundles for browsers without Node polyfills or Wasm", async () => {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", write: false })
  expect(result.success).toBe(true)
  expect(result.logs).toEqual([])
  expect(result.outputs).toHaveLength(1)
  expect(await result.outputs[0]!.text()).not.toContain("loro_wasm")
})
