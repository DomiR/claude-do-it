import { Refused } from "@do-it/protocol"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class Auth {
  readonly token: string
  readonly cookie: string
  private readonly codes = new Map<string, { path: string; until: number }>()
  constructor(home: string) {
    const path = join(home, "token")
    try { writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    if (statSync(path).size > 128) throw new Error("The daemon token file is invalid")
    this.token = readFileSync(path, "utf8").trim()
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error("The daemon token file is invalid")
    chmodSync(path, 0o600)
    this.cookie = createHmac("sha256", this.token).update("web cookie").digest("hex")
  }
  authorized(authorization: string | undefined, cookie: string | undefined): boolean {
    return (authorization !== undefined && equal(authorization, `Bearer ${this.token}`))
      || (cookie !== undefined && equal(cookie, this.cookie))
  }
  mint(path: string, now = Date.now()): string {
    for (const [code, entry] of this.codes) if (entry.until <= now) this.codes.delete(code)
    if (this.codes.size >= 64) throw new Refused({ code: "too-large", message: "Too many unused browser sign-in codes, use an existing link or wait five minutes" })
    const code = randomBytes(32).toString("hex")
    this.codes.set(code, { path, until: now + 5 * 60 * 1000 })
    return code
  }
  consume(code: string, path: string, now = Date.now()): boolean {
    const entry = this.codes.get(code)
    if (!entry) return false
    if (entry.until <= now) { this.codes.delete(code); return false }
    if (entry.path !== path) return false
    this.codes.delete(code)
    return true
  }
}
