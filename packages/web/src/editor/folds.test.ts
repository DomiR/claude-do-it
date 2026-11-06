import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState, Transaction, type Extension, type StateCommand } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import type { EditorView, ViewUpdate } from '@codemirror/view';

import { classifiedDocument } from './document';
import { remoteTransaction } from './facts';
import {
	FoldPersistence,
	foldAll,
	foldExtensions,
	foldState,
	isFoldOpen,
	revealFoldPositions,
	setAllFoldsOpen,
	setFoldOpen,
	toggleFold,
	unfoldAll,
	type FoldStorage
} from './folds';

const create = (
	text: string,
	extensions: Extension = foldExtensions(),
	selection = EditorSelection.single(0)
): EditorState =>
	EditorState.create({
		doc: text,
		selection,
		extensions: [
			EditorState.lineSeparator.of('\n'),
			EditorState.allowMultipleSelections.of(true),
			history(),
			extensions
		]
	});
const candidate = (state: EditorState, label: string) =>
	state.field(foldState).candidates.find((value) => value.identityLabel === label)!;
const open = (state: EditorState, label: string) => isFoldOpen(state.field(foldState), candidate(state, label));
const choose = (state: EditorState, label: string, value: boolean) =>
	state.update({
		effects: setFoldOpen.of({ key: candidate(state, label).key, open: value })
	}).state;
const run = (initial: EditorState, command: StateCommand) => {
	let state = initial;
	let transactions = 0;
	const handled = command({
		state,
		dispatch: (transaction) => {
			state = transaction.state;
			transactions += 1;
		}
	});
	return { state, handled, transactions };
};
const mixed =
	'# Project\n- [ ] Task\n  <details><summary>Explanation</summary>\n  hidden text\n  </details>\n# Next\nvisible';

class MemoryStorage implements FoldStorage {
	readonly data = new Map<string, string>();
	writes = 0;
	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.writes += 1;
		this.data.set(key, value);
	}
}
const persistence = (state: EditorState) => {
	const page = new EventTarget();
	const plugin = new FoldPersistence({ state, dom: { ownerDocument: { defaultView: page } } } as unknown as EditorView);
	return { plugin, page };
};

