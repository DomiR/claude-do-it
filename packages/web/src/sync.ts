import { addTodo, applyEdits, setTodoState, todos } from '@do-it/doc/text'

export const toggleTodoText = (text: string, number: number): string => {
  const todo = todos(text).find(candidate => candidate.number === number)
  if (todo === undefined) return text
  return applyEdits(text, setTodoState(text, todo, todo.state === 'open' ? 'done' : 'open'))
}

export const addTaskText = (text: string, item: string, section: string | null): string => {
  const trimmedItem = item.trim()
  if (trimmedItem.length === 0) return text
  return applyEdits(text, addTodo(text, trimmedItem, section ?? undefined))
}
