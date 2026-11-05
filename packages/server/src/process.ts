/**
 * Whether a process with this id exists. Effect has no service for signalling
 * a process it did not spawn, so this uses the `process` global.
 */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as { code?: string }).code === "EPERM" }
}
