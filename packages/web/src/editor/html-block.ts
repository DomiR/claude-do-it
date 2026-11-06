import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import type { HtmlBlock } from './blocks';
import { classifiedDocument } from './document';
import { foldViewState } from './fold-view';

/** Remove only the fence's literal indentation, preserving all other payload whitespace. */
export const htmlSource = (text: string, block: HtmlBlock): string =>
	text
		.slice(block.body.from, block.body.to)
		.split('\n')
		.map((line) => (line.startsWith(block.indent) ? line.slice(block.indent.length) : line))
		.join('\n');

export interface HtmlScriptOptions {
	readonly signal?: AbortSignal;
	readonly evaluate?: (code: string, root: ShadowRoot) => void;
	readonly reportError?: (error: unknown) => void;
}

const reportScriptError = (error: unknown): void => {
	console.error('HTML section script failed', error);
};
const evaluateScript = (code: string, root: ShadowRoot): void => {
	// Running the section's own inline scripts is the feature: HTML sections are trusted, not sandboxed.
	// oxlint-disable-next-line typescript/no-implied-eval
	new Function('root', code)(root);
};
const classicType = (type: string): boolean => !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type);

const appendExternalScript = (root: ShadowRoot, script: HTMLScriptElement, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const finish = (error?: unknown): void => {
			script.removeEventListener('load', loaded);
			script.removeEventListener('error', failed);
			signal?.removeEventListener('abort', aborted);
			if (error) reject(error);
			else resolve();
		};
		const loaded = (): void => {
			finish();
		};
		const failed = (): void => {
			finish(new Error(`Could not load HTML section script: ${script.getAttribute('src')}`));
		};
		const aborted = (): void => {
			script.remove();
			finish();
		};
		script.addEventListener('load', loaded);
		script.addEventListener('error', failed);
		signal?.addEventListener('abort', aborted, { once: true });
		if (signal?.aborted) aborted();
		else {
			try {
				root.append(script);
			} catch (error) {
				finish(error);
			}
		}
	});

/** The shadow tree scopes styles, not privileges. Scripts run with the editor page's access. */
export const runHtmlScripts = async (root: ShadowRoot, options: HtmlScriptOptions = {}): Promise<void> => {
	const { signal, evaluate = evaluateScript, reportError = reportScriptError } = options;
	if (signal?.aborted || !root.host.isConnected) return;
	const scripts = Array.from(root.querySelectorAll('script'), (script) => ({
		node: script,
		attributes: Array.from(script.attributes, (attribute) => [attribute.name, attribute.value] as const),
		code: script.textContent ?? '',
		type: (script.getAttribute('type') ?? '').trim().toLowerCase(),
		external: script.hasAttribute('src')
	}));
	for (const script of scripts) script.node.remove();
	for (const script of scripts) {
		if (signal?.aborted || !root.host.isConnected) return;
		try {
			if (!script.external && classicType(script.type)) evaluate(script.code, root);
			else {
				const fresh = root.ownerDocument.createElement('script');
				for (const [name, value] of script.attributes) fresh.setAttribute(name, value);
				fresh.textContent = script.code;
				if (script.external) fresh.async = false;
				if (script.external && (classicType(script.type) || script.type === 'module')) {
					await appendExternalScript(root, fresh, signal);
				} else {
					// Modules execute as modules; data scripts keep their original type and stay inert.
					if (script.type === 'module')
						fresh.addEventListener('error', () => reportError(new Error('Could not run HTML section module')), {
							once: true
						});
					root.append(fresh);
				}
			}
		} catch (error) {
			reportError(error);
		}
	}
};

const baseStyles = `
:host {
  all: initial;
  display: block;
  max-width: 100%;
  overflow: auto;
  box-sizing: border-box;
  white-space: normal;
  font: 16px/1.5 system-ui, sans-serif;
  color: var(--pt-ink, #000);
  color-scheme: light dark;
}
*, *::before, *::after { box-sizing: border-box; }
img, svg, video, canvas { max-width: 100%; }
button, input, select, textarea { font: inherit; }
`;

