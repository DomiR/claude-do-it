import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { Option } from 'effect';
import { Command, given, message, model, story, type StorySimulation } from 'foldkit/story';

import {
	ApplyRemoteText,
	ApplyTheme,
	FocusEditor,
	RevealEditorPosition,
	RunEditorAction,
	SetTheme,
	SyncDraft,
	WaitBeforeReconnect,
	WaitBeforeRemoteRetry,
	WaitBeforeSync,
	WaitBeforeSyncRetry
} from './command';
import { rebaseRemote } from './editor/changes';
import { Message } from './message';
import { DocumentState, makeInitialModel, saveStatus, type Model, type ReadyDocument } from './model';
import { subscriptions } from './subscription';
import { update } from './update';
import { paletteItems } from './view/palette';

const path = '/tmp/TODO.md';
const session = `${path}:0`;
const original = '- [ ] Ship\n';
const sent = '- [x] Ship\n';
const readyModel = (text = original): Model =>
	update(
		makeInitialModel(path, 'mac'),
		Message.ReceivedWatchEvent({
			event: { _tag: 'Watching', version: 1, text }
		})
	).model;
const documentOf = (model: Model): ReadyDocument => {
	if (model.document._tag !== 'Ready') throw new Error('Expected a ready document');
	return model.document.document;
};
const edited = (text: string, origin: 'Input' | 'Action' = 'Input') =>
	Message.UpdatedEditor({
		session,
		text,
		anchor: text.length,
		head: text.length,
		origin,
		token: null
	});
const remote = (token: number, text: string) =>
	Message.UpdatedEditor({ session, token, text, anchor: 0, head: 0, origin: 'Remote' });
const changed = (to: number, text: string) =>
	Message.ReceivedWatchEvent({
		event: { _tag: 'Change', from: 1, to, by: [{ _tag: 'Agent', name: 't3' }], diff: null, todos: [], text }
	});
const reply = (base: number, requestText: string, version: number, text = requestText) =>
	Message.SucceededSync({ request: { base, text: requestText }, version, text });
const merged = (from: string, to: string, live: string) =>
	rebaseRemote(from, to, live)
		.apply(EditorState.create({ doc: live, extensions: [EditorState.lineSeparator.of('\n')] }).doc)
		.toString();
const hash = (version: number) => version.toString(16).padStart(64, '0');
const watching = (version: number, text: string) =>
	Message.ReceivedWatchEvent({
		event: { _tag: 'Watching', version, text, hash: hash(version) }
	});

const argsOf = (
	commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined,
	name: string
) => (commands ?? []).filter((command) => command.name === name).map((command) => command.args);

// Story normally settles Commands before the next Message. These races need
// a Mount or watch fact while a Command remains outstanding, retaining every
// pending Command so Story still verifies and resolves all of them.
const whilePending =
	(fact: Message) =>
	(simulation: StorySimulation<Model, Message>): StorySimulation<Model, Message> => {
		const next = update(simulation.model, fact);
		return { ...simulation, model: next.model, commands: [...simulation.commands, ...(next.commands ?? [])] };
	};

