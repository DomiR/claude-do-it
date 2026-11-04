/** Browser-safe text operations, without a CRDT document or disk dependencies. */
export { MAX_BYTES, KEPT, MAX_DIFF, MAX_ITEM } from "./constants"
export { DocError } from "./errors"
export { applyEdits, type Edit } from "./edit"
export { sections, findSection, sectionText, type Section } from "./section"
export { todos, findTodo, setTodoState, addTodo, appendBlock, replaceUnique, type TaskState, type Todo } from "./todo"
export { todoChanges, formatTodoChange, type TodoChangeKind, type TodoChange } from "./todo-changes"
