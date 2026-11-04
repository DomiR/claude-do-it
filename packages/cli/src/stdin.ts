const MAX_STDIN = 2 * 1024 * 1024
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []; let total = 0
  for await (const chunk of Bun.stdin.stream()) { total += chunk.byteLength; if (total > MAX_STDIN) throw new Error("Standard input exceeds 2 MiB"); chunks.push(chunk) }
  return Buffer.concat(chunks).toString("utf8")
}
export async function resolveText(text: string): Promise<string> { return text === "-" ? readStdin() : text }
