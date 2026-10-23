/*
 * The crew's walk in a mine's painting (PANEL-QUESTIONS 14; US-MINE-009), lifted out of the Panel's mine column so a
 * Valle zone walks its crew the same way (EPIC-20 visual parity): one walk, two callers, never a copy.
 *
 * The crew already at work when the painting opens is placed, and a dwarf that turns up later, or one the board saw
 * arrive (#156), walks in from the nearest spawn point along the painted corridors at today's pace; a leaver walks out
 * to its spawn point. The board plans only when a target moves, so a poll does not re-plan the crew. A viewer who asked
 * for less movement gets every dwarf placed, read before the first paint (#71), and watched after it: asking mid-walk
 * drops the board, so every walk under way snaps to its station and its footsteps end; letting motion back starts a
 * fresh board that places the crew standing there, so only a later arrival walks.
 *
 * Who stands where is the caller's (`lib/scene/mineColumn` `mineStands`); how a dwarf gets there is `sceneMotion`'s.
 * Runs inside a component's setup: the board and the motion watch end with it.
 */
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import { INTERIOR_ROUTE, routeBetween } from '../lib/scene/interiorRoute'
import type { DwarfStand } from '../lib/scene/mineColumn'
import { nearestSpawn, sceneLayout, type ScenePoint } from '../lib/scene/sceneLayout'
import {
  createWalkBoard,
  prefersReducedMotion,
  watchReducedMotion,
  type WalkState
} from '../lib/scene/sceneMotion'
import type { MineTier } from '../types'

/** A stand as the walk has it now: its current leg's end, facing the way it goes. */
export type PlacedStand = DwarfStand & { walking: boolean; walkMs: number }

export interface CrewWalkDeps {
  /** Where each dwarf is sent. */
  stands: Readonly<Ref<readonly DwarfStand[]>>
  /** The painting's tier, whose layout names the spawn points. */
  tier(): MineTier
  /** The dwarfs the board saw arrive since it last published (#156), read at each sync. */
  arrived(): ReadonlySet<string>
}

export interface CrewWalk {
  /** Each dwarf where the walk has it now. */
  placed: ComputedRef<PlacedStand[]>
  /** Whether the viewer asked for less movement: no walk at all. */
  reducedMotion: Readonly<Ref<boolean>>
}

export function useCrewWalk(deps: CrewWalkDeps): CrewWalk {
  const reducedMotion = ref(prefersReducedMotion())
  const walks = ref<ReadonlyMap<string, WalkState>>(new Map())
  const newBoard = () =>
    createWalkBoard((state) => {
      walks.value = state
    })
  let board = newBoard()
  function syncBoard(): void {
    if (reducedMotion.value) return
    const targets = new Map<string, ScenePoint>(
      deps.stands.value.map((s) => [s.dwarf.id, { x: s.x, y: s.y }])
    )
    const layout = sceneLayout(deps.tier())
    board.sync(
      targets,
      (from, to) => routeBetween(INTERIOR_ROUTE, from, to),
      (target) => nearestSpawn(layout, target),
      deps.arrived()
    )
  }
  watch(deps.stands, syncBoard, { immediate: true })
  const stopWatchingMotion = watchReducedMotion((reduced) => {
    if (reduced === reducedMotion.value) return
    reducedMotion.value = reduced
    board.dispose()
    walks.value = new Map()
    if (reduced) return
    board = newBoard()
    syncBoard()
  })
  onBeforeUnmount(() => {
    stopWatchingMotion()
    board.dispose()
  })

  const placed = computed(() =>
    deps.stands.value.map((stand) => {
      const walk = walks.value.get(stand.dwarf.id)
      const walking = walk?.walking === true
      return {
        ...stand,
        x: walk?.point.x ?? stand.x,
        y: walk?.point.y ?? stand.y,
        facesLeft: walking ? walk.facesLeft : stand.facesLeft,
        walking,
        walkMs: walking ? walk.legMs : 0
      }
    })
  )
  return { placed, reducedMotion }
}