describe('editor synchronization', () => {
	test('debounces typing and ignores an older revision timer', () => {
		const first = `${original}a`;
		const second = `${original}ab`;
		story(
			update,
			given(readyModel()),
			message(edited(first)),
			whilePending(edited(second)),
			Command.expectExact(WaitBeforeSync({ session, revision: 1 }), WaitBeforeSync({ session, revision: 2 })),
			Command.resolve(
				WaitBeforeSync({ session, revision: 1 }),
				Message.CompletedWaitBeforeSync({ session, revision: 1 })
			),
			Command.expectExact(WaitBeforeSync({ session, revision: 2 })),
			Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 2 })),
			Command.expectExact(SyncDraft({ path, base: 1, text: second })),
			Command.resolve(SyncDraft, reply(1, second, 2)),
			model((next) => {
				expect(documentOf(next).draftRevision).toBe(2);
				expect(saveStatus(documentOf(next))).toBe('Saved');
			})
		);
	});

	test('flushes an action immediately with the exact text from the editor', () => {
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.expectExact(SyncDraft({ path, base: 1, text: sent })),
			model((next) => expect(documentOf(next).draft).toBe(sent)),
			Command.resolve(SyncDraft, reply(1, sent, 2)),
			model((next) => expect(documentOf(next).base).toEqual({ version: 2, text: sent }))
		);
	});

	test('adopts a clean Change only when the remote editor fact arrives', () => {
		story(
			update,
			given(readyModel()),
			message(changed(2, sent)),
			Command.expectExact(ApplyRemoteText({ session, token: 1, from: original, to: sent })),
			model((next) => {
				expect(documentOf(next).draft).toBe(original);
				expect(documentOf(next).base.version).toBe(1);
			}),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			model((next) => expect(documentOf(next).pendingRemote._tag).toBe('Some')),
			message(remote(1, sent)),
			model((next) => {
				expect(documentOf(next).draft).toBe(sent);
				expect(documentOf(next).base).toEqual({ version: 2, text: sent });
				expect(saveStatus(documentOf(next))).toBe('Saved');
				expect(next.activity).toHaveLength(1);
			})
		);
	});

	test('keeps typing that races with clean remote application', () => {
		const live = `${original}local\n`;
		const combined = merged(original, sent, live);
		story(
			update,
			given(readyModel()),
			message(changed(2, sent)),
			whilePending(edited(live)),
			Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 1 })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, combined)),
			Command.expectExact(SyncDraft({ path, base: 2, text: combined })),
			Command.resolve(SyncDraft, reply(2, combined, 3)),
			model((next) => expect(documentOf(next).draft).toBe('- [x] Ship\nlocal\n'))
		);
	});

	test('drops an old snapshot and a sync echo while still recording Activity', () => {
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			whilePending(changed(2, sent)),
			Command.resolve(SyncDraft, reply(1, sent, 2)),
			Command.expectNone(),
			message(changed(2, original)),
			message(changed(1, original)),
			model((next) => {
				expect(documentOf(next).base).toEqual({ version: 2, text: sent });
				expect(documentOf(next).draft).toBe(sent);
				expect(documentOf(next).latestRemote._tag).toBe('None');
				expect(next.activity).toHaveLength(3);
			})
		);
	});

	test('starts a merge sync from the original base when a Change arrives while dirty', () => {
		const live = `${original}local\n`;
		const combined = `${sent}local\n`;
		story(
			update,
			given(readyModel()),
			message(edited(live)),
			whilePending(changed(2, sent)),
			Command.expectExact(WaitBeforeSync({ session, revision: 1 }), SyncDraft({ path, base: 1, text: live })),
			Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 1 })),
			Command.resolve(SyncDraft, reply(1, live, 3, combined)),
			Command.expectExact(ApplyRemoteText({ session, token: 1, from: live, to: combined })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, combined)),
			Command.expectNone(),
			model((next) => expect(documentOf(next).base.version).toBe(3))
		);
	});

	test('rebases a sync reply over later typing before sending all three contributions exactly once', () => {
		const typedMore = `${sent}- [ ] Local\n`;
		const withAgent = `${sent}- [ ] Agent\n`;
		const combined = merged(sent, withAgent, typedMore);
		expect(combined).toBe(`${sent}- [ ] Agent\n- [ ] Local\n`);
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			whilePending(edited(typedMore)),
			Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 2 })),
			Command.resolve(SyncDraft, reply(1, sent, 3, withAgent)),
			Command.expectExact(ApplyRemoteText({ session, token: 1, from: sent, to: withAgent })),
			model((next) => {
				expect(documentOf(next).draft).toBe(typedMore);
				expect(documentOf(next).base.version).toBe(1);
			}),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, combined)),
			Command.expectExact(SyncDraft({ path, base: 3, text: combined })),
			Command.resolve(SyncDraft, reply(3, combined, 4)),
			model((next) => {
				expect(documentOf(next).draft).toBe(combined);
				for (const label of ['Ship', 'Agent', 'Local']) expect(documentOf(next).draft.split(label)).toHaveLength(2);
				expect(saveStatus(documentOf(next))).toBe('Saved');
			})
		);
	});

	test('coalesces newer Changes while a sync is in flight and applies the newest after its reply', () => {
		const newest = `${sent}- [ ] Agent\n- [ ] Newest\n`;
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			whilePending(changed(3, `${sent}- [ ] Agent\n`)),
			whilePending(changed(4, newest)),
			whilePending(changed(2, original)),
			model((next) => expect(Option.getOrThrow(documentOf(next).latestRemote).version).toBe(4)),
			Command.resolve(SyncDraft, reply(1, sent, 2)),
			Command.expectExact(ApplyRemoteText({ session, token: 1, from: sent, to: newest })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, newest)),
			model((next) => {
				expect(documentOf(next).base.version).toBe(4);
				expect(documentOf(next).draft).toBe(newest);
			})
		);
	});

	test('coalesces a newer snapshot while a remote transaction is pending', () => {
		const newest = `${sent}agent\n`;
		story(
			update,
			given(readyModel()),
			message(changed(2, sent)),
			whilePending(changed(3, newest)),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, sent)),
			Command.expectExact(ApplyRemoteText({ session, token: 2, from: sent, to: newest })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
			message(remote(2, newest)),
			model((next) => expect(documentOf(next).draft).toBe(newest))
		);
	});

	for (const dirty of [false, true]) {
		test(`rebases a ${dirty ? 'dirty' : 'clean'} Resync even at the current version`, () => {
			const live = dirty ? `${original}local\n` : original;
			const snapshot = `agent\n${original}`;
			const combined = merged(original, snapshot, live);
			const initial = readyModel();
			const withDraft = {
				...initial,
				document: DocumentState.Ready({ document: { ...documentOf(initial), draft: live } })
			};
			story(
				update,
				given(withDraft),
				message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 1, text: snapshot } })),
				Command.expectExact(ApplyRemoteText({ session, token: 1, from: original, to: snapshot })),
				model((next) => expect(documentOf(next).draft).toBe(live)),
				Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
				message(remote(1, combined)),
				...(dirty
					? [
							Command.expectExact(SyncDraft({ path, base: 1, text: combined })),
							Command.resolve(SyncDraft, reply(1, combined, 2))
						]
					: [Command.expectNone()]),
				model((next) => expect(documentOf(next).draft).toBe(combined))
			);
		});
	}

	test('Forgotten bumps the watch key and holds edits until Resync supplies a new base', () => {
		const snapshot = `agent\n${original}`;
		const combined = merged(original, snapshot, sent);
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Forgotten' })),
			Command.expectNone(),
			model((next) => {
				expect(documentOf(next).inFlight._tag).toBe('None');
				expect(documentOf(next).watchKey).toBe(1);
				expect(Option.getOrThrow(documentOf(next).resumeFrom)).toEqual({ version: 1 });
				expect(documentOf(next).base.version).toBe(1);
			}),
			message(Message.CompletedWaitBeforeSync({ session, revision: 1 })),
			Command.expectNone(),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 10, text: snapshot } })),
			Command.expectNone(),
			model((next) => expect(documentOf(next).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true })),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 10, text: snapshot } })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, combined)),
			Command.expectExact(SyncDraft({ path, base: 10, text: combined })),
			Command.resolve(SyncDraft, reply(10, combined, 11))
		);
	});

	test('a reconnect while awaiting a Resync resumes from the forgotten base even after a remote change moved it', () => {
		const agent = `${original}- [ ] Agent\n`;
		let current = update(readyModel(), edited(sent, 'Action')).model;
		current = update(current, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Forgotten' })).model;
		// The person undoes the edit, so a late change from the old watch applies to a clean draft.
		current = update(current, edited(original)).model;
		const applied = update(current, changed(3, agent));
		expect(argsOf(applied.commands, 'ApplyRemoteText')).toEqual([{ session, token: 1, from: original, to: agent }]);
		current = update(applied.model, remote(1, agent)).model;
		expect(documentOf(current).base.version).toBe(3);
		expect(documentOf(current).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true });
		current = update(current, Message.FailedWatch({ unauthorized: false })).model;
		current = update(current, Message.CompletedWaitBeforeReconnect()).model;
		// Resuming from version 3 would get a plain Watching, and the Resync would never come.
		expect(Option.getOrThrow(documentOf(current).resumeFrom)).toEqual({ version: 1 });
		expect(documentOf(current).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true });
	});

	test('a Watching that confirms the base version and hash ends the wait for a Resync and syncs the draft', () => {
		const live = `${original}- [ ] Local\n`;
		let current = update(makeInitialModel(path, 'mac'), watching(5, original)).model;
		const syncing = update(current, edited(live, 'Action'));
		expect(argsOf(syncing.commands, 'SyncDraft')).toEqual([{ path, base: 5, text: live, baseHash: hash(5) }]);
		current = update(
			syncing.model,
			Message.FailedSync({ request: { base: 5, text: live, baseHash: hash(5) }, kind: 'Forgotten' })
		).model;
		expect(documentOf(current).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true });
		// A Watching for another version or without the base's hash keeps waiting.
		expect(documentOf(update(current, watching(6, original)).model).connection).toEqual({
			_tag: 'Reconnecting',
			awaitingResync: true
		});
		const confirmed = update(current, watching(5, original));
		expect(documentOf(confirmed.model).connection).toEqual({ _tag: 'Live' });
		expect(argsOf(confirmed.commands, 'SyncDraft')).toEqual([{ path, base: 5, text: live, baseHash: hash(5) }]);
	});

	test('retries a Transient failure after a delay and resets the attempt on success', () => {
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Transient' })),
			Command.expectExact(WaitBeforeSyncRetry({ session, attempt: 1 })),
			Command.resolve(WaitBeforeSyncRetry, Message.CompletedWaitBeforeSyncRetry({ session, attempt: 1 })),
			Command.expectExact(SyncDraft({ path, base: 1, text: sent })),
			Command.resolve(SyncDraft, reply(1, sent, 2)),
			model((next) => expect(documentOf(next).retryAttempt).toBe(0))
		);
	});

	test('a failed Resync application after Forgotten cannot send edits from the forgotten base', () => {
		const snapshot = `agent\n${original}`;
		const live = `${sent}local\n`;
		const combined = merged(original, snapshot, live);
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Forgotten' })),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 10, text: snapshot } })),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 10, text: snapshot } })),
			Command.resolve(
				ApplyRemoteText,
				Message.FailedApplyRemoteText({ token: 1, reason: 'Composition did not finish in time' })
			),
			whilePending(edited(live, 'Action')),
			Command.expectExact(WaitBeforeRemoteRetry({ session, token: 1 })),
			Command.resolve(WaitBeforeRemoteRetry, Message.CompletedWaitBeforeRemoteRetry({ session, token: 1 })),
			Command.expectExact(ApplyRemoteText({ session, token: 2, from: original, to: snapshot })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
			message(remote(2, combined)),
			Command.expectExact(SyncDraft({ path, base: 10, text: combined })),
			Command.resolve(SyncDraft, reply(10, combined, 11)),
			model((next) => expect(documentOf(next).connection._tag).toBe('Live'))
		);
	});

	test('stops scheduling retries after five attempts', () => {
		const initial = readyModel();
		story(
			update,
			given({
				...initial,
				document: DocumentState.Ready({
					document: {
						...documentOf(initial),
						draft: sent,
						retryAttempt: 5,
						inFlight: Option.some({ base: 1, text: sent })
					}
				})
			}),
			message(Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Transient' })),
			Command.expectNone(),
			model((next) => expect(documentOf(next).retryAttempt).toBe(6))
		);
	});

	test('keeps a failed remote snapshot and settles again after 500 ms', () => {
		story(
			update,
			given(readyModel()),
			message(changed(2, sent)),
			Command.resolve(ApplyRemoteText, Message.FailedApplyRemoteText({ token: 1, reason: 'Editor is not mounted' })),
			model((next) => {
				expect(documentOf(next).draft).toBe(original);
				expect(documentOf(next).pendingRemote._tag).toBe('None');
				expect(Option.getOrThrow(documentOf(next).latestRemote).text).toBe(sent);
			}),
			Command.expectExact(WaitBeforeRemoteRetry({ session, token: 1 })),
			Command.resolve(WaitBeforeRemoteRetry, Message.CompletedWaitBeforeRemoteRetry({ session, token: 1 })),
			Command.expectExact(ApplyRemoteText({ session, token: 2, from: original, to: sent })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
			message(remote(1, 'stale')),
			model((next) => expect(documentOf(next).draft).toBe(original)),
			message(remote(2, sent)),
			model((next) => expect(documentOf(next).draft).toBe(sent))
		);
	});

	test('ignores facts from another session and stale sync replies', () => {
		story(
			update,
			given(readyModel()),
			message(
				Message.UpdatedEditor({ session: 'old', text: 'wrong', anchor: 1, head: 1, origin: 'Action', token: null })
			),
			message(reply(1, 'not sent', 20)),
			model((next) => expect(documentOf(next).draft).toBe(original))
		);
	});

	test('reconnect keeps watch dependencies stable through typing and resumes from the acknowledged version', () => {
		const initialDependencies = subscriptions.watch.modelToDependencies(readyModel());
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.resolve(SyncDraft, reply(1, sent, 2)),
			model((next) => expect(subscriptions.watch.modelToDependencies(next)).toEqual(initialDependencies)),
			message(Message.FailedWatch({ unauthorized: false })),
			Command.expectExact(WaitBeforeReconnect({ attempt: 1 })),
			Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
			model((next) => {
				const dependencies = subscriptions.watch.modelToDependencies(next);
				expect(Option.getOrThrow(dependencies.maybeWatch)).toEqual({
					path,
					watchKey: 1,
					resumeFrom: Option.some({ version: 2 })
				});
			}),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 3, text: `${sent}agent\n` } })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, `${sent}agent\n`)),
			model((next) => {
				expect(documentOf(next).session).toBe(session);
				expect(documentOf(next).connection._tag).toBe('Live');
			})
		);
	});

	test('keeps the hash of each base and sends it with every sync and reconnect', () => {
		const agentText = `${sent}agent\n`;
		story(
			update,
			given(update(makeInitialModel(path, 'mac'), watching(1, original)).model),
			model((next) => expect(documentOf(next).base).toEqual({ version: 1, text: original, hash: hash(1) })),
			message(edited(sent, 'Action')),
			Command.expectExact(SyncDraft({ path, base: 1, text: sent, baseHash: hash(1) })),
			Command.resolve(
				SyncDraft,
				Message.SucceededSync({
					request: { base: 1, text: sent, baseHash: hash(1) },
					version: 2,
					text: sent,
					hash: hash(2)
				})
			),
			model((next) => expect(documentOf(next).base).toEqual({ version: 2, text: sent, hash: hash(2) })),
			message(
				Message.ReceivedWatchEvent({
					event: { _tag: 'Change', from: 2, to: 3, by: [], diff: null, todos: [], hash: hash(3), text: agentText }
				})
			),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, agentText)),
			model((next) => expect(documentOf(next).base).toEqual({ version: 3, text: agentText, hash: hash(3) })),
			message(Message.FailedWatch({ unauthorized: false })),
			Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
			model((next) =>
				expect(Option.getOrThrow(subscriptions.watch.modelToDependencies(next).maybeWatch)).toEqual({
					path,
					watchKey: 1,
					resumeFrom: Option.some({ version: 3, hash: hash(3) })
				})
			)
		);
	});

	test('typing from a base that a restarted daemon gave to another text is rebased over the Resync, not merged', () => {
		const live = `${original}- [ ] Local\n`;
		const restarted = `${original}${Array.from({ length: 15 }, (_, i) => `- [ ] Agent ${i}\n`).join('')}`;
		const combined = merged(original, restarted, live);
		story(
			update,
			given(update(makeInitialModel(path, 'mac'), watching(5, original)).model),
			message(edited(live)),
			// The daemon restarts while the typing waits out its debounce.
			whilePending(Message.FailedWatch({ unauthorized: false })),
			Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 1 })),
			Command.expectExact(
				WaitBeforeReconnect({ attempt: 1 }),
				SyncDraft({ path, base: 5, text: live, baseHash: hash(5) })
			),
			Command.resolve(
				SyncDraft,
				Message.FailedSync({ request: { base: 5, text: live, baseHash: hash(5) }, kind: 'Forgotten' })
			),
			Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
			model((next) => {
				expect(documentOf(next).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true });
				expect(Option.getOrThrow(documentOf(next).resumeFrom)).toEqual({ version: 5, hash: hash(5) });
			}),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 17, hash: hash(17), text: restarted } })),
			Command.expectExact(ApplyRemoteText({ session, token: 1, from: original, to: restarted })),
			Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
			message(remote(1, combined)),
			Command.expectExact(SyncDraft({ path, base: 17, text: combined, baseHash: hash(17) })),
			Command.resolve(
				SyncDraft,
				Message.SucceededSync({
					request: { base: 17, text: combined, baseHash: hash(17) },
					version: 18,
					text: combined,
					hash: hash(18)
				})
			),
			model((next) => {
				expect(saveStatus(documentOf(next))).toBe('Saved');
				expect(documentOf(next).draft.split('- [ ] Local')).toHaveLength(2);
				for (let i = 0; i < 15; i++) expect(documentOf(next).draft.split(`- [ ] Agent ${i}\n`)).toHaveLength(2);
			})
		);
	});

	test('Deleted and Unauthorized stop editing', () => {
		story(
			update,
			given(readyModel()),
			message(Message.ReceivedWatchEvent({ event: { _tag: 'Deleted' } })),
			model((next) => expect(next.document._tag).toBe('Deleted'))
		);
		story(
			update,
			given(readyModel()),
			message(edited(sent, 'Action')),
			Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Unauthorized' })),
			model((next) => expect(next.document._tag).toBe('Unauthorized'))
		);
	});
});

