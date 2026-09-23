/**
 * The plugin's configuration. The Loader parses the profile entry with `Config`; DSH Settings edits its volatile fields
 * live (namespace = the profile entry id) and persists them in the profile's Cordis patch. Consumers read a fresh
 * snapshot on every use, so an edit applies to the next request, cache fill or session without a restart.
 */
import Schema from '@deepseek-ai/schemastery';
import { feedbackInstructions } from './feedback.js';

// No `.max(Infinity)` for an unbounded field: DSH Settings sends the schema as JSON, where Infinity becomes null and the
// page's rebuilt schema would then reject every value.
const count = (min: number, value: number, max?: number) => (max === undefined ? Schema.natural().min(min) : Schema.natural().min(min).max(max)).default(value).volatile();
export const Config = Schema.object({
  /** Plugin state directory; not live, since sidecars would have to move with it. */
  root: Schema.string(),
  codexCommand: Schema.string().default('codex').volatile(),
  /** Unset: `CLAUDE_COMMAND_PATH`, then `claude` on PATH and the usual install locations. */
  claudeCommand: Schema.string().volatile(),
  idleCloseSeconds: count(5, 60),
  delegateHarnesses: Schema.array(Schema.union(['dsh', 'codex', 'claude-code'])).default(['codex']).volatile(),
  delegateReportBack: Schema.boolean().default(false).volatile(),
  delegateWorktree: Schema.boolean().default(false).volatile(),
  discussHarnesses: Schema.array(Schema.union(['codex', 'claude-code'])).default(['codex', 'claude-code']).volatile(),
  progressFeedback: Schema.boolean().default(true).volatile(),
  progressFeedbackText: Schema.string().role('textarea').default(feedbackInstructions).volatile(),
  requestTimeoutSeconds: count(5, 60),
  sessionLoadTimeoutSeconds: count(10, 120),
  discussionTimeoutMinutes: count(1, 30),
  toolOutputChars: count(1_000, 64_000),
  peerReviewChars: count(1_000, 12_000),
  // One page of a delegation read; the read request caps a page at 64,000 characters.
  discussionResultChars: count(1_000, 16_000, 64_000),
  catalogCacheSeconds: count(0, 60),
  // Account probes are rate-limited upstream.
  quotaCacheSeconds: count(10, 60),
  pluginCacheSeconds: count(0, 30),
  recoveryCheckSeconds: count(5, 30),
  acpStderr: Schema.boolean().default(false).volatile(),
});
type Parsed = ReturnType<typeof Config>;
/** One snapshot of the live settings. */
export type Settings = { readonly [K in Exclude<keyof Parsed, 'root'>]-?: Parsed[K] extends { get(): infer V } ? V : Parsed[K] };
export type SettingsSource = () => Settings;

/** Reads the current values behind a parsed Config's volatile references. */
export function settingsOf(config: Parsed): SettingsSource {
  return () => Object.fromEntries(Object.entries(config).flatMap(([key, value]) => key === 'root' ? []
    : [[key, typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function' ? value.get() : value]])) as Settings;
}
/** Built-in defaults, for callers constructed without a profile entry (tests, probes). */
export const defaultSettings = settingsOf(Config({}));
/** The progress-feedback contract given to each Harness session, or nothing when turned off. */
export const feedbackOf = (settings: Settings) => settings.progressFeedback ? settings.progressFeedbackText ?? '' : '';
