import { DoItRpcs } from "@do-it/protocol"
import { BunHttpServer, BunHttpServerRequest } from "@effect/platform-bun"
import { Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest as Request, HttpServerResponse as Response } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Auth } from "./auth"
import { APP_VERSION, MAX_BODY, config, type ServerConfig } from "./config"
import { Documents, DocumentsLive } from "./documents"
import { HandlersLive, type RuntimeInfo } from "./handlers"
import { readJson } from "./files"
import { Log } from "./log"
import { staticResponse } from "./static"
import { Versions } from "./versions"

export const makeServer = Effect.fn("makeServer")(function* (options: ServerConfig = config()) {
  yield* Effect.sync(() => { mkdirSync(options.home, { recursive: true, mode: 0o700 }); chmodSync(options.home, 0o700) })
  const log = new Log(options.home)
  const auth = yield* Effect.sync(() => new Auth(options.home))
  const versions = new Versions(options.home, log)
  const stop = yield* Deferred.make<void>()
  const shutdown = new AbortController()
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const runtime: RuntimeInfo = { port: options.port, startedAt: Date.now(), stop: () => {
    if (!stopTimer) stopTimer = setTimeout(() => { Deferred.doneUnsafe(stop, Effect.void) }, 50)
  } }
  const serverOptions = { hostname: "127.0.0.1", port: options.port, maxRequestBodySize: MAX_BODY,
    disablePreemptiveShutdown: true }
  const server = yield* BunHttpServer.make(serverOptions).pipe(Effect.catchCause(cause => options.port === 0
    ? Effect.failCause(cause) : BunHttpServer.make({ ...serverOptions, port: 0 })))
  if (!("port" in server.address)) return yield* Effect.die(new Error("Expected an IP listening address"))
  runtime.port = server.address.port
  const documentsLayer = DocumentsLive(versions, log)
  const context = yield* Layer.build(documentsLayer)
  const registry = yield* Documents.pipe(Effect.provideContext(context))
  // Watch calls hold a handler slot for their whole lifetime. Leave room for
  // ordinary requests even when all 256 allowed streams are open.
  const rpcLayer = RpcServer.layerHttp({ group: DoItRpcs, path: "/rpc", protocol: "http", streamBufferSize: 1, concurrency: 512 }).pipe(
    Layer.provide(HandlersLive(auth, runtime)), Layer.provide(Layer.succeed(Documents, registry)), Layer.provide(RpcSerialization.layerNdjson),
  )
  const rpc = yield* HttpRouter.toHttpEffect(rpcLayer)
  let active = 0
  let lastRequest = Date.now()
  const http = Effect.gen(function* () {
    const request = yield* Request.HttpServerRequest
    const host = request.headers.host
    const origin = request.headers.origin
    const allowed = [`127.0.0.1:${runtime.port}`, `localhost:${runtime.port}`]
    if (!host || !allowed.includes(host) || (origin !== undefined && !allowed.map(host => `http://${host}`).includes(origin))) {
      return Response.text("Forbidden", { status: 403 })
    }
    lastRequest = Date.now()
    if (active >= 512) return Response.text("Too many requests", { status: 503 })
    active++
    yield* Effect.addFinalizer(() => Effect.sync(() => { active--; lastRequest = Date.now() }))
    const url = new URL(request.url, `http://127.0.0.1:${runtime.port}`)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.jsonUnsafe({ ok: true, pid: process.pid, appVersion: APP_VERSION })
    }
    if (request.method === "GET" && url.pathname === "/auth") {
      const path = url.searchParams.get("path") ?? ""
      if (!auth.consume(url.searchParams.get("code") ?? "", path)) {
        return Response.text("<!doctype html><p>This link is invalid or expired. Run <code>do-it open</code> again.</p>", { status: 401, contentType: "text/html" })
      }
      return Response.redirect(`/?path=${encodeURIComponent(path)}`, { status: 303,
        headers: { "set-cookie": `do_it=${auth.cookie}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store", "referrer-policy": "no-referrer" } })
    }
    if (url.pathname === "/rpc" || url.pathname === "/rpc/") {
      if (!auth.authorized(request.headers.authorization, request.cookies.do_it)) return Response.text("Unauthorized", { status: 401 })
      if (request.method !== "POST") return Response.text("Use POST", { status: 405 })
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) return Response.text("Request body is too large", { status: 413 })
      const body = yield* request.text.pipe(Effect.result)
      if (body._tag === "Failure") return Response.text("Could not read request body", { status: 413 })
      if (Buffer.byteLength(body.success) > MAX_BODY) return Response.text("Request body is too large", { status: 413 })
      // Bound RPC envelopes too, so a body of tiny batched calls cannot create
      // an arbitrarily large number of waiting handler fibers.
      let frames = 0
      for (let i = 0; i < body.success.length; i++) {
        if (body.success.charCodeAt(i) === 10 && ++frames > 64) return Response.text("Too many RPC messages", { status: 413 })
      }
      return yield* rpc
    }
    if (request.method !== "GET" && request.method !== "HEAD") return Response.text("Not found", { status: 404 })
    return staticResponse(options.webDist, url.pathname)
  })
  yield* server.serve(http.pipe(Effect.flatMap(response => Effect.gen(function* () {
    if (response.body._tag !== "Stream") return response
    const request = yield* Request.HttpServerRequest
    if (Response.omitsBody(response, request.method === "HEAD")) return response
    // Bun's default bridge errors its ReadableStream when the server scope
    // interrupts it. An explicit abort closes it normally instead. Transfer
    // the request scope so RPC resources still live until EOF or cancellation.
    const context = yield* Effect.context<never>()
    return Response.raw(Response.toWeb(HttpEffect.scopeTransferToStream(response), {
      context,
      signal: AbortSignal.any([BunHttpServerRequest.toBunServerRequest(request).signal, shutdown.signal]),
    }))
  }))))
  const record = { pid: process.pid, port: runtime.port, appVersion: APP_VERSION, startedAt: runtime.startedAt }
  const recordPath = join(options.home, "daemon.json")
  yield* Effect.sync(() => {
    // Exclusive publication also rejects concurrent manual starts. A dead
    // process's record may be removed; a live daemon's record is never replaced.
    let prior: { pid?: number } | undefined
    try { prior = readJson(recordPath, 4096) as typeof prior } catch { /* Missing or corrupt stale record. */ }
    let running = false
    if (prior?.pid && prior.pid !== process.pid) {
      try { process.kill(prior.pid, 0); running = true }
      catch (error) { running = (error as NodeJS.ErrnoException).code === "EPERM" }
    }
    if (running) throw new Error("A daemon is already running for this home")
    try { unlinkSync(recordPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600, flag: "wx" })
  })
  const idle = setInterval(() => {
    try { log.rotate() } catch { /* Logging cannot prevent idle shutdown. */ }
    if (active === 0 && registry.totalWatchers === 0 && Date.now() - lastRequest >= options.idleMs) runtime.stop()
  }, Math.max(10, Math.min(1000, options.idleMs / 4)))
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    clearInterval(idle)
    if (stopTimer) clearTimeout(stopTimer)
    shutdown.abort()
    registry.close()
    try {
      const current = readJson(recordPath, 4096) as typeof record
      if (current.pid === record.pid && current.startedAt === record.startedAt && current.port === record.port) unlinkSync(recordPath)
    } catch { /* The record has already been removed. */ }
    log.write("Daemon stopped")
  }))
  log.write(`Daemon listening on 127.0.0.1:${runtime.port}`)
  return { ...record, home: options.home, auth, documents: registry, stopped: Deferred.await(stop), stop: runtime.stop }
})
