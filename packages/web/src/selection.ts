import type { Selection } from './model'

const commonPrefixLength = (oldText: string, newText: string): number => {
  const limit = Math.min(oldText.length, newText.length)
  let length = 0
  while (length < limit && oldText[length] === newText[length]) length += 1
  return length
}

const commonSuffixLength = (oldText: string, newText: string, prefixLength: number): number => {
  const limit = Math.min(oldText.length, newText.length) - prefixLength
  let length = 0
  while (
    length < limit &&
    oldText[oldText.length - length - 1] === newText[newText.length - length - 1]
  ) length += 1
  return length
}

const mapOffset = (
  offset: number,
  oldText: string,
  newText: string,
  prefixLength: number,
  suffixLength: number,
): number => {
  if (offset <= prefixLength) return offset
  if (offset >= oldText.length - suffixLength) return newText.length - (oldText.length - offset)
  return prefixLength
}

export const mapSelection = (oldText: string, newText: string, selection: Selection): Selection => {
  const prefixLength = commonPrefixLength(oldText, newText)
  const suffixLength = commonSuffixLength(oldText, newText, prefixLength)
  return {
    start: mapOffset(selection.start, oldText, newText, prefixLength, suffixLength),
    end: mapOffset(selection.end, oldText, newText, prefixLength, suffixLength),
  }
}
