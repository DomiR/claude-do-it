import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	GutterMarker,
	ViewPlugin,
	WidgetType,
	gutter,
	type DecorationSet
} from '@codemirror/view';

import type { SourceSpan } from './blocks';
import { classifiedDocument } from './document';
import type { FoldCandidate, FoldKey } from './fold-ranges';
import { foldState, isFoldOpen, setFoldOpen } from './folds';

const labelFor = (candidate: FoldCandidate): string =>
	candidate.identityLabel ||
	(candidate.kind === 'heading' ? 'Project' : candidate.kind === 'task' ? 'Task' : 'Section');
const lineCount = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`;

const foldButton = (view: EditorView, key: FoldKey, open: boolean): HTMLButtonElement => {
	const button = view.dom.ownerDocument.createElement('button');
	button.type = 'button';
	button.tabIndex = -1;
	button.onmousedown = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	button.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		view.dispatch({ effects: setFoldOpen.of({ key, open }) });
		view.focus();
	};
	return button;
};

export class FoldPlaceholder extends WidgetType {
	constructor(
		readonly key: FoldKey,
		readonly label: string,
		readonly count: number
	) {
		super();
	}
	override eq(other: FoldPlaceholder): boolean {
		return this.key === other.key && this.label === other.label && this.count === other.count;
	}
	override ignoreEvent(): boolean {
		return true;
	}
	toDOM(view: EditorView): HTMLElement {
		const button = foldButton(view, this.key, true);
		button.className = 'pt-fold-placeholder';
		button.textContent = `… ${lineCount(this.count)}`;
		button.setAttribute(
			'aria-label',
			`Unfold ${this.label}, ${this.count} hidden ${this.count === 1 ? 'line' : 'lines'}`
		);
		button.setAttribute('aria-expanded', 'false');
		return button;
	}
}

export class DetailsEnd extends WidgetType {
	override eq(other: WidgetType): boolean {
		return other instanceof DetailsEnd;
	}
	override ignoreEvent(): boolean {
		return false;
	}
	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement('span');
		span.className = 'pt-details-end';
		span.setAttribute('aria-hidden', 'true');
		return span;
	}
}

export class FoldGutterMarker extends GutterMarker {
	constructor(
		readonly key: FoldKey,
		readonly label: string,
		readonly open: boolean,
		readonly active: boolean
	) {
		super();
	}
	override eq(other: GutterMarker): boolean {
		return (
			other instanceof FoldGutterMarker &&
			this.key === other.key &&
			this.label === other.label &&
			this.open === other.open &&
			this.active === other.active
		);
	}
	override toDOM(view: EditorView): Node {
		const button = foldButton(view, this.key, !this.open);
		button.className = `pt-fold-button${this.active ? ' pt-fold-active' : ''}`;
		button.setAttribute('aria-label', `${this.open ? 'Fold' : 'Unfold'} ${this.label}`);
		button.setAttribute('aria-expanded', String(this.open));
		const chevron = view.dom.ownerDocument.createElement('span');
		chevron.className = 'pt-fold-chevron';
		chevron.setAttribute('aria-hidden', 'true');
		button.append(chevron);
		return button;
	}
}

interface FoldLayout {
	readonly decorations: DecorationSet;
	readonly atomicRanges: RangeSet<Decoration>;
	readonly hidden: readonly SourceSpan[];
	/** Source row starts, including the opener of a two-line details header. */
	readonly headers: ReadonlyMap<number, FoldCandidate>;
}
export interface FoldViewState extends FoldLayout {
	readonly hovered: number | null;
	readonly markers: RangeSet<GutterMarker>;
}

const layoutFor = (state: EditorState): FoldLayout => {
	const folds = state.field(foldState);
	const document = state.field(classifiedDocument);
	const ranges: Range<Decoration>[] = [];
	const atomic: Range<Decoration>[] = [];
	const hidden: SourceSpan[] = [];
	const headers = new Map<number, FoldCandidate>();
	const details = new Map(document.blocks.details.map((block) => [block.startLine, block]));
	const replace = (from: number, to: number, widget?: WidgetType): void => {
		if (from >= to) return;
		const range = Decoration.replace({ widget, inclusive: false }).range(from, to);
		ranges.push(range);
		atomic.push(range);
	};
	let hiddenEnd = -1;
	for (const candidate of folds.candidates) {
		if (candidate.from < hiddenEnd) continue;
		headers.set(candidate.from, candidate);
		const open = isFoldOpen(folds, candidate);
		if (!open) {
			replace(
				candidate.hidden.from,
				candidate.hidden.to,
				new FoldPlaceholder(candidate.key, labelFor(candidate), candidate.hiddenLines)
			);
			hidden.push(candidate.hidden);
			hiddenEnd = candidate.hidden.to;
		}
		if (candidate.kind !== 'details') continue;
		const block = details.get(candidate.startLine)!;
		const summary = document.lines[block.summaryLine]!;
		const twoLines = block.startLine !== block.summaryLine;
		// Both source lines become one rendered row. CSS restores any removed indentation.
		replace(twoLines ? block.from : block.delimiters[0]!.from, block.title.from);
		replace(block.title.to, summary.to);
		ranges.push(
			Decoration.line({
				class: `pt-details-header${twoLines ? ' pt-details-header-two-line' : ''}${summary.archived ? ' pt-line-archived' : ''}`,
				attributes: { style: `--pt-details-indent: ${summary.hang}` }
			}).range(block.from)
		);
		if (block.title.from < block.title.to)
			ranges.push(Decoration.mark({ class: 'pt-details-title' }).range(block.title.from, block.title.to));
		if (open) {
			const closer = block.delimiters.at(-1)!;
			replace(closer.from, closer.to, new DetailsEnd());
		}
	}
	return { decorations: Decoration.set(ranges, true), atomicRanges: RangeSet.of(atomic, true), hidden, headers };
};

const markersFor = (state: EditorState, layout: FoldLayout, hovered: number | null): RangeSet<GutterMarker> => {
	const folds = state.field(foldState);
	return RangeSet.of(
		[...layout.headers].map(([from, candidate]) => {
			const active =
				hovered === from ||
				state.selection.ranges.some((range) => range.head >= candidate.from && range.head <= candidate.hidden.from);
			return new FoldGutterMarker(candidate.key, labelFor(candidate), isFoldOpen(folds, candidate), active).range(from);
		}),
		true
	);
};

export const setFoldHover = StateEffect.define<number | null>();

/** Presentation is derived from foldState; it never stores fold choices. */
export const foldViewState = StateField.define<FoldViewState>({
	create: (state) => {
		const layout = layoutFor(state);
		return { ...layout, hovered: null, markers: markersFor(state, layout, null) };
	},
	update: (value, transaction) => {
		const changed =
			transaction.docChanged || transaction.startState.field(foldState) !== transaction.state.field(foldState);
		const layout = changed ? layoutFor(transaction.state) : value;
		let hovered = changed ? null : value.hovered;
		for (const effect of transaction.effects) if (effect.is(setFoldHover)) hovered = effect.value;
		if (hovered !== null && !layout.headers.has(hovered)) hovered = null;
		if (!changed && hovered === value.hovered && !transaction.selection) return value;
		return { ...layout, hovered, markers: markersFor(transaction.state, layout, hovered) };
	},
	provide: (field) => [
		EditorView.decorations.from(field, (value) => value.decorations),
		EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
	]
});

/** Mouse motion only publishes a changed header row, never document or selection edits. */
export class FoldHover {
	constructor(private readonly view: EditorView) {}
	move(clientY: number): void {
		const height = clientY - this.view.documentTop;
		if (height < 0) {
			this.clear();
			return;
		}
		const line = this.view.lineBlockAtHeight(height);
		const headers = this.view.state.field(foldViewState).headers;
		this.set(height >= line.top && height < line.bottom && headers.has(line.from) ? line.from : null);
	}
	clear(): void {
		this.set(null);
	}
	private set(from: number | null): void {
		if (this.view.state.field(foldViewState).hovered !== from) this.view.dispatch({ effects: setFoldHover.of(from) });
	}
}

const foldHover = ViewPlugin.fromClass(FoldHover, {
	eventHandlers: {
		mousemove(event, view) {
			if (event.target instanceof Node && view.scrollDOM.contains(event.target)) this.move(event.clientY);
			else this.clear();
			return false;
		},
		mouseleave() {
			this.clear();
			return false;
		},
		scroll() {
			this.clear();
			return false;
		}
	}
});

export const foldView: Extension = [
	foldViewState,
	gutter({
		class: 'pt-fold-gutter',
		renderEmptyElements: true,
		markers: (view) => view.state.field(foldViewState).markers
	}),
	foldHover
];
