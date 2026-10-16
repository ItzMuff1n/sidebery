import { describe, expect, test } from 'vitest'
import {
  getLockedBounds,
  getHealMoves,
  isInLockedUnit,
  clampToFree,
} from 'src/services/tabs.fg.lock'

// Roots from tokens: 'b' = locked bottom anchor, 't' = locked top anchor, 'l' = locked no anchor,
// 'u' = unlocked, 'x' = unlocked with a leftover anchor (must be ignored)
function roots(spec: string): { id: number; locked?: boolean; lockEnd?: 'top' | 'bottom' }[] {
  return [...spec].map((c, id) => ({
    id,
    locked: 'btl'.includes(c) || undefined,
    lockEnd: c === 'b' || c === 'x' ? 'bottom' : c === 't' ? 'top' : undefined,
  }))
}

describe('getHealMoves()', () => {
  test('none', () => {
    expect(getHealMoves(roots('uuu'))).toMatchObject({ toBottom: [], toTop: [] })
    expect(getHealMoves(roots('tuub'))).toMatchObject({ toBottom: [], toTop: [] })
  })
  test('bottom stray', () => {
    expect(getHealMoves(roots('ubuu'))).toEqual({
      toBottom: [2, 3],
      bottomAnchor: 1,
      toTop: [],
      topAnchor: undefined,
    })
  })
  test('top stray', () => {
    expect(getHealMoves(roots('uut'))).toEqual({
      toBottom: [],
      bottomAnchor: undefined,
      toTop: [0, 1],
      topAnchor: 2,
    })
  })
  test('both', () => {
    const r = getHealMoves(roots('utuubu'))
    expect(r.toTop).toEqual([0])
    expect(r.topAnchor).toBe(1)
    expect(r.toBottom).toEqual([5])
    expect(r.bottomAnchor).toBe(4)
  })
  test('locked strays and anchors on unlocked tabs are ignored', () => {
    expect(getHealMoves(roots('xuu'))).toMatchObject({ toBottom: [], toTop: [] })
    expect(getHealMoves(roots('bll')).toBottom).toEqual([])
  })
})

type T = { id: number; parentId: number; locked?: boolean; lvl: number; index: number }
// Build tabs from "lvl[L]" tokens, e.g. ['0L', '1', '0'] = locked root, its child, free root
function mk(spec: string[]): T[] {
  return spec.map((s, i) => ({
    id: i,
    parentId: -1,
    lvl: parseInt(s),
    locked: s.endsWith('L') || undefined,
    index: i + 10,
  }))
}
const bounds = (spec: string[]) => getLockedBounds(mk(spec), 10, 10 + spec.length)

describe('getLockedBounds()', () => {
  test('no locked tabs', () => {
    expect(bounds(['0', '0', '0'])).toEqual({ freeStart: 10, freeNext: 13 })
  })
  test('top block', () => {
    expect(bounds(['0L', '0L', '0', '0'])).toEqual({ freeStart: 12, freeNext: 14 })
  })
  test('bottom block', () => {
    expect(bounds(['0', '0', '0L'])).toEqual({ freeStart: 10, freeNext: 12 })
  })
  test('both blocks', () => {
    expect(bounds(['0L', '0', '0', '0L'])).toEqual({ freeStart: 11, freeNext: 13 })
  })
  test('locked root with children at the bottom', () => {
    expect(bounds(['0', '0', '0L', '1', '2'])).toEqual({ freeStart: 10, freeNext: 12 })
  })
  test('locked in the middle is not a block', () => {
    expect(bounds(['0', '0L', '0'])).toEqual({ freeStart: 10, freeNext: 13 })
  })
  test('all locked: bottom block, new tabs go to the start', () => {
    expect(bounds(['0L', '1', '0L'])).toEqual({ freeStart: 10, freeNext: 10 })
  })
  test('empty panel', () => {
    expect(getLockedBounds([], 5, 5)).toEqual({ freeStart: 5, freeNext: 5 })
  })
})

describe('isInLockedUnit() / clampToFree()', () => {
  test('ancestor locked', () => {
    const a = { id: 1, parentId: -1, lvl: 0, index: 0, locked: true }
    const b = { id: 2, parentId: 1, lvl: 1, index: 1 }
    const c = { id: 3, parentId: -1, lvl: 0, index: 2 }
    const byId = { 1: a, 2: b, 3: c }
    expect(isInLockedUnit(b, byId)).toBe(true)
    expect(isInLockedUnit(c, byId)).toBe(false)
    expect(isInLockedUnit(undefined, byId)).toBe(false)
  })
  test('clamp', () => {
    const f = { freeStartIndex: 3, freeNextIndex: 8 }
    expect(clampToFree(1, f)).toBe(3)
    expect(clampToFree(5, f)).toBe(5)
    expect(clampToFree(20, f)).toBe(8)
    expect(clampToFree(20, { freeStartIndex: -1, freeNextIndex: -1 })).toBe(20)
  })
})
