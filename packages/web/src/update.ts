import { Match, Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { ApplySelection, SyncDraft, WaitBeforeReconnect, WaitBeforeSync } from './command'
import { Message } from './message'
import { ConnectionState, DocumentState, Model, ReadyDocument, TaskInput } from './model'
import { mapSelection } from './selection'
import { addTaskText, toggleTodoText } from './sync'

type UpdateReturn = Update.Return<Model, Message, import('./rpc').DoItClient>

const keepLastActivities = (activity: ReadonlyArray<Model['activity'][number]>) => activity.slice(0, 20)

const isDirty = (document: ReadyDocument): boolean => document.draft !== document.base.text

const syncCommandFor = (document: ReadyDocument) =>
  SyncDraft({ path: document.path, base: document.base.version, text: document.draft })

const inFlightExists = (document: ReadyDocument): boolean => Option.isSome(document.inFlight)

const inFlightMatches = (document: ReadyDocument, base: number, text: string): boolean =>
  Option.match(document.inFlight, {
    onNone: () => false,
    onSome: request => request.base === base && request.text === text,
  })

const activityFor = (
  model: Model,
  from: number,
  to: number,
  by: Model['activity'][number]['by'],
  todos: Model['activity'][number]['todos'],
) => ({
  model: modifyFields(model, {
    activity: activity => keepLastActivities([{ from, to, by, todos }, ...activity]),
    highlightedTodos: () => (by.some(author => author._tag !== 'User') ? todos.map(todo => todo.number) : []),
  }),
})

const startSyncIfNeeded = (document: ReadyDocument, text: string) => {
  const nextDocument = modifyFields(document, {
    draft: () => text,
    draftRevision: revision => revision + 1,
  })
  if (inFlightExists(document)) return { document: nextDocument, commands: undefined }
  const syncingDocument = modifyFields(nextDocument, {
    inFlight: () => Option.some({ path: document.path, base: document.base.version, text }),
  })
  return { document: syncingDocument, commands: [syncCommandFor(syncingDocument)] }
}

const reconnect = (model: Model) =>
  DocumentState.match<UpdateReturn>(model.document, {
    Ready: ({ document }) => {
      const reconnectAttempt = document.reconnectAttempt + 1
      return {
        model: modifyFields(model, {
          document: () =>
            DocumentState.Ready({
              document: modifyFields(document, {
                connection: () => ConnectionState.Reconnecting(),
                reconnectAttempt: () => reconnectAttempt,
              }),
            }),
        }),
        commands: [WaitBeforeReconnect({ attempt: reconnectAttempt })],
      }
    },
    Connecting: ({ path, watchKey, resumeFrom, reconnectAttempt }) => {
      const nextAttempt = reconnectAttempt + 1
      return {
        model: modifyFields(model, {
          document: () => DocumentState.Connecting({ path, watchKey, resumeFrom, reconnectAttempt: nextAttempt }),
        }),
        commands: [WaitBeforeReconnect({ attempt: nextAttempt })],
      }
    },
    NoPath: () => ({ model }),
    Deleted: () => ({ model }),
    Unauthorized: () => ({ model }),
  })

const readyFromWatching = (model: Model, version: number, text: string) =>
  DocumentState.match<UpdateReturn>(model.document, {
    Connecting: ({ path, watchKey, reconnectAttempt }) => ({
      model: modifyFields(model, {
        document: () =>
          DocumentState.Ready({
            document: {
              path,
              base: { version, text },
              draft: text,
              inFlight: Option.none(),
              draftRevision: 0,
              watchKey,
              resumeFrom: Option.none(),
              reconnectAttempt: 0,
              connection: ConnectionState.Live(),
              selection: { start: 0, end: 0 },
            },
          }),
      }),
    }),
    Ready: ({ document }) => {
      const nextSelection = mapSelection(document.base.text, text, document.selection)
      const nextDocument = modifyFields(document, {
        base: () => ({ version, text }),
        draft: draft => (draft === document.base.text ? text : draft),
        connection: () => ConnectionState.Live(),
        reconnectAttempt: () => 0,
        selection: () => nextSelection,
      })
      const shouldSync = isDirty(nextDocument) && !inFlightExists(nextDocument)
      const syncingDocument = shouldSync
        ? modifyFields(nextDocument, {
            inFlight: () => Option.some({ path: nextDocument.path, base: version, text: nextDocument.draft }),
          })
        : nextDocument
      return {
        model: modifyFields(model, {
          document: () => DocumentState.Ready({ document: syncingDocument }),
        }),
        commands: shouldSync
          ? [syncCommandFor(syncingDocument), ApplySelection(nextSelection)]
          : [ApplySelection(nextSelection)],
      }
    },
    NoPath: () => ({ model }),
    Deleted: () => ({ model }),
    Unauthorized: () => ({ model }),
  })

const remoteChange = (
  model: Model,
  document: ReadyDocument,
  event: Extract<import('@do-it/protocol').WatchEvent, { _tag: 'Change' }>,
) => {
  const remoteText = event.text ?? document.base.text
  const activity = activityFor(model, event.from, event.to, event.by, event.todos)
  if (isDirty(document)) {
    const shouldStartSync = !inFlightExists(document)
    const syncingDocument = shouldStartSync
      ? modifyFields(document, {
          inFlight: () => Option.some({ path: document.path, base: document.base.version, text: document.draft }),
        })
      : document
    const sync = shouldStartSync ? [syncCommandFor(syncingDocument)] : undefined
    return {
      model: modifyFields(activity.model, {
        document: () => DocumentState.Ready({ document: syncingDocument }),
      }),
      commands: sync,
    }
  }
  const nextSelection = mapSelection(document.base.text, remoteText, document.selection)
  const nextDocument = modifyFields(document, {
    base: () => ({ version: event.to, text: remoteText }),
    draft: () => remoteText,
    selection: () => nextSelection,
  })
  return {
    model: modifyFields(activity.model, {
      document: () => DocumentState.Ready({ document: nextDocument }),
    }),
    commands: [ApplySelection(nextSelection)],
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SelectedMode: ({ mode }) => ({ model: modifyFields(model, { mode: () => mode }) }),

    UpdatedMarkdown: ({ text, selectionStart, selectionEnd }) =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) => {
          const nextDocument = modifyFields(document, {
            draft: () => text,
            draftRevision: revision => revision + 1,
            selection: () => ({ start: selectionStart, end: selectionEnd }),
          })
          return {
            model: modifyFields(model, { document: () => DocumentState.Ready({ document: nextDocument }) }),
            commands: [WaitBeforeSync({ revision: nextDocument.draftRevision })],
          }
        },
        NoPath: () => ({ model }),
        Connecting: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    UpdatedTaskInput: ({ section, text }) => ({
      model: modifyFields(model, {
        taskInputs: inputs => {
          const next = inputs.filter(input => input.section !== section)
          return [...next, { section, text } as TaskInput]
        },
      }),
    }),

    ClickedAddTask: ({ section }) =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) => {
          const item = model.taskInputs.find(input => input.section === section)?.text ?? ''
          const nextText = addTaskText(document.draft, item, section)
          if (nextText === document.draft) return { model }
          const sync = startSyncIfNeeded(document, nextText)
          return {
            model: modifyFields(model, {
              document: () => DocumentState.Ready({ document: sync.document }),
              taskInputs: inputs => inputs.filter(input => input.section !== section),
            }),
            commands: sync.commands,
          }
        },
        NoPath: () => ({ model }),
        Connecting: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    ClickedTodo: ({ number }) =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) => {
          const nextText = toggleTodoText(document.draft, number)
          if (nextText === document.draft) return { model }
          const sync = startSyncIfNeeded(document, nextText)
          return {
            model: modifyFields(model, { document: () => DocumentState.Ready({ document: sync.document }) }),
            commands: sync.commands,
          }
        },
        NoPath: () => ({ model }),
        Connecting: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    ReceivedWatchEvent: ({ event }) =>
      Match.value(event).pipe(
        Match.tag('Watching', ({ version, text }) =>
          text === undefined ? { model } : readyFromWatching(model, version, text),
        ),
        Match.tag('Resync', ({ version, text }) =>
          text === undefined
            ? { model }
            : DocumentState.match<UpdateReturn>(model.document, {
                Ready: ({ document }) => {
                  const nextDocument = modifyFields(document, {
                    base: () => ({ version, text }),
                    connection: () => ConnectionState.Live(),
                  })
                  const shouldSync = isDirty(document) && !inFlightExists(document)
                  const syncingDocument = shouldSync
                    ? modifyFields(nextDocument, {
                        inFlight: () => Option.some({ path: document.path, base: version, text: document.draft }),
                      })
                    : nextDocument
                  return {
                    model: modifyFields(model, { document: () => DocumentState.Ready({ document: syncingDocument }) }),
                    commands: shouldSync
                      ? [syncCommandFor(syncingDocument)]
                      : [ApplySelection(document.selection)],
                  }
                },
                Connecting: ({ path, watchKey, resumeFrom, reconnectAttempt }) => readyFromWatching(
                  modifyFields(model, { document: () => DocumentState.Connecting({ path, watchKey, resumeFrom, reconnectAttempt }) }),
                  version,
                  text,
                ),
                NoPath: () => ({ model }),
                Deleted: () => ({ model }),
                Unauthorized: () => ({ model }),
              }),
        ),
        Match.tag('Change', event =>
          DocumentState.match<UpdateReturn>(model.document, {
            Ready: ({ document }) => remoteChange(model, document, event),
            NoPath: () => ({ model }),
            Connecting: () => ({ model }),
            Deleted: () => ({ model }),
            Unauthorized: () => ({ model }),
          }),
        ),
        Match.tag('Deleted', () =>
          DocumentState.match<UpdateReturn>(model.document, {
            Ready: ({ document }) => ({
              model: modifyFields(model, { document: () => DocumentState.Deleted({ path: document.path }) }),
            }),
            Connecting: ({ path }) => ({ model: modifyFields(model, { document: () => DocumentState.Deleted({ path }) }) }),
            NoPath: () => ({ model }),
            Deleted: () => ({ model }),
            Unauthorized: () => ({ model }),
          }),
        ),
        Match.exhaustive,
      ),

    WatchEnded: () => reconnect(model),

    FailedWatch: ({ unauthorized }) =>
      unauthorized
        ? DocumentState.match<UpdateReturn>(model.document, {
            Ready: ({ document }) => ({ model: modifyFields(model, { document: () => DocumentState.Unauthorized({ path: document.path }) }) }),
            Connecting: ({ path }) => ({ model: modifyFields(model, { document: () => DocumentState.Unauthorized({ path }) }) }),
            NoPath: () => ({ model }),
            Deleted: () => ({ model }),
            Unauthorized: () => ({ model }),
          })
        : reconnect(model),

    CompletedWaitBeforeReconnect: () =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) => ({
          model: modifyFields(model, {
            document: () =>
              DocumentState.Ready({
                document: modifyFields(document, {
                  watchKey: key => key + 1,
                  resumeFrom: () => Option.some(document.base.version),
                }),
              }),
          }),
        }),
        Connecting: ({ path, reconnectAttempt, watchKey, resumeFrom }) => ({
          model: modifyFields(model, {
            document: () => DocumentState.Connecting({ path, reconnectAttempt, watchKey: watchKey + 1, resumeFrom }),
          }),
        }),
        NoPath: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    CompletedWaitBeforeSync: ({ revision }) =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) =>
          document.draftRevision !== revision || !isDirty(document) || inFlightExists(document)
            ? { model }
            : {
                model: modifyFields(model, {
                  document: () =>
                    DocumentState.Ready({
                      document: modifyFields(document, {
                        inFlight: () => Option.some({ path: document.path, base: document.base.version, text: document.draft }),
                      }),
                    }),
                }),
                commands: [syncCommandFor(document)],
              },
        NoPath: () => ({ model }),
        Connecting: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    SucceededSync: ({ request, version, text }) =>
      DocumentState.match<UpdateReturn>(model.document, {
        Ready: ({ document }) => {
          if (!inFlightMatches(document, request.base, request.text)) return { model }
          const nextSelection = mapSelection(document.base.text, text, document.selection)
          const nextDocument = modifyFields(document, {
            base: () => ({ version, text }),
            inFlight: () => Option.none(),
            draft: draft => (draft === request.text ? text : draft),
            selection: () => nextSelection,
          })
          const shouldSync = isDirty(nextDocument)
          const syncingDocument = shouldSync
            ? modifyFields(nextDocument, {
                inFlight: () => Option.some({ path: nextDocument.path, base: version, text: nextDocument.draft }),
              })
            : nextDocument
          return {
            model: modifyFields(model, { document: () => DocumentState.Ready({ document: syncingDocument }) }),
            commands: shouldSync
              ? [syncCommandFor(syncingDocument), ApplySelection(nextSelection)]
              : [ApplySelection(nextSelection)],
          }
        },
        NoPath: () => ({ model }),
        Connecting: () => ({ model }),
        Deleted: () => ({ model }),
        Unauthorized: () => ({ model }),
      }),

    FailedSync: ({ unauthorized }) =>
      unauthorized
        ? DocumentState.match<UpdateReturn>(model.document, {
            Ready: ({ document }) => ({ model: modifyFields(model, { document: () => DocumentState.Unauthorized({ path: document.path }) }) }),
            Connecting: ({ path }) => ({ model: modifyFields(model, { document: () => DocumentState.Unauthorized({ path }) }) }),
            NoPath: () => ({ model }),
            Deleted: () => ({ model }),
            Unauthorized: () => ({ model }),
          })
        : DocumentState.match<UpdateReturn>(model.document, {
            Ready: ({ document }) => ({
              model: modifyFields(model, {
                document: () => DocumentState.Ready({ document: modifyFields(document, { inFlight: () => Option.none() }) }),
              }),
            }),
            NoPath: () => ({ model }),
            Connecting: () => ({ model }),
            Deleted: () => ({ model }),
            Unauthorized: () => ({ model }),
          }),

    CompletedApplySelection: () => ({ model }),
  })

