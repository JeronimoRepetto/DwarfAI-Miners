// @vitest-environment jsdom
import { mount, type DOMWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DwarfTip from '../../components/dwarf/DwarfTip.vue'
import LaunchFailureOutput from '../../components/launch/LaunchFailureOutput.vue'
import ActivityDisclosure from '../../components/message/ActivityDisclosure.vue'
import MessageComposer from '../../components/message/MessageComposer.vue'
import QuestionCard from '../../components/message/QuestionCard.vue'
import { defaultDwarf } from '../../testing/factories'
import { untrustedText } from './untrustedText'

/*
 * C-08 (18 §5.1): a file name, a custom name, a tool summary or an ask payload
 * is text somebody else wrote. Before it is drawn its control characters go,
 * its terminal escapes go, and its bidi controls go, so the string cannot hide
 * characters, colour the panel or reorder what sits around it. Nothing a person
 * can SEE is rewritten: every case below compares against the input with only
 * the controls taken out.
 */

const ESC = '\u001b'
const BEL = '\u0007'

describe('C-08 untrusted strings (18 §5.1)', () => {
  it('[NFR-SEC-07] C0 and C1 control characters except tab and newline are stripped from an untrusted string', () => {
    const c0 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code))
      .filter((char) => char !== '\t' && char !== '\n' && char !== ESC)
      .join('')
    // The C1 forms of CSI, ST and the string introducers open or close an escape sequence of
    // their own; the ANSI case below proves those. Every other C1 character stands alone here.
    const C1_SEQUENCE_BYTES = [0x90, 0x98, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f]
    const c1 = Array.from({ length: 0x20 }, (_, code) => 0x80 + code)
      .filter((code) => !C1_SEQUENCE_BYTES.includes(code))
      .map((code) => String.fromCharCode(code))
      .join('')

    expect(untrustedText(`report${c0}.txt`)).toBe('report.txt')
    expect(untrustedText(`a\u007fb`)).toBe('ab')
    expect(untrustedText(`kept\ttab\nand newline`)).toBe('kept\ttab\nand newline')
    expect(untrustedText('line one\r\nline two')).toBe('line one\nline two')
    expect(untrustedText(`na${c1}me`)).toBe('name')
    expect(untrustedText(`stray${'\u009c'} terminator`)).toBe('stray terminator')
  })

  it('[NFR-SEC-07] ANSI escape sequences are removed from a tool-output tail before display', () => {
    const tail = [
      `${ESC}[31merror${ESC}[0m: build failed`,
      `${ESC}[1;38;5;196mbold red${ESC}[m and ${ESC}[2K${ESC}[1Acursor moves`,
      `${ESC}]0;spoofed window title${BEL}title gone`,
      `${ESC}]8;;https://example.test${ESC}\\hyperlink${ESC}]8;;${ESC}\\ text`,
      `${ESC}(Bcharset${ESC}=keypad ${ESC}7saved${ESC}8`,
      `\u009b32mC1 CSI\u009b0m and \u009dC1 OSC\u009c done`,
      `${ESC}Pdevice control string${ESC}\\after DCS`
    ].join('\n')

    expect(untrustedText(tail)).toBe(
      [
        'error: build failed',
        'bold red and cursor moves',
        'title gone',
        'hyperlink text',
        'charsetkeypad saved',
        'C1 CSI and  done',
        'after DCS'
      ].join('\n')
    )
    // A tail cut off inside a sequence leaves nothing of the sequence behind.
    expect(untrustedText(`ok${ESC}[38;5`)).toBe('ok')
    expect(untrustedText(`ok${ESC}]0;never terminated`)).toBe('ok')
    expect(untrustedText(`ok${ESC}`)).toBe('ok')
  })

  it('[NFR-SEC-07] a permission summary with U+202E cannot visually reorder its command', () => {
    // RIGHT-TO-LEFT OVERRIDE would draw "exe.txt" where "txt.exe" is written.
    const summary = 'Run rm -rf ~/\u202Eexe.txt'
    const cleaned = untrustedText(summary)

    expect(cleaned).toBe('Run rm -rf ~/exe.txt')
    // Every embedding, override and isolate control is gone, so nothing in the string can open a
    // direction run that reaches past it; the bidi isolation around it bounds what is left.
    for (const control of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E']) {
      expect(untrustedText(`git push ${control}--force`)).toBe('git push --force')
    }
    for (const control of ['\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(untrustedText(`npm ${control}publish`)).toBe('npm publish')
    }
  })

  it('[NFR-SEC-07] an untrusted string with nothing to strip comes back exactly as it was written', () => {
    for (const benign of [
      'src/renderer/src/App.vue',
      'Grimli the Delver',
      'שלום עולם', // right-to-left words are text, never controls
      'مرحبا بالعالم',
      'family: 👨\u200D👩\u200D👧 and flag 🏳️\u200D🌈', // ZERO WIDTH JOINER holds an emoji sequence together
      'नमस्ते', // and joins Devanagari conjuncts
      'two\tcolumns\nand two lines',
      ''
    ]) {
      expect(untrustedText(benign)).toBe(benign)
    }
  })

  it('[NFR-SEC-07] a file name, a custom name, a tool summary and an ask payload each render inside a bidi-isolated text node', () => {
    // Each carries a right-to-left override, a NUL and a colour escape; what is drawn is the rest.
    const hostile = (words: string): string => `${ESC}[31m${words}\u202Eexe.txt\u0000${ESC}[0m`
    const drawn = (words: string): string => `${words}exe.txt`

    const fileName = mount(MessageComposer, {
      props: {
        value: '',
        placeholder: 'Write to dwarfai-53…',
        hint: 'Enter sends',
        files: [{ path: 'C:/work/notes', name: hostile('notes') }]
      }
    })
    expectIsolated(fileName.find('.dm-composer__file > span > bdi'), drawn('notes'))
    expect(fileName.find('.dm-composer__file').attributes('title')).toBe(drawn('notes'))

    const customName = mount(DwarfTip, {
      props: { dwarf: defaultDwarf({ name: hostile('Grimli') }) }
    })
    expectIsolated(customName.find('.dm-dtip__name > bdi'), drawn('Grimli'))

    const toolSummary = mount(ActivityDisclosure, {
      props: {
        label: '2 steps',
        open: true,
        lines: [
          { key: 'read', text: hostile('Read src/'), target: 'src/a.ts' },
          { key: 'ran', text: hostile('Ran ls ') }
        ]
      }
    })
    const steps = toolSummary.findAll('.dm-activity__list li')
    expectIsolated(steps[0]!.find('button > bdi'), drawn('Read src/'))
    expect(steps[0]!.find('button').attributes('title')).toBe(drawn('Read src/'))
    expectIsolated(steps[1]!.find('li > bdi'), drawn('Ran ls '))

    const askPayload = mount(QuestionCard, {
      props: {
        name: 'codex-8',
        permission: true,
        answerable: true,
        route: 'message',
        ask: {
          toolUseId: 'toolu_01',
          questions: [
            {
              header: hostile('Bash '),
              question: hostile('rm -rf ~/'),
              multiSelect: false,
              options: [{ label: 'Allow' }, { label: 'Deny' }]
            }
          ]
        }
      }
    })
    expectIsolated(askPayload.find('pre.dm-qcard__req > bdi'), drawn('rm -rf ~/'))
    expectIsolated(askPayload.find('.dm-qcard__header > bdi'), drawn('Bash '))
  })

  it('[NFR-SEC-07] a launch failure renders its tool-output tail without ANSI escapes, bidi-isolated', () => {
    const tail = mount(LaunchFailureOutput, {
      props: { text: `${ESC}[31merror${ESC}[0m: \u2067not logged in\u2069\nrun the login` }
    })
    expectIsolated(tail.find('.dm-add__fail-out > bdi'), 'error: not logged in\nrun the login')
  })
})

/** The string sits in a `<bdi>` as one text node, and is exactly what the rule leaves. */
function expectIsolated(found: DOMWrapper<Element>, drawn: string): void {
  expect(found.exists(), `no <bdi> around "${drawn}"`).toBe(true)
  const nodes = Array.from(found.element.childNodes)
  expect(nodes.map((node) => node.nodeType)).toEqual([Node.TEXT_NODE])
  expect(found.element.textContent).toBe(drawn)
}
