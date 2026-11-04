import { existsSync, realpathSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { HttpServerResponse as Response } from "effect/http"

export function staticResponse(root: string, pathname: string) {
  if (!existsSync(resolve(root, "index.html"))) return Response.html("<!doctype html><p>Run <code>bun run build:web</code> to build the web app.</p>")
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return Response.text("Invalid path", { status: 400 }) }
  if (decoded.includes("\0") || decoded.includes("\\")) return Response.text("Invalid path", { status: 400 })
  const canonical = realpathSync(root)
  let path = resolve(canonical, `.${decoded}`)
  if (path !== canonical && !path.startsWith(canonical + sep)) return Response.text("Forbidden", { status: 403 })
  try {
    if (!statSync(path).isFile()) path = resolve(canonical, "index.html")
  } catch { path = resolve(canonical, "index.html") }
  path = realpathSync(path)
  if (!path.startsWith(canonical + sep)) return Response.text("Forbidden", { status: 403 })
  const file = Bun.file(path)
  return Response.fromWeb(new globalThis.Response(file, { headers: { "content-type": file.type || "application/octet-stream" } }))
}