const measuredHeights = new Map<string, number>();
const rememberHeight = (source: string, height: number): void => {
	if (!Number.isFinite(height) || height < 0) return;
	measuredHeights.delete(source);
	measuredHeights.set(source, height);
	if (measuredHeights.size > 64) measuredHeights.delete(measuredHeights.keys().next().value!);
};
// CodeMirror can reuse the DOM with a new equal widget instance, so cleanup belongs to the host.
const cleanups = new WeakMap<HTMLElement, () => void>();

/** Columns of a fence's indentation, tabs at four, so the section lines up with the text around it. */
export const indentColumns = (indent: string): number => {
	let column = 0;
	for (const character of indent) column += character === '\t' ? 4 - (column % 4) : 1;
	return column;
};

export class HtmlSectionWidget extends WidgetType {
	constructor(
		readonly source: string,
		readonly indent = 0
	) {
		super();
	}
	override eq(other: HtmlSectionWidget): boolean {
		return this.source === other.source && this.indent === other.indent;
	}
	override get estimatedHeight(): number {
		return measuredHeights.get(this.source) ?? -1;
	}
	override ignoreEvent(): boolean {
		return true;
	}
	toDOM(view: EditorView): HTMLElement {
		const document = view.dom.ownerDocument;
		const host = document.createElement('div');
		host.className = 'pt-html-section';
		host.contentEditable = 'false';
		host.setAttribute('role', 'group');
		host.setAttribute('aria-label', 'HTML section');
		// The shadow root resets fonts, so the editor's character width sets the indentation here.
		const width = view.defaultCharacterWidth;
		if (this.indent > 0 && Number.isFinite(width) && width > 0)
			host.style.marginInlineStart = `${this.indent * width}px`;
		const root = host.attachShadow({ mode: 'open' });
		root.innerHTML = this.source;
		const base = document.createElement('style');
		base.textContent = baseStyles;
		root.prepend(base);
		const window = document.defaultView;
		if (!window) return host;
		const controller = new AbortController();
		let active = true;
		let observer: ResizeObserver | undefined;
		const measure = (): void => {
			if (!active || !host.isConnected) return;
			view.requestMeasure({
				key: host,
				read: () => (active && host.isConnected ? host.getBoundingClientRect().height : null),
				write: (height) => {
					if (active && height !== null) rememberHeight(this.source, height);
				}
			});
		};
		const frame = window.requestAnimationFrame(() => {
			if (!active || !host.isConnected) return;
			if (typeof window.ResizeObserver === 'function') {
				observer = new window.ResizeObserver(measure);
				observer.observe(host);
			}
			measure();
			void runHtmlScripts(root, { signal: controller.signal }).then(measure).catch(reportScriptError);
		});
		cleanups.set(host, () => {
			active = false;
			window.cancelAnimationFrame(frame);
			controller.abort();
			observer?.disconnect();
		});
		return host;
	}
	override destroy(dom: HTMLElement): void {
		cleanups.get(dom)?.();
		cleanups.delete(dom);
	}
}

const htmlDecorations = (state: EditorState): DecorationSet => {
	const blocks = state.field(classifiedDocument).blocks.html;
	const hidden = state.field(foldViewState).hidden;
	const ranges: Range<Decoration>[] = [];
	const text = blocks.length ? state.doc.toString() : '';
	let hiddenIndex = 0;
	for (const block of blocks) {
		if (!block.closed) continue;
		while (hidden[hiddenIndex] && hidden[hiddenIndex]!.to <= block.from) hiddenIndex += 1;
		const folded = hidden[hiddenIndex];
		// Also skip malformed indentation that lets a task fold cut through a fence.
		if (folded && folded.from < block.to) continue;
		ranges.push(
			Decoration.replace({
				block: true,
				inclusive: false,
				widget: new HtmlSectionWidget(htmlSource(text, block), indentColumns(block.indent))
			}).range(block.from, block.to)
		);
	}
	return Decoration.set(ranges, true);
};

/** Block replacements must be provided directly, before CodeMirror computes its viewport. */
export const htmlBlockDecorations = StateField.define<DecorationSet>({
	create: htmlDecorations,
	update: (value, transaction) =>
		transaction.docChanged ||
		transaction.startState.field(foldViewState).hidden !== transaction.state.field(foldViewState).hidden
			? htmlDecorations(transaction.state)
			: value,
	provide: (field) => [
		EditorView.decorations.from(field),
		EditorView.atomicRanges.of((view) => view.state.field(field))
	]
});
