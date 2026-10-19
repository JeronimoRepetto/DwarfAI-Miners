import { expect, type Page } from '@playwright/test'

/**
 * The first-run consent step, answered as a person answers it before using the Panel (ISSUE-141; 07 machine 41;
 * US-SET-012). From cut 2 the Host offers the step whenever Claude Code is installed and the step was never answered
 * (07 S41.01; AMENDMENT-9), so a case that installs the Claude stub on a fresh profile meets it, and the step is a
 * modal dialog with no close and no skip (US-SET-012.AC06): nothing behind it takes a click until it is answered.
 *
 * Whether the step is due is the Host's answer, read from the `preferences` section of the snapshot the window reads
 * (A-N01; 14 §6.3), never guessed from what is drawn yet: the Host evaluates the step before it is `ready` (07 S41.01,
 * boot step 8), so once the window attached the answer is final. When it is due, every option is turned off and
 * Activate chosen: an answer with nothing ticked writes nothing into any tool (07 S41.04, S14.14), so the case's world
 * stays as it set it up, and the step settles for good (S41.05). Answers whether the step was due.
 *
 * Call it once the window is shown and the Host attached (`waitForHostAttached`).
 */
export async function answerFirstRunStep(window: Page): Promise<boolean> {
  const due = await window.evaluate(async () => {
    type Chunk = { section: string; data: { welcome?: { due?: boolean } } }
    type Answer = { ok: boolean; value?: { chunks: Chunk[] } }
    const api = (window as unknown as { api: { getHostSnapshot(r: unknown): Promise<Answer> } }).api
    const answered = await api.getHostSnapshot({ sections: ['preferences'] })
    if (!answered.ok || answered.value === undefined) {
      throw new Error('the Host answered no preferences snapshot')
    }
    const chunk = answered.value.chunks.find((candidate) => candidate.section === 'preferences')
    return chunk?.data.welcome?.due === true
  })
  if (!due) return false

  const step = window.locator('.dm-scrim').filter({ has: window.locator('.welcome-step__options') })
  await expect(step, 'the due first-run step is shown').toBeVisible({ timeout: 30_000 })
  const toggles = step.getByRole('switch')
  for (let at = 0; at < (await toggles.count()); at++) {
    const toggle = toggles.nth(at)
    if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  }
  await step.getByRole('button', { name: 'Activate' }).click()
  await expect(step, 'the answered step closes').toBeHidden({ timeout: 30_000 })
  return true
}
