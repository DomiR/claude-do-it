export { paths } from "./paths"
export { readDaemonInfo, DaemonUnavailable, type DaemonInfo } from "./info"
export { ensureDaemon, stopDaemon, type EnsureOptions } from "./lifecycle"
export { RpcClient, RpcClientLive, withClient, type DoItClient } from "./rpc"
