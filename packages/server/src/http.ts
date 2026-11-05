import { isNotFound } from "@do-it/doc"
import { DoItRpcs } from "@do-it/protocol"
import { BunHttpServer, BunHttpServerRequest } from "@effect/platform-bun"
import { Deferred, Effect, FileSystem, Layer, Path, Schedule } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest as Request, HttpServerResponse as Response } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Auth } from "./auth"
import { APP_VERSION, MAX_BODY, config, type ServerConfig } from "./config"
import { Documents, DocumentsLive } from "./documents"
import { HandlersLive, type RuntimeInfo } from "./handlers"
import { readJson } from "./files"
import { Log } from "./log"
import { alive } from "./process"
import { staticResponse } from "./static"
import { Versions } from "./versions"

const encoder = new TextEncoder()

/** The contents of daemon.json. */
interface RuntimeRecord {
  pid: number
  port: number
  appVersion: string
  startedAt: number
}

export const makeServer = Effect.fn("makeServer")(function* (options?: ServerConfig) {
  const settings = options ?? (yield* config)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(settings.home, { recursive: true, mode: 0o700 })
  yield* fs.chmod(settings.home, 0o700)
  const log = yield* Log.make(settings.home)
  const auth = yield* Auth.make(settings.home)
  const versions = yield* Versions.make(settings.home, log)
  const stop = yield* Deferred.make<void>()
  const shutdown = new AbortController()
  const scope = yield* Effect.scope
  let stopping = false
  // Answer the stop request before the server scope starts closing.
  const runtime: RuntimeInfo = { port: settings.port, startedAt: Date.now(), stop: Effect.suspend(() => {
    if (stopping) return Effect.void
    stopping = true
    return Effect.asVoid(Effect.forkIn(Effect.delay(Deferred.succeed(stop, undefined), "50 millis"), scope))
  }) }
  const serverOptions = { hostname: "127.0.0.1", port: settings.port, maxRequestBodySize: MAX_BODY,
    disablePreemptiveShutdown: true }
  const recordPath = path.join(settings.home, "daemon.json")
  let published: RuntimeRecord | undefined
  // Registered before the server, so it runs after the server has stopped
  // listening: once daemon.json is gone, no request reaches this daemon.
  yield* Effect.addFinalizer(() => Effect.suspend(() => {
    const record = published
    if (record === undefined) return Effect.void
    return Effect.gen(function* () {
      yield* readJson(recordPath, 4096).pipe(
        Effect.flatMap(value => {
          const current = value as RuntimeRecord
          return current.pid === record.pid && current.startedAt === record.startedAt && current.port === record.port ? fs.remove(recordPath) : Effect.void
        }),
        // The record has already been removed.
        Effect.ignore,
      )
      yield* log.write("Daemon stopped")
    })
  }))
  const server = yield* BunHttpServer.make(serverOptions).pipe(Effect.catchCause(cause => settings.port === 0
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
      if (encoder.encode(body.success).length > MAX_BODY) return Response.text("Request body is too large", { status: 413 })
      // Bound RPC envelopes too, so a body of tiny batched calls cannot create
      // an arbitrarily large number of waiting handler fibers.
      let frames = 0
      for (let i = 0; i < body.success.length; i++) {
        if (body.success.charCodeAt(i) === 10 && ++frames > 64) return Response.text("Too many RPC messages", { status: 413 })
      }
      return yield* rpc
    }
    if (request.method !== "GET" && request.method !== "HEAD") return Response.text("Not found", { status: 404 })
    return yield* staticResponse(settings.webDist, url.pathname)
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
  const record: RuntimeRecord = { pid: process.pid, port: runtime.port, appVersion: APP_VERSION, startedAt: runtime.startedAt }
  // Exclusive publication also rejects concurrent manual starts. A dead
  // process's record may be removed; a live daemon's record is never replaced.
  const prior = yield* readJson(recordPath, 4096).pipe(Effect.map(value => value as { pid?: number } | null),
    Effect.catch(() => Effect.succeed(undefined)))
  if (prior?.pid && prior.pid !== process.pid && alive(prior.pid)) {
    return yield* Effect.fail(new Error("A daemon is already running for this home"))
  }
  yield* fs.remove(recordPath).pipe(Effect.catchIf(isNotFound, () => Effect.void))
  yield* fs.writeFileString(recordPath, JSON.stringify(record), { mode: 0o600, flag: "wx" })
  published = record
  const tick = Effect.gen(function* () {
    // Logging cannot prevent idle shutdown.
    yield* Effect.ignore(log.rotate())
    if (active === 0 && registry.totalWatchers === 0 && Date.now() - lastRequest >= settings.idleMs) yield* runtime.stop
  })
  yield* Effect.forkScoped(Effect.repeat(tick, Schedule.spaced(Math.max(10, Math.min(1000, settings.idleMs / 4)))))
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    shutdown.abort()
    yield* registry.close()
  }))
  yield* log.write(`Daemon listening on 127.0.0.1:${runtime.port}`)
  return { ...record, home: settings.home, auth, documents: registry, stopped: Deferred.await(stop), stop: runtime.stop }
})
