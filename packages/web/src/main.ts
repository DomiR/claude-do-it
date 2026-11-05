import { Effect, Schema } from 'effect'
import { Runtime } from 'foldkit'

import { detectPlatform } from './editor/keymap'
import { storedWrap } from './editor/preferences'
import { Message } from './message'
import { makeInitialModel, Model, Platform } from './model'
import { update } from './update'
import { view } from './view'

export const Flags = Schema.Struct({ path: Schema.String, platform: Platform, wrap: Schema.Boolean })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
  path: new URL(window.location.href).searchParams.get('path') ?? '',
  platform: detectPlatform(navigator.platform, navigator.userAgent),
  wrap: storedWrap(),
}))

export const init: Runtime.ApplicationInit<Model, Message, Flags> = input => ({
  model: makeInitialModel(input.path, input.platform, input.wrap),
})

export { Message, Model, update, view }
