import type { Page } from '@playwright/test'

/**
 * A timeline of what the Veta page shows and moves (ISSUE-292; 07 machine 26), recorded in the page itself so nothing
 * is missed between two polls: the entrance lamp lit or not, a chamber, a dwarf (with its walk) or the entrance added
 * or removed, each dwarf's walk (`data-walk`), every motion started or ended with its timing (the endless lantern loop left out), and
 * every window resize. Times are the page's `performance.now()`, in whole milliseconds.
 *
 * The page's own scripts are strings: the e2e project has no DOM types.
 */
export type VetaMoment = [at: number, what: string]

const RECORDER = `(() => {
  if (window.__vetaLog !== undefined) return
  const log = []
  window.__vetaLog = log
  const note = (what) => log.push([Math.round(performance.now()), what])
  const nameOf = (el) => {
    if (!(el instanceof Element)) return null
    if (el.matches('[data-veta-entrance]')) return 'entrance'
    if (el.matches('[data-veta-chamber]')) return 'chamber'
    if (el.matches('[data-veta-dwarf]')) return 'dwarf'
    if (el.matches('[data-veta-part]')) return 'part:' + el.getAttribute('data-veta-part')
    return null
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target
        if (record.attributeName === 'data-walk' && el.matches('[data-veta-dwarf]')) {
          note('walk:' + (el.getAttribute('data-walk') ?? 'none'))
        } else if (record.attributeName === 'class' && el.matches('[data-veta-entrance]')) {
          const lit = el.classList.contains('is-lit')
          if (lit !== (record.oldValue ?? '').split(' ').includes('is-lit')) note(lit ? 'lamp:lit' : 'lamp:dim')
        }
        continue
      }
      for (const node of record.addedNodes) {
        const name = nameOf(node)
        const walkOf = (d) => '+dwarf:' + (d.getAttribute('data-walk') ?? 'none')
        if (name === 'dwarf') note(walkOf(node))
        else if (name !== null) note('+' + name)
        if (node instanceof Element) for (const d of node.querySelectorAll('[data-veta-dwarf]')) note(walkOf(d))
      }
      for (const node of record.removedNodes) {
        const name = nameOf(node)
        if (name !== null) note('-' + name)
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'data-walk']
  })
  const animate = Element.prototype.animate
  Element.prototype.animate = function (keyframes, options) {
    const animation = animate.call(this, keyframes, options)
    if (options && options.iterations === Infinity) return animation
    const what = (nameOf(this) ?? this.tagName.toLowerCase()) + ' ' + (options?.duration ?? 0) + 'ms+' + (options?.delay ?? 0)
    note('start ' + what)
    animation.addEventListener('finish', () => note('end ' + what))
    animation.addEventListener('cancel', () => note('cancel ' + what))
    return animation
  }
  window.addEventListener('resize', () => note('resize ' + innerWidth + 'x' + innerHeight))
})()`

/** Starts recording in the Veta page (once). */
export async function recordVetaMotion(veta: Page): Promise<void> {
  await veta.evaluate(RECORDER)
}

/** The moments recorded so far. */
export function vetaMoments(veta: Page): Promise<VetaMoment[]> {
  return veta.evaluate('window.__vetaLog ?? []') as Promise<VetaMoment[]>
}

/** The recorded moments' names, in order, filtered by a prefix list. */
export function namesOf(moments: readonly VetaMoment[], prefixes: readonly string[]): string[] {
  return moments.map(([, what]) => what).filter((what) => prefixes.some((p) => what.startsWith(p)))
}
