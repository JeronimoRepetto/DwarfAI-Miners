// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PageHeader from './PageHeader.vue'

describe('PageHeader', () => {
  it('is the page heading alone when the page has no tools', () => {
    const header = mount(PageHeader, { props: { title: 'Settings' } })
    expect(header.get('h1.dm-phead__title').text()).toBe('Settings')
    expect(header.find('input').exists()).toBe(false)
    expect(header.findAll('.dm-phead__actions button')).toHaveLength(0)
  })

  it('carries the search, named for the page, with the design’s placeholder', () => {
    const header = mount(PageHeader, { props: { title: 'Mines', search: true } })
    const field = header.get('.dm-phead__search input')
    expect(field.attributes()).toMatchObject({
      type: 'search',
      placeholder: 'Search by name',
      'aria-label': 'Search mines'
    })
  })

  it('hands every keystroke on as it is typed', async () => {
    const header = mount(PageHeader, { props: { title: 'Mines', search: true } })
    await header.get('input').setValue('lal')
    expect(header.emitted('search')).toEqual([['lal']])
  })

  it('names the current order on the sort button, and the add button by what it adds', () => {
    const header = mount(PageHeader, {
      props: { title: 'Mines', sortLabel: 'Tier, richest first', addLabel: 'Add a mine' }
    })
    const [sort, add] = header.findAll('.dm-phead__actions button')
    expect(sort!.attributes('aria-label')).toBe('Sort: Tier, richest first')
    expect(sort!.attributes('title')).toBe('Sort: Tier, richest first')
    expect(add!.attributes('aria-label')).toBe('Add a mine')
  })

  it('asks for the next order and for an add', async () => {
    const header = mount(PageHeader, {
      props: { title: 'Mines', sortLabel: 'Name', addLabel: 'Add a mine' }
    })
    const [sort, add] = header.findAll('.dm-phead__actions button')
    await sort!.trigger('click')
    await add!.trigger('click')
    expect(header.emitted('sort')).toHaveLength(1)
    expect(header.emitted('add')).toHaveLength(1)
  })

  it('holds the add button while an add is already under way', () => {
    const header = mount(PageHeader, {
      props: { title: 'Mines', addLabel: 'Add a mine', addDisabled: true }
    })
    expect(header.get('.dm-phead__actions button').attributes('disabled')).toBeDefined()
  })
})
