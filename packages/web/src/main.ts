import { Effect, Schema } from 'effect'
import { Runtime } from 'foldkit'

import { detectPlatform } from './editor/keymap'
import { Message } from './message'
import { makeInitialModel, Model, Platform } from './model'
import { update } from './update'
import { view } from './view'

export const Flags = Schema.Struct({ path: Schema.String, platform: Platform })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
  path: new URL(window.location.href).searchParams.get('path') ?? '',
  platform: detectPlatform(navigator.platform, navigator.userAgent),
}))

export const init: Runtime.ApplicationInit<Model, Message, Flags> = input => ({
  model: makeInitialModel(input.path, input.platform),
})

export { Message, Model, update, view }
