import { ChangeSet } from '@codemirror/state'
import { textEdits } from '@do-it/doc/text'

export const changeSetBetween = (from: string, to: string): ChangeSet =>
  ChangeSet.of(textEdits(from, to), from.length, '\n')

export const rebaseRemote = (from: string, to: string, live: string): ChangeSet => {
  const remote = textEdits(from, to)
  const local = textEdits(from, live)
  const key = (edit: (typeof remote)[number]) => `${edit.from}:${edit.to}:${edit.insert}`
  const localKeys = new Set(local.map(key))
  const shared = remote.filter(edit => localKeys.has(key(edit)))
  const sharedKeys = new Set(shared.map(key))
  const isShared = (edit: (typeof remote)[number]) => sharedKeys.has(key(edit))
  const common = ChangeSet.of(shared, from.length, '\n')
  // Shared edits have already landed. Factor them out of both branches and
  // move the remaining edits into their coordinates before mapping onto live.
  // Dropping only from local would give a ChangeSet with the wrong input length.
  const remoteOnly = ChangeSet.of(remote.filter(edit => !isShared(edit)), from.length, '\n').map(common)
  const localOnly = ChangeSet.of(local.filter(edit => !isShared(edit)), from.length, '\n').map(common)
  return remoteOnly.map(localOnly, true)
}
