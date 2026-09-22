// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { popVariants, pressHoverVariants } from '../../lib/shell/presence'
import WorktreeFoldModal from './WorktreeFoldModal.vue'

const WORKTREE_OF = {
  worktree: 'C:\\Code\\Anvil-worktrees\\forge',
  root: 'C:\\Code\\Anvil',
  branch: 'feat/forge'
}

function modal(props: Record<string, unknown> = {}) {
  return mount(WorktreeFoldModal, {
    props: { worktreeOf: WORKTREE_OF, adding: false, ...props }
  })
}

/**
 * The question asked when the folder somebody picked is a worktree (#348).
 *
 * A QUESTION, not a refusal and not a confirmation: nothing was added, nothing
 * went wrong, and the person is the only one who can say whether the project
 * behind that folder is the one they meant.
 */
describe('WorktreeFoldModal', () => {
  it('names the folder, the project and the branch', () => {
    const text = modal().get('.modal-message').text()
    expect(text).toContain('forge')
    expect(text).toContain('C:\\Code\\Anvil')
    expect(text).toContain('feat/forge')
  })

  it('says the worktree s sessions already reach that project', () => {
    // The fact that makes "Cancel" a real answer rather than a dead end:
    // nothing is lost by not adding this folder, because the board already
    // shows the work done in it.
    expect(modal().get('.modal-message').text()).toMatch(/already show up/i)
  })

  it('offers the project and a way out, and never the worktree itself', () => {
    const wrapper = modal()
    expect(wrapper.get('.modal-open').text()).toBe('Open the main project')
    expect(wrapper.get('.modal-cancel').text()).toBe('Cancel')
    // Declaring the worktree is deliberately not on offer: the board folds it
    // into the project anyway, so the row would name a folder that is never a
    // mine.
    expect(wrapper.findAll('button')).toHaveLength(3)
  })

  it('reports the answer, once', async () => {
    const wrapper = modal()
    await wrapper.get('.modal-open').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('reports a cancel without adding anything', async () => {
    const wrapper = modal()
    await wrapper.get('.modal-cancel').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('reports a dismissal from the close glyph too', async () => {
    const wrapper = modal()
    await wrapper.get('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape, like every other panel that floats', async () => {
    const wrapper = modal()
    await wrapper.get('.worktree-modal').trigger('keydown.escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('locks the primary control while main is adopting, so it cannot fire twice', async () => {
    const wrapper = modal({ adding: true })
    expect(wrapper.get('.modal-open').attributes('disabled')).toBeDefined()
    await wrapper.get('.modal-open').trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('names the commit of a detached worktree instead of a branch', () => {
    const wrapper = modal({
      worktreeOf: { worktree: '/home/j/anvil-wt/forge', root: '/home/j/anvil', commit: '3f2a1b9' }
    })
    expect(wrapper.get('.modal-message').text()).toContain('at commit 3f2a1b9')
  })

  // ADDED for #566 T3: the root is `motion.div` carrying the shared
  // `popVariants`, never a restated literal — `MinesPanel.vue`'s own
  // `<AnimatePresence>` is what actually drives the enter/exit.
  it('carries the shared popVariants on its motion.div root, not a literal of its own', () => {
    const root = modal().findComponent(motion.div)
    expect(root.props('initial')).toEqual(popVariants.initial)
    expect(root.props('animate')).toEqual(popVariants.animate)
    expect(root.props('exit')).toEqual(popVariants.exit)
  })
})

/*
 * ADDED for #566 T4: all three buttons answer a pointer through the shared
 * vocabulary. Named rather than counted, so a fourth added later without
 * feedback fails here.
 */
describe('WorktreeFoldModal press and hover feedback', () => {
  it('routes all three buttons through motion.button carrying the shared variants', () => {
    const controls = modal().findAllComponents(motion.button)

    expect(controls.map((control) => control.classes()[0])).toEqual([
      'modal-close',
      'modal-open',
      'modal-cancel'
    ])
    for (const control of controls) {
      expect(control.props('whileHover')).toEqual(pressHoverVariants.whileHover)
      expect(control.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    }
  })

  it('leaves all three as they were - tag, name, and the refusal while adding', () => {
    const wrapper = modal({ adding: true })

    const close = wrapper.get('.modal-close')
    expect(close.element.tagName).toBe('BUTTON')
    expect(close.attributes('aria-label')).toBe('Close')

    expect(wrapper.get('.modal-open').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.modal-cancel').element.tagName).toBe('BUTTON')
  })
})

/*
 * ADDED for the #566 T4 follow-up: Open is disabled while the add is in flight,
 * and a control that refuses a press must not answer a hover either.
 */
describe('WorktreeFoldModal withholds the gesture from a disabled control', () => {
  it('gives Open no press or hover while the add is in flight', () => {
    const wrapper = modal({ adding: true })
    const open = wrapper
      .findAllComponents(motion.button)
      .find((control) => control.classes().includes('modal-open'))!

    expect(open.attributes('disabled')).toBeDefined()
    expect(open.props('whileHover')).toBeUndefined()
    expect(open.props('whilePress')).toBeUndefined()
    // Cancel stays live: it is how the dialog is left while the work runs.
    expect(wrapper.get('.modal-cancel').attributes('disabled')).toBeUndefined()
  })
})
