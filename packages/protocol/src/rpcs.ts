import { Rpc, RpcGroup } from 'effect/rpc';

import { RpcFailure } from './errors.js';
import {
	Change,
	DiffPayload,
	DiffSuccess,
	Deleted,
	EditPayload,
	EditSuccess,
	Nudge,
	NudgePayload,
	NudgeSuccess,
	NotifyPayload,
	NotifySuccess,
	OpenPayload,
	OpenSuccess,
	ReadPayload,
	ReadSuccess,
	Resync,
	SectionsPayload,
	SectionsSuccess,
	StatusPayload,
	StatusSuccess,
	StopPayload,
	StopSuccess,
	SyncPayload,
	SyncSuccess,
	TodosPayload,
	TodosSuccess,
	UnnotifyPayload,
	UnnotifySuccess,
	WatchEvent,
	WatchPayload,
	Watching
} from './schema.js';

export const statusRpc = Rpc.make('status', {
	payload: StatusPayload,
	success: StatusSuccess,
	error: RpcFailure
});

export const stopRpc = Rpc.make('stop', {
	payload: StopPayload,
	success: StopSuccess,
	error: RpcFailure
});

export const openRpc = Rpc.make('open', {
	payload: OpenPayload,
	success: OpenSuccess,
	error: RpcFailure
});

export const readRpc = Rpc.make('read', {
	payload: ReadPayload,
	success: ReadSuccess,
	error: RpcFailure
});

export const sectionsRpc = Rpc.make('sections', {
	payload: SectionsPayload,
	success: SectionsSuccess,
	error: RpcFailure
});

export const todosRpc = Rpc.make('todos', {
	payload: TodosPayload,
	success: TodosSuccess,
	error: RpcFailure
});

export const editRpc = Rpc.make('edit', {
	payload: EditPayload,
	success: EditSuccess,
	error: RpcFailure
});

export const syncRpc = Rpc.make('sync', {
	payload: SyncPayload,
	success: SyncSuccess,
	error: RpcFailure
});

export const diffRpc = Rpc.make('diff', {
	payload: DiffPayload,
	success: DiffSuccess,
	error: RpcFailure
});

export const watchRpc = Rpc.make('watch', {
	payload: WatchPayload,
	success: WatchEvent,
	error: RpcFailure,
	stream: true
});

export const notifyRpc = Rpc.make('notify', {
	payload: NotifyPayload,
	success: NotifySuccess,
	error: RpcFailure
});

export const unnotifyRpc = Rpc.make('unnotify', {
	payload: UnnotifyPayload,
	success: UnnotifySuccess,
	error: RpcFailure
});

export const nudgeRpc = Rpc.make('nudge', {
	payload: NudgePayload,
	success: NudgeSuccess,
	error: RpcFailure
});

export const DoItRpcs = RpcGroup.make(
	statusRpc,
	stopRpc,
	openRpc,
	readRpc,
	sectionsRpc,
	todosRpc,
	editRpc,
	syncRpc,
	diffRpc,
	watchRpc,
	notifyRpc,
	unnotifyRpc,
	nudgeRpc
);
export type DoItRpcs = typeof DoItRpcs;

export type WatchEventSchema = typeof WatchEvent.Type;
export { Change, Deleted, Nudge, Resync, Watching };
