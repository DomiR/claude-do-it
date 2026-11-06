import {
  EditorSelection, EditorState, Facet, MapMode, RangeSet, RangeValue, StateEffect, StateField, Transaction,
  type Extension, type StateCommand,
} from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

import { classifiedDocument } from './document'
import { remoteTransaction } from './facts'
import { foldCandidates, foldTarget, type FoldCandidate, type FoldKey } from './fold-ranges'

export type FoldChoice = 'open' | 'closed'
export interface FoldState {
  readonly candidates: readonly FoldCandidate[]
  readonly choices: ReadonlyMap<FoldKey, FoldChoice>
  readonly folded: RangeSet<FoldRange>
}

export class FoldRange extends RangeValue {
  constructor(readonly key: FoldKey) { super() }
  eq(other: RangeValue): boolean { return other instanceof FoldRange && other.key === this.key }
}

export interface FoldStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface FoldOptions {
  readonly path?: string
  readonly storage?: FoldStorage
}

const MAX_SAVED = 500
const MAX_SERIALIZED_LENGTH = 256 * 1024
const storageKey = (path: string): string => `do-it:folds:v1:${path}`
const browserStorage = (): FoldStorage | undefined => {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}

const decode = (raw: string): Map<FoldKey, FoldChoice> => {
  if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error('Fold preferences are too large')
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
    !('choices' in value) || !Array.isArray(value.choices)) throw new Error('Invalid fold preferences')
  const choices = new Map<FoldKey, FoldChoice>()
  for (const entry of value.choices) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0].startsWith('v1:') ||
      (entry[1] !== 'open' && entry[1] !== 'closed')) throw new Error('Invalid fold choice')
    choices.delete(entry[0])
    choices.set(entry[0], entry[1])
    if (choices.size > MAX_SAVED) choices.delete(choices.keys().next().value!)
  }
  return choices
}

/** A mount keeps its latest preferences in memory if browser storage fails. */
class FoldSession {
  private readonly storage: FoldStorage | undefined
  private readonly key: string | undefined
  private memory = new Map<FoldKey, FoldChoice>()
  private failed = false
  constructor(options: FoldOptions) {
    this.storage = options.storage ?? browserStorage()
    this.key = options.path === undefined ? undefined : storageKey(options.path)
  }
  read(): Map<FoldKey, FoldChoice> {
    if (!this.failed && this.storage && this.key !== undefined) {
      try {
        const raw = this.storage.getItem(this.key)
        if (raw !== null) this.memory = decode(raw)
      } catch { this.failed = true }
    }
    return new Map(this.memory)
  }
  matches(choices: ReadonlyMap<FoldKey, FoldChoice>): boolean { return sameChoices(this.memory, choices) }
  write(choices: ReadonlyMap<FoldKey, FoldChoice>): void {
    const entries = [...choices].slice(-MAX_SAVED)
    let raw = JSON.stringify({ version: 1, choices: entries })
    while (raw.length > MAX_SERIALIZED_LENGTH && entries.length) {
      entries.shift()
      raw = JSON.stringify({ version: 1, choices: entries })
    }
    this.memory = new Map(entries)
    if (!this.failed && this.storage && this.key !== undefined) {
      try { this.storage.setItem(this.key, raw) } catch { this.failed = true }
    }
  }
}

const foldSession = Facet.define<FoldSession, FoldSession>({
  combine: values => values[0] ?? new FoldSession({}),
})

export const setFoldOpen = StateEffect.define<{ readonly key: FoldKey; readonly open: boolean }>()
export const setAllFoldsOpen = StateEffect.define<boolean>()
export const revealFoldPositions = StateEffect.define<readonly number[]>({
  map: (positions, changes) => positions.map(position => changes.mapPos(position)),
})

export const isFoldOpen = (state: Pick<FoldState, 'choices'>, candidate: FoldCandidate): boolean =>
  (state.choices.get(candidate.key) ?? (candidate.initiallyOpen ? 'open' : 'closed')) === 'open'

const choose = (choices: Map<FoldKey, FoldChoice>, key: FoldKey, open: boolean): void => {
  const value = open ? 'open' : 'closed'
  if (choices.get(key) === value) return
  choices.delete(key)
  choices.set(key, value)
}
const sameChoices = (left: ReadonlyMap<FoldKey, FoldChoice>, right: ReadonlyMap<FoldKey, FoldChoice>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)

