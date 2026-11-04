import { spawn } from "node:child_process"
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
export function openBrowser(url: string): void {
  const configured = process.env.DO_IT_BROWSER
  if (configured?.toLowerCase() === "true") return
  const command = configured || (process.platform === "darwin" ? "open" : "xdg-open")
  const child = spawn(`${command} ${shellQuote(url)}`, { shell: true, detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref()
}
