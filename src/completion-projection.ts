import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

interface CompletionState { inheritedEventCount: number; completedAt: number | null }
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { harnessTaskCompletedAt: number | null }
  interface SessionProjectionStateMap { harnessTaskCompletedAt: CompletionState }
}
const timestamp = z.number().finite().nonnegative().nullable()

/** Only this Session's own task ends count; metadata and inherited fork history do not. */
export const completionProjection = {
  key: 'harnessTaskCompletedAt', stateVersion: 1,
  stateSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), completedAt: timestamp }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, completedAt: null }),
  apply: (state, event) => event.type === 'turn/end' && event.seq >= state.inheritedEventCount
    ? { ...state, completedAt: event.time } : state,
  wire: { viewSchema: timestamp, view: state => state.completedAt },
} satisfies ProjectionDefinition<'harnessTaskCompletedAt'>
