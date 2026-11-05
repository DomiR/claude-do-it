import type { FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"

export { paths, type Paths } from "./paths"
export { alive, readDaemonInfo, DaemonUnavailable, type DaemonInfo } from "./info"
export { ensureDaemon, stopDaemon, type EnsureOptions } from "./lifecycle"
export { RpcClient, RpcClientLive, withClient, type DoItClient } from "./rpc"

/** The platform services the lifecycle functions need, all provided by `BunServices.layer`. */
export type ClientServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