const reconcile = (previous: FoldState, candidates: readonly FoldCandidate[], transaction: Transaction) => {
  const remapped = new Map<FoldKey, FoldKey>()
  const effectKeys = new Map<FoldKey, FoldKey>()
  if (transaction.docChanged) {
    const headers = new Map<string, FoldCandidate>(candidates.map(candidate => [`${candidate.kind}:${candidate.headerLine}`, candidate]))
    const headerEdits = new Set<number>()
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const line = transaction.startState.doc.lineAt(from)
      if (from === line.from && to <= line.to && inserted.lines === 1) headerEdits.add(line.number - 1)
    })
    const claimed = new Set<FoldKey>()
    for (const old of previous.candidates) {
      let anchor = transaction.changes.mapPos(old.anchor, 1, MapMode.TrackAfter)
      // Replacing a header alone is a rename; replacing its body too is not.
      if (anchor === null && headerEdits.has(old.headerLine)) anchor = transaction.changes.mapPos(old.anchor, 1)
      if (anchor === null) continue
      const line = transaction.newDoc.lineAt(anchor).number - 1
      const next = headers.get(`${old.kind}:${line}`)
      if (next) effectKeys.set(old.key, next.key)
      // An implicit default also reserves its shifted key against a stale duplicate choice.
      if (next && next.key !== old.key && !claimed.has(next.key)) {
        remapped.set(old.key, next.key)
        claimed.add(next.key)
      }
    }
  }
  const consumed = new Set(remapped.values())
  const choices = new Map<FoldKey, FoldChoice>()
  for (const [key, value] of previous.choices) {
    const mapped = remapped.get(key)
    if (mapped !== undefined) choices.set(mapped, value)
    else if (!consumed.has(key)) choices.set(key, value)
  }
  // Keep disappeared choices for undo, with a bound independent of live blocks.
  const live = new Set(candidates.map(candidate => candidate.key))
  const stale = [...choices.keys()].filter(key => !live.has(key))
  for (const key of stale.slice(0, Math.max(0, stale.length - MAX_SAVED))) choices.delete(key)
  return { choices, effectKeys }
}

const applyChoices = (previous: FoldState, candidates: readonly FoldCandidate[], transaction: Transaction) => {
  const { choices, effectKeys } = reconcile(previous, candidates, transaction)
  const live = new Set(candidates.map(candidate => candidate.key))
  const requested = new Map<FoldKey, boolean>()
  for (const effect of transaction.effects) {
    if (effect.is(setAllFoldsOpen)) {
      for (const candidate of candidates) requested.set(candidate.key, effect.value)
    } else if (effect.is(setFoldOpen)) {
      const key = effectKeys.get(effect.value.key) ?? effect.value.key
      if (live.has(key)) requested.set(key, effect.value.open)
    }
  }
  for (const [key, open] of requested) choose(choices, key, open)
  return { choices, requested, effectKeys }
}

const contains = (candidate: FoldCandidate, position: number): boolean =>
  position > candidate.hidden.from && position < candidate.hidden.to

const reveal = (candidates: readonly FoldCandidate[], choices: Map<FoldKey, FoldChoice>, positions: readonly number[]): void => {
  for (const candidate of candidates) {
    if (!isFoldOpen({ choices }, candidate) && positions.some(position => contains(candidate, position))) choose(choices, candidate.key, true)
  }
}
const selectionPositions = (selection: EditorSelection): number[] => selection.ranges.flatMap(range => [range.anchor, range.head])
const stateWith = (candidates: readonly FoldCandidate[], choices: ReadonlyMap<FoldKey, FoldChoice>): FoldState => ({
  candidates, choices,
  folded: RangeSet.of(candidates.filter(candidate => !isFoldOpen({ choices }, candidate))
    .map(candidate => new FoldRange(candidate.key).range(candidate.hidden.from, candidate.hidden.to)), true),
})

/** The only owner of fold choices and folded ranges. */
export const foldState = StateField.define<FoldState>({
  create: state => {
    const candidates = foldCandidates(state.doc.toString(), state.field(classifiedDocument))
    const choices = state.facet(foldSession).read()
    reveal(candidates, choices, selectionPositions(state.selection))
    return stateWith(candidates, choices)
  },
  update: (previous, transaction) => {
    const candidates = transaction.docChanged
      ? foldCandidates(transaction.newDoc.toString(), transaction.state.field(classifiedDocument)) : previous.candidates
    const { choices, effectKeys } = applyChoices(previous, candidates, transaction)
    if (transaction.docChanged && transaction.annotation(remoteTransaction) === undefined) {
      const live = new Map(candidates.map(candidate => [candidate.key, candidate]))
      const claimed = new Set(effectKeys.values())
      for (const old of previous.candidates) {
        const mappedKey = effectKeys.get(old.key)
        const next = live.get(mappedKey ?? old.key)
        if (isFoldOpen(previous, old) || !next || isFoldOpen({ choices }, next)) continue
        // Deleted headers may be moves or shifted duplicates; only changed bodies need revealing.
        if (mappedKey === undefined && (claimed.has(old.key) ||
          transaction.startState.sliceDoc(old.hidden.from, old.hidden.to) === transaction.newDoc.sliceString(next.hidden.from, next.hidden.to))) continue
        transaction.changes.iterChangedRanges((from, to) => {
          if (to > old.hidden.from && from <= old.hidden.to) choose(choices, next.key, true)
        })
      }
    }
    const positions = selectionPositions(transaction.newSelection)
    for (const effect of transaction.effects) if (effect.is(revealFoldPositions)) positions.push(...effect.value)
    // Selection visibility also wins for remote edits and transactions without user events.
    reveal(candidates, choices, positions)
    return candidates === previous.candidates && sameChoices(choices, previous.choices) ? previous : stateWith(candidates, choices)
  },
})

