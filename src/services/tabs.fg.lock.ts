// Pure helpers for "locked" tabs (Sidebery-only flag, not a Firefox pin).
// Keep this file free of service imports so it stays unit-testable.

interface LockTab {
  id?: ID
  parentId?: ID
  locked?: boolean
  lvl: number
  index: number
}

/**
 * Find the free zone of a panel: the area between the top block (leading run of locked root tabs)
 * and the bottom block (trailing run of locked root tabs). Descendants travel with their root.
 * If every root is locked they all form the bottom block.
 * `tabs` - tabs of the panel (without natively pinned), in order.
 */
export function getLockedBounds(
  tabs: LockTab[],
  panelStart: number,
  panelNext: number
): { freeStart: number; freeNext: number } {
  const roots = tabs.filter(t => t.lvl === 0)
  const first = roots.findIndex(t => !t.locked)
  if (first === -1) {
    return { freeStart: panelStart, freeNext: roots.length ? roots[0].index : panelNext }
  }

  let last = roots.length - 1
  while (roots[last].locked) last--
  const next = roots[last + 1]
  return { freeStart: roots[first].index, freeNext: next ? next.index : panelNext }
}

/**
 * Is the tab itself or any of its ancestors locked
 */
export function isInLockedUnit(tab: LockTab | undefined, byId: Record<ID, LockTab | undefined>) {
  let t = tab
  while (t) {
    if (t.locked) return true
    t = byId[t.parentId as ID]
  }
  return false
}

interface LockRoot {
  id: ID
  locked?: boolean
  lockEnd?: 'top' | 'bottom'
  index?: number
}

/**
 * Find stray root tabs: unlocked roots that sit after the first locked root anchored to the
 * bottom (they must move to just before it) or before the last locked root anchored to the top
 * (they must move to just after it). `roots` - root tabs of a panel in order.
 */
export function getHealMoves(roots: LockRoot[]): {
  toBottom: ID[]
  bottomAnchor?: ID
  toTop: ID[]
  topAnchor?: ID
} {
  const bottomAt = roots.findIndex(r => r.locked && r.lockEnd === 'bottom')
  let topAt = -1
  for (let i = roots.length; i--;) {
    if (roots[i].locked && roots[i].lockEnd === 'top') {
      topAt = i
      break
    }
  }

  const toBottom = bottomAt === -1 ? [] : roots.slice(bottomAt + 1).filter(r => !r.locked)
  const toTop = topAt === -1 ? [] : roots.slice(0, topAt).filter(r => !r.locked)
  return {
    toBottom: toBottom.map(r => r.id),
    bottomAnchor: roots[bottomAt]?.id,
    toTop: toTop.map(r => r.id),
    topAnchor: roots[topAt]?.id,
  }
}

export function clampToFree(
  index: number,
  free: { freeStartIndex: number; freeNextIndex: number }
) {
  if (free.freeNextIndex < 0) return index // panel bounds are not calculated yet
  if (index < free.freeStartIndex) return free.freeStartIndex
  if (index > free.freeNextIndex) return free.freeNextIndex
  return index
}
