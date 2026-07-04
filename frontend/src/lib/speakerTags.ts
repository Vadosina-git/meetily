/**
 * Speaker tag helpers. Kept generic so more speakers can be added later —
 * cycling always moves to the next tag in SPEAKER_ORDER and wraps around.
 */
export const SPEAKER_ORDER = ['mic', 'system'] as const;

const LABELS: Record<string, string> = {
  mic: 'Я',
  system: 'Не Я',
};

/** Normalized tag value, or '' if not a known speaker. */
export function normalizeSpeaker(s?: string): string {
  const v = (s || '').trim().toLowerCase();
  return (SPEAKER_ORDER as readonly string[]).includes(v) ? v : '';
}

/** Human label for a tag ("Я" / "Не Я"), or null if unknown. */
export function speakerLabel(s?: string): string | null {
  return LABELS[normalizeSpeaker(s)] ?? null;
}

/** Next tag in the cycle (wraps). Unknown current → first tag. */
export function nextSpeaker(current?: string): string {
  const cur = normalizeSpeaker(current);
  const idx = SPEAKER_ORDER.indexOf(cur as (typeof SPEAKER_ORDER)[number]);
  return SPEAKER_ORDER[(idx + 1) % SPEAKER_ORDER.length];
}