describe('palette update', () => {
	test('opens the Shortcuts palette from the help key fact', () => {
		story(
			update,
			given(readyModel()),
			message(Message.PressedHelpKey()),
			model((next) => {
				expect(next.palette).toEqual({ _tag: 'Open', kind: 'Shortcuts', query: '', active: 0 });
				expect(paletteItems(next, original).some((item) => item.title === 'Continue task')).toBe(true);
			}),
			message(Message.PressedHelpKey()),
			Command.expectExact(FocusEditor({ session })),
			Command.resolve(FocusEditor, Message.CompletedFocusEditor()),
			model((next) => expect(next.palette._tag).toBe('Closed'))
		);
	});

	test('opens, filters by subsequence, and chooses a command against the live editor', () => {
		story(
			update,
			given(readyModel()),
			message(Message.ClickedCommands()),
			message(Message.UpdatedPaletteQuery({ query: 'tGdn' })),
			model((next) => expect(paletteItems(next, original).map((item) => item.title)).toEqual(['Toggle done'])),
			message(Message.PressedPaletteKey({ key: 'Enter' })),
			Command.expectExact(RunEditorAction({ session, action: 'toggleDone' })),
			Command.resolve(RunEditorAction, Message.CompletedRunEditorAction()),
			model((next) => {
				expect(next.palette._tag).toBe('Closed');
				expect(documentOf(next).draft).toBe(original);
			})
		);
	});

	test('Escape closes the palette and restores editor focus', () => {
		story(
			update,
			given(readyModel()),
			message(Message.ClickedCommands()),
			message(Message.PressedPaletteKey({ key: 'ArrowDown' })),
			model((next) => expect(next.palette._tag === 'Open' && next.palette.active).toBe(1)),
			message(Message.PressedPaletteKey({ key: 'ArrowUp' })),
			model((next) => expect(next.palette._tag === 'Open' && next.palette.active).toBe(0)),
			message(Message.PressedPaletteKey({ key: 'Escape' })),
			Command.expectExact(FocusEditor({ session })),
			Command.resolve(FocusEditor, Message.CompletedFocusEditor()),
			model((next) => expect(next.palette._tag).toBe('Closed'))
		);
	});

	test('chooses a theme through the command palette', () => {
		story(
			update,
			given(readyModel()),
			message(Message.ClickedCommands()),
			message(Message.UpdatedPaletteQuery({ query: 'theme dark' })),
			model((next) => expect(paletteItems(next, original).map((item) => item.title)).toEqual(['Theme: Dark'])),
			message(Message.PressedPaletteKey({ key: 'Enter' })),
			Command.expectExact(SetTheme({ theme: 'Dark', dark: true }), FocusEditor({ session })),
			Command.resolve(SetTheme, Message.CompletedSetTheme()),
			Command.resolve(FocusEditor, Message.CompletedFocusEditor()),
			model((next) => {
				expect(next.theme).toBe('Dark');
				expect(next.palette._tag).toBe('Closed');
			})
		);
	});

	test('lists the themes in the commands palette only and marks the current one', () => {
		const opened = update(readyModel(), Message.ClickedCommands()).model;
		const themes = paletteItems(opened, original).filter((item) => item.kind === 'Theme');
		expect(themes.map((item) => item.title)).toEqual(['Theme: System', 'Theme: Light', 'Theme: Dark']);
		expect(themes[0]?.detail.startsWith('Current')).toBe(true);
		expect(themes[1]?.detail.startsWith('Current')).toBe(false);
		const shortcuts = update(readyModel(), Message.PressedHelpKey()).model;
		expect(paletteItems(shortcuts, original).some((item) => item.kind === 'Theme')).toBe(false);
	});

	test('follows the system theme only while the theme is System', () => {
		const system = readyModel();
		expect(subscriptions.systemTheme.modelToDependencies(system)).toEqual({ follows: true });
		story(
			update,
			given(system),
			message(Message.ChangedSystemTheme({ dark: true })),
			Command.expectExact(ApplyTheme({ dark: true })),
			Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
			model((next) => expect(next.systemDark).toBe(true))
		);
		const light = { ...system, theme: 'Light' as const };
		expect(subscriptions.systemTheme.modelToDependencies(light)).toEqual({ follows: false });
		const result = update(light, Message.ChangedSystemTheme({ dark: true }));
		expect(result.model.systemDark).toBe(true);
		expect(result.commands ?? []).toEqual([]);
	});

	test('navigates projects and exposes shortcuts through the palette', () => {
		const text = '# First\n\n## Second\n';
		story(
			update,
			given(readyModel(text)),
			message(Message.PressedEditorCommand({ command: 'gotoProject' })),
			message(Message.UpdatedPaletteQuery({ query: 'scd' })),
			message(Message.ClickedPaletteItem({ index: 0 })),
			Command.expectExact(RevealEditorPosition({ session, offset: text.indexOf('Second') })),
			Command.resolve(RevealEditorPosition, Message.CompletedRevealEditorPosition()),
			message(Message.PressedEditorCommand({ command: 'showShortcuts' })),
			model((next) => expect(paletteItems(next, text).some((item) => item.title === 'Continue task')).toBe(true))
		);
	});
});