describe('fold state', () => {
	test('one field holds mixed ranges with per-kind defaults and open details overrides', () => {
		const state = create(`${mixed}\n<details open><summary>Already open</summary>\nbody\n</details>`);
		const folds = state.field(foldState);
		expect(folds.candidates.map((value) => value.kind)).toEqual(['heading', 'task', 'details', 'heading', 'details']);
		expect(open(state, 'Project')).toBe(true);
		expect(open(state, 'Task')).toBe(true);
		expect(open(state, 'Explanation')).toBe(false);
		expect(open(state, 'Already open')).toBe(true);
		expect(folds.choices.size).toBe(0);
		const ranges: string[] = [];
		folds.folded.between(0, state.doc.length, (from, to, value) => {
			expect({ from, to }).toEqual(candidate(state, 'Explanation').hidden);
			ranges.push(value.key);
		});
		expect(ranges).toEqual([candidate(state, 'Explanation').key]);
	});

	test('details arriving through a remote transaction start closed', () => {
		const state = create('Introduction\n');
		const next = state.update({
			changes: { from: state.doc.length, insert: '<details><summary>Arrived</summary>\nbody\n</details>' },
			annotations: [remoteTransaction.of(1), Transaction.addToHistory.of(false)]
		}).state;
		expect(open(next, 'Arrived')).toBe(false);
		expect(next.field(foldState).choices.size).toBe(0);
		expect(undoDepth(next)).toBe(0);
	});

	test('remote append at a folded task end extends its hidden range without opening it', () => {
		let state = choose(create('- [ ] Task\n  note\n- [ ] Peer'), 'Task', false);
		const before = candidate(state, 'Task');
		state = state.update({
			changes: { from: before.to, insert: '\n  remote note' },
			annotations: remoteTransaction.of(2)
		}).state;
		const after = candidate(state, 'Task');
		expect(after.key).toBe(before.key);
		expect(after.hiddenLines).toBe(before.hiddenLines + 1);
		expect(after.hidden.to).toBe(before.to + '\n  remote note'.length);
		expect(open(state, 'Task')).toBe(false);
	});

	test('local edits touching a closed body or its final endpoint reveal surviving folds', () => {
		for (const [text, label, insert] of [
			['# Project\nbody\n# Next', 'Project', ' typed'],
			['- [ ] Task\n  note\n- [ ] Peer', 'Task', '\n  pasted note'],
			['<details><summary>Section</summary>\nbody\n</details>', 'Section', '\ntext']
		] as const) {
			let state = choose(create(text), label, false);
			const end = candidate(state, label).hidden.to;
			state = state.update({ changes: { from: end, insert }, userEvent: 'input.type' }).state;
			expect(state.selection.main.head).toBe(0);
			expect(open(state, label)).toBe(true);
		}
		let state = run(create(mixed), foldAll).state;
		state = state.update({
			changes: { from: mixed.indexOf('hidden text'), insert: 'new ' },
			userEvent: 'input.paste'
		}).state;
		expect(['Project', 'Task', 'Explanation'].map((label) => open(state, label))).toEqual([true, true, true]);
		expect(open(state, 'Next')).toBe(false);
		state = choose(create('- [ ] Task\n  old body'), 'Task', false);
		state = state.update({
			changes: { from: 0, to: state.doc.length, insert: '- [ ] Task\n  new body' },
			userEvent: 'input.paste'
		}).state;
		expect(open(state, 'Task')).toBe(true);
	});

	test('local deletions touching the final hidden endpoint reveal the remaining body', () => {
		for (const crossesHeader of [false, true]) {
			const initial = choose(create('- [ ] Task\n  note\n- [ ] Peer'), 'Task', false);
			const fold = candidate(initial, 'Task');
			const state = initial.update({
				changes: crossesHeader
					? { from: fold.hidden.from - 1, to: fold.hidden.from + 2, insert: 'renamed\n  ' }
					: { from: fold.hidden.to, to: fold.hidden.to + 1 },
				userEvent: 'delete.forward'
			}).state;
			expect(open(state, crossesHeader ? 'Tasrenamed' : 'Task')).toBe(true);
		}
	});

	test('remote append maps a placeholder end caret after new lines while the task stays folded', () => {
		for (const tail of ['', '\n- [ ] Peer']) {
			let state = choose(create('- [ ] Task\n  note' + tail), 'Task', false);
			const before = candidate(state, 'Task');
			state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(before.hidden.to, -1)]) }).state;
			expect(open(state, 'Task')).toBe(false);
			const insert = '\n  remote note';
			state = state.update({ changes: { from: before.hidden.to, insert }, annotations: remoteTransaction.of(2) }).state;
			const after = candidate(state, 'Task');
			expect(after.hiddenLines).toBe(before.hiddenLines + 1);
			expect(state.selection.main.head).toBe(before.hidden.to + insert.length);
			expect(state.selection.main.head).toBe(after.hidden.to);
			expect(open(state, 'Task')).toBe(false);
		}
	});

	test('remote appends map multiple boundary carets and preserve their main index', () => {
		let state = run(create('- [ ] First\n  one\n- [ ] Second\n  two'), foldAll).state;
		const before = state.field(foldState).candidates;
		state = state.update({
			selection: EditorSelection.create(
				before.map((fold) => EditorSelection.cursor(fold.hidden.to, -1)),
				1
			)
		}).state;
		state = state.update({
			changes: before.map((fold) => ({ from: fold.hidden.to, insert: '\n  more' })),
			annotations: remoteTransaction.of(2)
		}).state;
		expect(state.selection.ranges.map((range) => range.head)).toEqual(
			state.field(foldState).candidates.map((fold) => fold.hidden.to)
		);
		expect(state.selection.mainIndex).toBe(1);
		expect(state.field(foldState).folded.size).toBe(2);
	});

	test('explicit remote selections away from a former boundary still reveal their target', () => {
		let state = choose(create('- [ ] Task\n  note'), 'Task', false);
		const before = candidate(state, 'Task');
		state = state.update({ selection: { anchor: before.hidden.to } }).state;
		state = state.update({
			changes: { from: before.hidden.to, insert: '\n  more' },
			selection: { anchor: before.hidden.from + 2 },
			annotations: remoteTransaction.of(2)
		}).state;
		expect(state.selection.main.head).toBe(before.hidden.from + 2);
		expect(open(state, 'Task')).toBe(true);
	});

	test('project ranges grow at EOF and stop when a new peer arrives', () => {
		let state = choose(create('# Project\nbody'), 'Project', false);
		state = state.update({
			changes: { from: state.doc.length, insert: '\nmore' },
			annotations: remoteTransaction.of(3)
		}).state;
		expect(candidate(state, 'Project').hiddenLines).toBe(2);
		state = state.update({
			changes: { from: state.doc.length, insert: '\n# Peer\npeer body' },
			annotations: remoteTransaction.of(3)
		}).state;
		expect(state.doc.sliceString(candidate(state, 'Project').hidden.from, candidate(state, 'Project').to)).toBe(
			'\nbody\nmore'
		);
		expect(open(state, 'Project')).toBe(false);
		expect(open(state, 'Peer')).toBe(true);
	});

	test('checking and stamping a task preserves its key and choice', () => {
		let state = choose(create('- [ ] Task @today\n  note'), 'Task @today', false);
		const key = candidate(state, 'Task @today').key;
		state = state.update({
			changes: [
				{ from: 3, to: 4, insert: 'x' },
				{ from: state.doc.line(1).to, insert: ' @done(26-11-06 10:00) @lasted(0:05)' }
			]
		}).state;
		expect(candidate(state, 'Task @today').key).toBe(key);
		expect(open(state, 'Task @today')).toBe(false);
	});

	test('renames keep explicit choices by mapped header anchor', () => {
		let state = choose(create('# Project\nbody\n- [ ] Task\n  note'), 'Task', false);
		const oldKey = candidate(state, 'Task').key;
		const from = state.doc.toString().indexOf('Task');
		state = state.update({ changes: { from, to: from + 4, insert: 'Renamed' } }).state;
		expect(open(state, 'Renamed')).toBe(false);
		expect(state.field(foldState).choices.has(oldKey)).toBe(false);
		expect(state.field(foldState).choices.get(candidate(state, 'Renamed').key)).toBe('closed');
		const header = state.doc.line(candidate(state, 'Renamed').headerLine + 1);
		state = state.update({ changes: { from: header.from, to: header.to, insert: '- [ ] Whole header rename' } }).state;
		expect(open(state, 'Whole header rename')).toBe(false);
	});

	test('mapped occurrence choices are consumed once when duplicate headers shift', () => {
		let state = create('- [ ] Same\n  first\n- [ ] Same\n  second');
		const [first, second] = state.field(foldState).candidates;
		state = state.update({
			effects: [setFoldOpen.of({ key: first!.key, open: false }), setFoldOpen.of({ key: second!.key, open: true })]
		}).state;
		state = state.update({ changes: { from: 0, insert: '- [ ] Same\n  new\n' }, selection: { anchor: 0 } }).state;
		const folds = state.field(foldState);
		expect(folds.candidates.map((value) => isFoldOpen(folds, value))).toEqual([true, false, true]);
		expect([...folds.choices]).toEqual([
			['v1:task:Same#1', 'closed'],
			['v1:task:Same#2', 'open']
		]);
		state = choose(create('- [ ] Same\n  first\n- [ ] Same\n  second'), 'Same', false);
		state = state.update({ changes: { from: 0, to: '- [ ] Same\n  first\n'.length }, selection: { anchor: 0 } }).state;
		expect(open(state, 'Same')).toBe(true);
		expect(state.field(foldState).choices.size).toBe(0);
	});

	test('moves and archive tags retain choices by key after anchors are replaced', () => {
		let state = choose(create('- [x] First\n  first note\n- [ ] Second\n  second note'), 'First', false);
		const moved = '- [ ] Second\n  second note\n## Archive\n- [x] First @project(Old)\n  first note';
		state = state.update({ changes: { from: 0, to: state.doc.length, insert: moved }, selection: { anchor: 0 } }).state;
		expect(open(state, 'First')).toBe(false);
		expect(open(state, 'Second')).toBe(true);
		expect(candidate(state, 'First').key).toBe('v1:task:First#0');
	});

	test('unique ids survive title replacement while new kinds and unrelated replacements use defaults', () => {
		let state = choose(create('<details id="stable"><summary>Old</summary>\nbody\n</details>'), 'Old', true);
		state = state.update({
			changes: { from: 0, to: state.doc.line(1).to, insert: '<details id="stable"><summary>New</summary>' }
		}).state;
		expect(open(state, 'New')).toBe(true);
		state = choose(create('# Old\n  body'), 'Old', false);
		state = state.update({ changes: { from: 0, to: 5, insert: '- [ ] Old' }, selection: { anchor: 0 } }).state;
		expect(candidate(state, 'Old').kind).toBe('task');
		expect(open(state, 'Old')).toBe(true);
		state = choose(state, 'Old', false);
		state = state.update({
			changes: { from: 0, to: state.doc.length, insert: '- [ ] Unrelated\n  new body' },
			selection: { anchor: 0 }
		}).state;
		expect(open(state, 'Unrelated')).toBe(true);
	});

	test('removing the last child retains a bounded choice for undo', () => {
		let state = choose(create('- [ ] Task\n  note'), 'Task', false);
		state = state.update({ changes: { from: state.doc.line(1).to, to: state.doc.length } }).state;
		expect(state.field(foldState).candidates).toEqual([]);
		expect(state.field(foldState).choices.get('v1:task:Task#0')).toBe('closed');
		const restored = run(state, undo);
		expect(restored.handled).toBe(true);
		expect(open(restored.state, 'Task')).toBe(false);
	});

	test('all commands are snapshots and leave text and undo history unchanged', () => {
		for (const command of [foldAll, unfoldAll]) {
			const initial = create(mixed);
			const result = run(initial, command);
			expect(result.handled).toBe(true);
			expect(result.transactions).toBe(1);
			expect(result.state.doc.toString()).toBe(mixed);
			expect(undoDepth(result.state)).toBe(0);
			expect(open(result.state, 'Explanation')).toBe(command === unfoldAll);
			const state = result.state.update({
				changes: {
					from: result.state.doc.length,
					insert: '\n# New project\n- [ ] New task\n  note\n<details><summary>New details</summary>\nbody\n</details>'
				},
				annotations: remoteTransaction.of(4)
			}).state;
			expect(open(state, 'New project')).toBe(true);
			expect(open(state, 'New task')).toBe(true);
			expect(open(state, 'New details')).toBe(false);
		}
	});

	test('search selections reveal every containing ancestor and persist the reveal', () => {
		let state = run(create(mixed), foldAll).state;
		const from = mixed.indexOf('hidden text');
		state = state.update({ selection: { anchor: from, head: from + 6 }, userEvent: 'select.search' }).state;
		expect(['Project', 'Task', 'Explanation'].map((label) => open(state, label))).toEqual([true, true, true]);
		expect(state.selection.main.from).toBe(from);
		expect(state.selection.main.to).toBe(from + 6);
		expect(state.field(foldState).choices.get(candidate(state, 'Explanation').key)).toBe('open');
		expect(open(state, 'Next')).toBe(false);
	});

	test('initial and direct multi-selections reveal bodies but spanning selections do not', () => {
		const inside = mixed.indexOf('hidden text');
		expect(open(create(mixed, foldExtensions(), EditorSelection.single(inside)), 'Explanation')).toBe(true);
		let state = run(create(mixed), foldAll).state;
		const across = state.update({ selection: { anchor: 0, head: mixed.length } }).state;
		expect(open(across, 'Explanation')).toBe(false);
		state = state.update({
			selection: EditorSelection.create(
				[EditorSelection.cursor(inside), EditorSelection.cursor(mixed.indexOf('visible'))],
				1
			)
		}).state;
		expect(state.field(foldState).folded.size).toBe(0);
		expect(state.selection.mainIndex).toBe(1);
	});

	test('remote caret mapping into a hidden body opens it', () => {
		const text = '- [ ] Task\n  note';
		let state = choose(create(text, foldExtensions(), EditorSelection.single(text.indexOf('\n'))), 'Task', false);
		const insertion = '\n  inserted ';
		state = state.update({
			changes: { from: state.doc.line(1).to - 2, insert: insertion },
			annotations: remoteTransaction.of(5)
		}).state;
		expect(state.selection.main.head).toBe('- [ ] Task'.length + insertion.length);
		expect(open(state, 'Ta')).toBe(true);
	});

	test('closing relocates every contained endpoint in the same transaction', () => {
		const text = '# First\nfirst body\n# Second\nsecond body';
		const initial = create(
			text,
			foldExtensions(),
			EditorSelection.create(
				[
					EditorSelection.range(text.indexOf('first body'), text.indexOf('first body') + 4),
					EditorSelection.range(text.indexOf('second body') + 5, text.indexOf('second body'))
				],
				1
			)
		);
		const result = run(initial, foldAll);
		expect(result.transactions).toBe(1);
		expect(result.state.selection.ranges.map((range) => [range.anchor, range.head])).toEqual([
			[initial.doc.line(1).to, initial.doc.line(1).to],
			[initial.doc.line(3).to, initial.doc.line(3).to]
		]);
		expect(result.state.selection.mainIndex).toBe(1);
		expect(result.state.field(foldState).folded.size).toBe(2);

		let state = create(mixed, foldExtensions(), EditorSelection.single(0, mixed.indexOf('hidden text')));
		state = choose(state, 'Explanation', false);
		expect(state.selection.main.anchor).toBe(0);
		expect(state.selection.main.head).toBe(candidate(state, 'Explanation').hidden.from);
		expect(open(state, 'Explanation')).toBe(false);
	});

	test('closing nested folds targets the outermost new header and preserves child choices', () => {
		let state = create(mixed, foldExtensions(), EditorSelection.single(mixed.indexOf('hidden text')));
		state = state.update({
			effects: [setAllFoldsOpen.of(false), setFoldOpen.of({ key: candidate(state, 'Task').key, open: true })]
		}).state;
		expect(state.selection.main.head).toBe(state.doc.line(1).to);
		expect(open(state, 'Explanation')).toBe(false);
		state = choose(state, 'Project', true);
		expect(open(state, 'Task')).toBe(true);
		expect(open(state, 'Explanation')).toBe(false);
	});

	test('closing with a text change uses the new header and final effect order', () => {
		let state = create('# Project\nbody', foldExtensions(), EditorSelection.single(11));
		const key = candidate(state, 'Project').key;
		state = state.update({
			changes: { from: 2, to: 9, insert: 'Renamed project' },
			effects: setFoldOpen.of({ key, open: false })
		}).state;
		expect(state.selection.main.head).toBe(state.doc.line(1).to);
		expect(open(state, 'Renamed project')).toBe(false);
		state = state.update({ effects: [setAllFoldsOpen.of(false), setAllFoldsOpen.of(true)] }).state;
		expect(open(state, 'Renamed project')).toBe(true);
	});

	test('toggle chooses headers and innermost bodies and handles missing targets', () => {
		let state = create(mixed, foldExtensions(), EditorSelection.single(mixed.indexOf('Explanation')));
		state = run(state, toggleFold).state;
		expect(open(state, 'Explanation')).toBe(true);
		state = state.update({ selection: { anchor: mixed.indexOf('hidden text') } }).state;
		state = run(state, toggleFold).state;
		expect(open(state, 'Explanation')).toBe(false);
		expect(state.selection.main.head).toBe(candidate(state, 'Explanation').hidden.from);
		for (const command of [toggleFold, foldAll, unfoldAll]) {
			expect(run(create('plain'), command).handled).toBe(false);
			expect(run(EditorState.create({ doc: 'plain' }), command).handled).toBe(false);
		}
	});

	test('effect-only and selection-only transactions reuse classification and candidates', () => {
		const initial = create(mixed);
		const state = choose(initial, 'Task', false).update({ selection: { anchor: 2 } }).state;
		expect(state.field(classifiedDocument)).toBe(initial.field(classifiedDocument));
		expect(state.field(foldState).candidates).toBe(initial.field(foldState).candidates);
		expect(state.update({}).state.field(foldState)).toBe(state.field(foldState));
		const revealed = state.update({ effects: revealFoldPositions.of([mixed.indexOf('hidden text')]) }).state;
		expect(open(revealed, 'Task')).toBe(true);
		expect(open(revealed, 'Explanation')).toBe(true);
	});
});

