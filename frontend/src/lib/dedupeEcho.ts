import { Transcript } from '@/types';

/** Seconds within which a mic segment may be an echo of a system segment. */
const ECHO_TIME_WINDOW = 4;
/** Minimum word-overlap ratio to treat a mic segment as an echo. */
const ECHO_SIMILARITY = 0.7;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-set overlap ratio (intersection over the larger set) — strict on length mismatch. */
function similarity(a: string, b: string): number {
  const wa = new Set(normalize(a).split(' ').filter(Boolean));
  const wb = new Set(normalize(b).split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach((w) => {
    if (wb.has(w)) inter++;
  });
  return inter / Math.max(wa.size, wb.size);
}

type EchoCandidate = Pick<Transcript, 'text' | 'speaker' | 'audio_start_time'>;

/**
 * Remove microphone segments that are echoes of system audio (speakers → mic bleed).
 *
 * When the user listens through speakers, the microphone physically picks up the
 * system audio, so both the mic pass and the system pass transcribe the same speech,
 * producing a duplicate line. A mic segment is dropped when a system segment overlaps
 * within ECHO_TIME_WINDOW seconds and their text is at least ECHO_SIMILARITY similar.
 * System («Не Я») segments are always kept; only the mic («Я») echo is removed.
 *
 * No-op when there are no system segments (e.g. headphones, mic-only recordings).
 */
export function dedupeEcho<T extends EchoCandidate>(items: T[]): T[] {
  const systemSegs = items.filter((t) => (t.speaker || '').toLowerCase() === 'system');
  if (systemSegs.length === 0) return items;

  return items.filter((t) => {
    if ((t.speaker || '').toLowerCase() !== 'mic') return true;
    const ts = t.audio_start_time ?? 0;
    for (const s of systemSegs) {
      const ss = s.audio_start_time ?? 0;
      if (Math.abs(ts - ss) <= ECHO_TIME_WINDOW && similarity(t.text, s.text) >= ECHO_SIMILARITY) {
        return false; // drop mic echo duplicate
      }
    }
    return true;
  });
}
