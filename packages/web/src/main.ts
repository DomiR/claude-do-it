import { Effect, Schema } from 'effect'
import { Runtime } from 'foldkit'

import { Message } from './message'
import { makeInitialModel, Model } from './model'
import { update } from './update'
import { view } from './view'

export const Flags = Schema.Struct({ path: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
  path: new URL(window.location.href).searchParams.get('path') ?? '',
}))

export const init: Runtime.ApplicationInit<Model, Message, Flags> = input => ({
  model: makeInitialModel(input.path),
})

export { Message, Model, update, view }
