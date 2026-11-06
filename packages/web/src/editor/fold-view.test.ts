import { describe, expect, test } from 'bun:test';
import { EditorState, Transaction, type RangeSet, type RangeValue, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';

import { documentDecorations, editorExtensions } from './extensions';
import { DetailsEnd, FoldGutterMarker, FoldHover, FoldPlaceholder, foldViewState } from './fold-view';
import { foldState, isFoldOpen, setAllFoldsOpen, setFoldOpen } from './folds';

const stateFor = (text: string, anchor = 0): EditorState =>
	EditorState.create({
		doc: text,
		selection: { anchor },
		extensions: [editorExtensions('other')]
	});
const collect = <T extends RangeValue>(set: RangeSet<T>, length: number) => {
	const result: Array<{ from: number; to: number; value: T }> = [];
	set.between(0, length, (from, to, value) => {
		result.push({ from, to, value });
	});
	return result;
};
const decorations = (state: EditorState) => collect(state.field(foldViewState).decorations, state.doc.length);
const replacements = (state: EditorState) => collect(state.field(foldViewState).atomicRanges, state.doc.length);
const placeholders = (state: EditorState) =>
	decorations(state).filter((range) => range.value.spec.widget instanceof FoldPlaceholder);
const ends = (state: EditorState) =>
	decorations(state).filter((range) => range.value.spec.widget instanceof DetailsEnd);
const markers = (state: EditorState) => collect(state.field(foldViewState).markers, state.doc.length);
const candidate = (state: EditorState, label: string) =>
	state.field(foldState).candidates.find((value) => value.identityLabel === label)!;
const open = (state: EditorState, label: string, value: boolean): EditorState =>
	state.update({
		effects: setFoldOpen.of({ key: candidate(state, label).key, open: value })
	}).state;

interface FakeEvent {
	preventDefault(): void;
	stopPropagation(): void;
}
interface FakeElement {
	tagName: string;
	className: string;
	textContent: string;
	type: string;
	tabIndex: number;
	attributes: Record<string, string>;
	children: FakeElement[];
	onmousedown?: (event: FakeEvent) => void;
	onclick?: (event: FakeEvent) => void;
	setAttribute(name: string, value: string): void;
	append(...children: FakeElement[]): void;
}
const element = (tagName: string): FakeElement => ({
	tagName,
	className: '',
	textContent: '',
	type: '',
	tabIndex: 0,
	attributes: {},
	children: [],
	setAttribute(name, value) {
		this.attributes[name] = value;
	},
	append(...children) {
		this.children.push(...children);
	}
});
const fakeView = (initial: EditorState) => {
	let state = initial;
	let dispatches = 0;
	let focuses = 0;
	const view = {
		get state() {
			return state;
		},
		dom: { ownerDocument: { createElement: element } },
		dispatch(spec: Transaction | TransactionSpec) {
			state = spec instanceof Transaction ? spec.state : state.update(spec).state;
			dispatches += 1;
		},
		focus() {
			focuses += 1;
		},
		documentTop: 100,
		lineBlockAtHeight(height: number) {
			const line = state.doc.line(Math.min(state.doc.lines, Math.max(1, Math.floor(height / 20) + 1)));
			return { from: line.from, top: (line.number - 1) * 20, bottom: line.number * 20 };
		}
	} as unknown as EditorView;
	return {
		view,
		get dispatches() {
			return dispatches;
		},
		get focuses() {
			return focuses;
		}
	};
};
const click = (node: FakeElement): string[] => {
	const calls: string[] = [];
	const event = {
		preventDefault: () => {
			calls.push('prevent');
		},
		stopPropagation: () => {
			calls.push('stop');
		}
	};
	node.onmousedown?.(event);
	node.onclick?.(event);
	return calls;
};
const mixed = '# Project\n- [ ] Task\n  <details><summary>Explanation</summary>\n  **body**\n  </details>\n# Leaf';

describe('fold rendering', () => {
	test('each kind hides its body with one inline placeholder and an atomic range', () => {
		for (const text of [
			'# Project\nbody\n# Leaf',
			'- [ ] Task\n  note\n- [ ] Leaf',
			'<details><summary>Section</summary>\nbody\n</details>\nafter'
		]) {
			let state = stateFor(text);
			const fold = state.field(foldState).candidates[0]!;
			state = state.update({ effects: setFoldOpen.of({ key: fold.key, open: false }) }).state;
			const collapsed = placeholders(state);
			expect(collapsed).toHaveLength(1);
			expect({ from: collapsed[0]!.from, to: collapsed[0]!.to }).toEqual(fold.hidden);
			expect(collapsed[0]!.value.spec.block).not.toBe(true);
			expect(replacements(state).some((range) => range.from === fold.hidden.from && range.to === fold.hidden.to)).toBe(
				true
			);
			expect(state.doc.sliceString(fold.hidden.to).startsWith('\n')).toBe(true);
			const { view } = fakeView(state);
			expect(
				state.facet(EditorView.atomicRanges).some((source) => source(view) === state.field(foldViewState).atomicRanges)
			).toBe(true);
			expect(state.facet(EditorView.decorations)).toContain(state.field(foldViewState).decorations);
		}
	});

	test('only outermost folded ranges render and reopening preserves nested choices', () => {
		let state = stateFor(mixed).update({ effects: setAllFoldsOpen.of(false) }).state;
		expect(state.field(foldState).folded.size).toBe(3);
		expect(placeholders(state).map((range) => range.value.spec.widget.label)).toEqual(['Project']);
		expect(markers(state).map((range) => (range.value as FoldGutterMarker).label)).toEqual(['Project']);
		expect(ends(state)).toEqual([]);
		state = open(state, 'Project', true);
		expect(placeholders(state).map((range) => range.value.spec.widget.label)).toEqual(['Task']);
		expect(markers(state).map((range) => (range.value as FoldGutterMarker).label)).toEqual(['Project', 'Task']);
		state = open(state, 'Task', true);
		expect(placeholders(state).map((range) => range.value.spec.widget.label)).toEqual(['Explanation']);
		expect(markers(state)).toHaveLength(3);
		expect(isFoldOpen(state.field(foldState), candidate(state, 'Explanation'))).toBe(false);
	});

	test('one-line details hide their tags and keep title formatting within its span', () => {
		const text = '  <details id="hidden"><summary>**Title** `code` @today</summary>\n  body\n  </details>';
		const state = stateFor(text);
		const block = state.field(documentDecorations).classified.blocks.details[0]!;
		const tags = replacements(state).filter((range) => !range.value.spec.widget);
		expect(tags.map((range) => text.slice(range.from, range.to))).toEqual([
			'<details id="hidden"><summary>',
			'</summary>'
		]);
		const title = decorations(state).find((range) => range.value.spec.class === 'pt-details-title')!;
		expect({ from: title.from, to: title.to }).toEqual(block.title);
		const base = collect(state.field(documentDecorations).decorations, state.doc.length).filter(
			(range) => range.from < range.to
		);
		expect(base.every((range) => range.from >= block.title.from && range.to <= block.title.to)).toBe(true);
		expect(base.map((range) => range.value.spec.class).filter(Boolean)).toEqual([
			'pt-strong',
			'pt-code',
			'pt-tag pt-tag-today'
		]);
	});

	test('two-line details remove the opener row and place their marker beside the summary', () => {
		const text = '    <details>\r\n    <summary>Title</summary>\r\n    body\r\n    </details>\r\n';
		const state = stateFor(text);
		const block = state.field(documentDecorations).classified.blocks.details[0]!;
		const prefix = replacements(state).find((range) => range.from === block.from)!;
		expect(prefix.to).toBe(block.title.from);
		expect(text.slice(prefix.from, prefix.to)).toBe('    <details>\r\n    <summary>');
		const header = decorations(state).find((range) => range.value.spec.class?.includes('pt-details-header-two-line'))!;
		expect(header.from).toBe(block.from);
		expect(header.value.spec.attributes.style).toBe('--pt-details-indent: 4');
		expect(markers(state).map((range) => range.from)).toEqual([block.from]);
		expect(state.field(foldViewState).headers.get(block.from)?.headerLine).toBe(block.summaryLine);
		expect(replacements(state).every((range) => range.from >= 0 && range.to <= text.length)).toBe(true);
	});

	test('open details keep their closer row with an aria-hidden end widget', () => {
		const text = '<details open><summary>Title</summary>\nbody\n  </details>\nafter';
		let state = stateFor(text);
		expect(placeholders(state)).toEqual([]);
		expect(ends(state)).toHaveLength(1);
		const end = ends(state)[0]!;
		expect(text.slice(end.from, end.to)).toBe('</details>');
		expect(text.slice(end.to)).toBe('\nafter');
		const node = (end.value.spec.widget as DetailsEnd).toDOM(fakeView(state).view) as unknown as FakeElement;
		expect(node.attributes['aria-hidden']).toBe('true');
		expect(node.textContent).toBe('');
		expect(node.className).toBe('pt-details-end');
		state = open(state, 'Title', false);
		expect(ends(state)).toEqual([]);
		expect(placeholders(state)).toHaveLength(1);
	});

	test('diagnostic delimiters remain plain visible text and marked HTML stays out of base decorations', () => {
		const text = '<details>\n<summary>**Unclosed**</summary>\nvisible\n```html do-it\n**payload**\n```';
		const state = stateFor(text);
		expect(decorations(state)).toEqual([]);
		const document = state.field(documentDecorations);
		const base = collect(document.decorations, state.doc.length);
		for (const line of document.classified.lines.filter((line) => line.blockRole !== undefined)) {
			expect(base.some((range) => range.from >= line.from && range.from <= line.to)).toBe(false);
		}
		expect(base.some((range) => range.value.spec.class === 'pt-line-prose')).toBe(true);
		const ordinary = stateFor('```html\n<p>code</p>\n```');
		expect(collect(ordinary.field(documentDecorations).decorations, ordinary.doc.length)).toHaveLength(3);
	});

	test('base decorations never overlap hidden fold bodies or details delimiters', () => {
		let state = stateFor(mixed);
		for (const label of ['Explanation', 'Task', 'Project']) {
			for (const value of [true, false]) {
				state = open(state, label, value);
				const base = collect(state.field(documentDecorations).decorations, state.doc.length);
				for (const hidden of replacements(state)) {
					for (const range of base) {
						expect(
							range.from === range.to
								? range.from <= hidden.from || range.from >= hidden.to
								: range.to <= hidden.from || range.from >= hidden.to
						).toBe(true);
					}
				}
			}
		}
	});

	test('placeholder counts, labels, equality, and tab behavior match the folded block', () => {
		const { view } = fakeView(stateFor('plain'));
		for (const count of [0, 1, 12]) {
			const widget = new FoldPlaceholder('key', 'Explanation', count);
			const node = widget.toDOM(view) as unknown as FakeElement;
			expect(node.textContent).toBe(`… ${count} ${count === 1 ? 'line' : 'lines'}`);
			expect(node.attributes['aria-label']).toBe(
				`Unfold Explanation, ${count} hidden ${count === 1 ? 'line' : 'lines'}`
			);
			expect(node.attributes['aria-expanded']).toBe('false');
			expect(node.tabIndex).toBe(-1);
			expect(node.type).toBe('button');
			expect(widget.ignoreEvent()).toBe(true);
			expect(widget.eq(new FoldPlaceholder('key', 'Explanation', count))).toBe(true);
			expect(widget.eq(new FoldPlaceholder('key', 'Explanation', count + 1))).toBe(false);
			expect(widget.eq(new FoldPlaceholder('other', 'Explanation', count))).toBe(false);
		}
	});

	test('clicking a placeholder unfolds through the shared effect without changing Markdown', () => {
		const initial = stateFor('<details><summary>Title</summary>\nbody\n</details>');
		const target = fakeView(initial);
		const node = (placeholders(initial)[0]!.value.spec.widget as FoldPlaceholder).toDOM(
			target.view
		) as unknown as FakeElement;
		expect(click(node)).toEqual(['prevent', 'stop', 'prevent', 'stop']);
		expect(target.dispatches).toBe(1);
		expect(target.focuses).toBe(1);
		expect(placeholders(target.view.state)).toEqual([]);
		expect(target.view.state.doc.toString()).toBe(initial.doc.toString());
		expect(undoDepth(target.view.state)).toBe(0);
	});
});

describe('fold gutter and hover', () => {
	test('markers exist only for visible candidates and expose their expanded state', () => {
		const state = stateFor(mixed, mixed.indexOf('Task'));
		expect(markers(state)).toHaveLength(3);
		const { view } = fakeView(state);
		const nodes = markers(state).map(
			(range) => (range.value as FoldGutterMarker).toDOM(view) as unknown as FakeElement
		);
		expect(nodes.map((node) => node.attributes['aria-label'])).toEqual([
			'Fold Project',
			'Fold Task',
			'Unfold Explanation'
		]);
		expect(nodes.map((node) => node.attributes['aria-expanded'])).toEqual(['true', 'true', 'false']);
		expect(nodes.map((node) => node.className.includes('pt-fold-active'))).toEqual([false, true, false]);
		expect(nodes.every((node) => node.tabIndex === -1 && node.type === 'button')).toBe(true);
		expect(nodes.every((node) => node.children[0]?.attributes['aria-hidden'] === 'true')).toBe(true);
		expect(markers(stateFor('- [ ] Leaf task\n# Leaf'))).toEqual([]);
		expect(markers(stateFor('<details><summary></summary>\n</details>'))[0]!.value).toMatchObject({ label: 'Section' });
	});

	test('gutter clicks close a block and relocate an existing body caret', () => {
		const text = '- [ ] Task\n  note';
		const initial = stateFor(text, text.indexOf('note'));
		const target = fakeView(initial);
		const marker = markers(initial)[0]!.value as FoldGutterMarker;
		const node = marker.toDOM(target.view) as unknown as FakeElement;
		expect(click(node)).toEqual(['prevent', 'stop', 'prevent', 'stop']);
		expect(target.dispatches).toBe(1);
		expect(target.view.state.selection.main.head).toBe(initial.doc.line(1).to);
		expect(placeholders(target.view.state)).toHaveLength(1);
		expect(target.view.state.doc.toString()).toBe(text);
		expect(undoDepth(target.view.state)).toBe(0);
		const closed = markers(target.view.state)[0]!.value as FoldGutterMarker;
		expect(marker.eq(closed)).toBe(false);
		expect(closed.eq(new FoldGutterMarker(closed.key, closed.label, closed.open, closed.active))).toBe(true);
		click(closed.toDOM(target.view) as unknown as FakeElement);
		expect(placeholders(target.view.state)).toEqual([]);
	});

	test('row hover dispatches only for changed header rows and reuses decorations', () => {
		const initial = stateFor('# Project\nbody\n# Leaf', '# Project\n'.length);
		const target = fakeView(initial);
		const hover = new FoldHover(target.view);
		const before = initial.field(foldViewState);
		hover.move(105);
		expect(target.dispatches).toBe(1);
		expect((markers(target.view.state)[0]!.value as FoldGutterMarker).active).toBe(true);
		hover.move(115);
		expect(target.dispatches).toBe(1);
		expect(target.view.state.field(foldViewState).decorations).toBe(before.decorations);
		expect(target.view.state.field(documentDecorations)).toBe(initial.field(documentDecorations));
		expect(target.view.state.field(foldState)).toBe(initial.field(foldState));
		expect(target.view.state.doc).toBe(initial.doc);
		expect(target.view.state.selection.eq(initial.selection)).toBe(true);
		hover.move(125);
		expect(target.dispatches).toBe(2);
		expect((markers(target.view.state)[0]!.value as FoldGutterMarker).active).toBe(false);
		hover.clear();
		hover.move(99);
		expect(target.dispatches).toBe(2);
		hover.move(105);
		hover.clear();
		expect(target.dispatches).toBe(4);
	});

	test('hover uses the merged details row and resets after a fold change', () => {
		const text = '<details open>\n<summary>Title</summary>\nbody\n</details>\nafter';
		const initial = stateFor(text, text.length);
		const target = fakeView(initial);
		target.view.lineBlockAtHeight = () =>
			({ from: 0, top: 0, bottom: 20 }) as ReturnType<EditorView['lineBlockAtHeight']>;
		const hover = new FoldHover(target.view);
		hover.move(110);
		expect(target.view.state.field(foldViewState).hovered).toBe(0);
		expect((markers(target.view.state)[0]!.value as FoldGutterMarker).active).toBe(true);
		target.view.dispatch({ effects: setFoldOpen.of({ key: candidate(initial, 'Title').key, open: false }) });
		expect(target.view.state.field(foldViewState).hovered).toBeNull();
		expect((markers(target.view.state)[0]!.value as FoldGutterMarker).open).toBe(false);
	});
});
