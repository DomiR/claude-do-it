import { Schema } from 'effect'
import { Runtime } from 'foldkit'
import { type Document, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({})
export type Message = typeof Message.Type

export const init: Runtime.ApplicationInit<Model, Message> = () => ({model: {}})

export const update = (model: Model, _message: Message) => ({model})

export const view = (_model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'do it',
  body: h.main(
    [h.Class('min-h-screen bg-stone-950 p-12 text-stone-100')],
    [h.h1([h.Class('text-5xl font-semibold tracking-tight')], ['do it'])],
  ),
})