describe('fold persistence', () => {
	test('reloads explicit choices only for the same path and tab store', () => {
		const storage = new MemoryStorage();
		const options = { path: '/tmp/TODO.md', storage };
		const state = choose(choose(create(mixed, foldExtensions(options)), 'Explanation', true), 'Task', false);
		const { plugin } = persistence(state);
		try {
			expect(storage.writes).toBe(0);
			plugin.flush();
			expect(storage.writes).toBe(1);
			const saved = JSON.parse(storage.data.get('do-it:folds:v1:/tmp/TODO.md')!);
			expect(saved.version).toBe(1);
			expect(saved.choices).toHaveLength(2);
			const loaded = create(mixed, foldExtensions(options));
			expect(open(loaded, 'Explanation')).toBe(true);
			expect(open(loaded, 'Task')).toBe(false);
			persistence(loaded).plugin.destroy();
			expect(storage.writes).toBe(1);
			expect(open(create(mixed, foldExtensions({ ...options, path: '/tmp/OTHER.md' })), 'Task')).toBe(true);
			expect(open(create(mixed, foldExtensions({ ...options, storage: new MemoryStorage() })), 'Explanation')).toBe(
				false
			);
		} finally {
			plugin.destroy();
		}
	});

	test('batches updates and flushes the latest choices on pagehide and destroy', () => {
		const storage = new MemoryStorage();
		let state = create(mixed, foldExtensions({ path: '/todo', storage }));
		const { plugin, page } = persistence(state);
		try {
			const update = (next: EditorState) => {
				plugin.update({ startState: state, state: next } as ViewUpdate);
				state = next;
			};
			update(choose(state, 'Task', false));
			update(choose(state, 'Task', true));
			expect(storage.writes).toBe(0);
			page.dispatchEvent(new Event('pagehide'));
			expect(storage.writes).toBe(1);
			expect(JSON.parse(storage.data.get('do-it:folds:v1:/todo')!).choices).toEqual([['v1:task:Task#0', 'open']]);
			update(state.update({ selection: { anchor: 2 } }).state);
			plugin.flush();
			expect(storage.writes).toBe(1);
			update(choose(state, 'Task', false));
		} finally {
			plugin.destroy();
		}
		expect(storage.writes).toBe(2);
		page.dispatchEvent(new Event('pagehide'));
		expect(storage.writes).toBe(2);
	});

	test('corrupt, denied, and quota-limited storage retain a memory fallback', () => {
		const stores: FoldStorage[] = [
			{
				getItem: () => '{bad',
				setItem: () => {
					throw new Error('Should use memory');
				}
			},
			{ getItem: () => JSON.stringify({ version: 2, choices: [] }), setItem: () => {} },
			{ getItem: () => JSON.stringify({ version: 1, choices: [['v1:task:Task#0', 'invalid']] }), setItem: () => {} },
			{
				getItem: () => {
					throw new Error('Denied');
				},
				setItem: () => {
					throw new Error('Denied');
				}
			},
			{
				getItem: () => null,
				setItem: () => {
					throw new Error('Quota');
				}
			}
		];
		for (const storage of stores) {
			const extension = foldExtensions({ path: '/todo', storage });
			const state = choose(create(mixed, extension), 'Task', false);
			const { plugin } = persistence(state);
			plugin.destroy();
			expect(open(create(mixed, extension), 'Task')).toBe(false);
		}
	});

	test('denied sessionStorage lookup does not prevent editor state creation', () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: {
				get sessionStorage() {
					throw new Error('Denied');
				}
			}
		});
		try {
			expect(open(create(mixed, foldExtensions({ path: '/todo' })), 'Explanation')).toBe(false);
		} finally {
			if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
			else Reflect.deleteProperty(globalThis, 'window');
		}
	});

	test('saves the newest 500 choices without limiting live fold-all ranges', () => {
		const storage = new MemoryStorage();
		const text = Array.from({ length: 510 }, (_, index) => `- [ ] Task ${index}\n  note`).join('\n');
		const state = run(create(text, foldExtensions({ path: '/todo', storage })), foldAll).state;
		expect(state.field(foldState).folded.size).toBe(510);
		const { plugin } = persistence(state);
		plugin.destroy();
		const saved = JSON.parse(storage.data.get('do-it:folds:v1:/todo')!);
		expect(saved.choices).toHaveLength(500);
		expect(saved.choices[0]).toEqual(['v1:task:Task 10#0', 'closed']);
		expect(saved.choices.at(-1)).toEqual(['v1:task:Task 509#0', 'closed']);
	});
});