/** Remote appends keep a boundary caret after the placeholder instead of revealing the new body. */
const remoteFoldBoundarySelection = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || transaction.annotation(remoteTransaction) === undefined) return transaction
  const previous = transaction.startState.field(foldState)
  const ends = new Set(previous.candidates.filter(candidate => !isFoldOpen(previous, candidate)).map(candidate => candidate.hidden.to))
  const mappedEnds = new Map(transaction.startState.selection.ranges.filter(range => range.empty && ends.has(range.head))
    .map(range => [transaction.changes.mapPos(range.head, -1), transaction.changes.mapPos(range.head, 1)]))
  const selection = EditorSelection.create(transaction.newSelection.ranges.map(range => {
    // Match mapped positions rather than range indexes, which can merge during remote edits.
    const after = range.empty ? mappedEnds.get(range.head) : undefined
    return after === undefined ? range : EditorSelection.cursor(after, 1)
  }), transaction.newSelection.mainIndex)
  return selection.eq(transaction.newSelection) ? transaction : [transaction, { selection, sequential: true }]
})

const closeSelection = EditorState.transactionFilter.of(transaction => {
  if (!transaction.effects.some(effect => effect.is(setAllFoldsOpen) ? !effect.value : effect.is(setFoldOpen) && !effect.value.open)) return transaction
  const previous = transaction.startState.field(foldState)
  const candidates = transaction.docChanged ? transaction.state.field(foldState).candidates : previous.candidates
  const { requested } = applyChoices(previous, candidates, transaction)
  const closing = candidates.filter(candidate => requested.get(candidate.key) === false)
  const move = (position: number): number => closing.find(candidate => contains(candidate, position))?.hidden.from ?? position
  const selection = EditorSelection.create(transaction.newSelection.ranges.map(range => {
    const anchor = move(range.anchor)
    const head = move(range.head)
    return anchor === range.anchor && head === range.head ? range : EditorSelection.range(anchor, head)
  }), transaction.newSelection.mainIndex)
  return selection.eq(transaction.newSelection) ? transaction : [transaction, { selection, sequential: true }]
})

export const toggleFold: StateCommand = ({ state, dispatch }) => {
  const folds = state.field(foldState, false)
  const target = folds && foldTarget(folds.candidates, state.selection.main.head)
  if (!folds || !target) return false
  dispatch(state.update({ effects: setFoldOpen.of({ key: target.key, open: !isFoldOpen(folds, target) }), annotations: Transaction.addToHistory.of(false) }))
  return true
}
const setAll = (open: boolean): StateCommand => ({ state, dispatch }) => {
  if (!state.field(foldState, false)?.candidates.length) return false
  dispatch(state.update({ effects: setAllFoldsOpen.of(open), annotations: Transaction.addToHistory.of(false) }))
  return true
}
export const foldAll = setAll(false)
export const unfoldAll = setAll(true)

/** Debounced persistence, with a final flush when this tab leaves or the editor unmounts. */
export class FoldPersistence {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: ReadonlyMap<FoldKey, FoldChoice> | undefined
  private readonly session: FoldSession
  private readonly window: Window | null
  private readonly onPageHide = (): void => this.flush()
  constructor(view: EditorView) {
    this.session = view.state.facet(foldSession)
    this.window = view.dom.ownerDocument.defaultView
    this.window?.addEventListener('pagehide', this.onPageHide)
    const choices = view.state.field(foldState).choices
    if (!this.session.matches(choices)) this.schedule(choices)
  }
  private schedule(choices: ReadonlyMap<FoldKey, FoldChoice>): void {
    this.pending = choices
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }
  update(update: ViewUpdate): void {
    const previous = update.startState.field(foldState).choices
    const choices = update.state.field(foldState).choices
    if (!sameChoices(previous, choices)) this.schedule(choices)
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending) this.session.write(this.pending)
    this.pending = undefined
  }
  destroy(): void {
    this.flush()
    this.window?.removeEventListener('pagehide', this.onPageHide)
  }
}

export const foldExtensions = (options: FoldOptions = {}): Extension => [
  foldSession.of(new FoldSession(options)), classifiedDocument, foldState, remoteFoldBoundarySelection, closeSelection, ViewPlugin.fromClass(FoldPersistence),
]
