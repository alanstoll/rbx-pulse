/** Time-of-day sync window, e.g. run only 02:00-06:00 in a timezone. */
export interface SyncWindow {
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** 0 if the window is open now, otherwise milliseconds until it next opens. */
export function msUntilOpen(window: SyncWindow | undefined, now = new Date()): number {
  if (!window) return 0;
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  const cur = localMinutes(now, window.timezone);
  const open = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  if (open) return 0;
  const untilStart = ((start - cur + 1440) % 1440) * 60_000;
  return untilStart === 0 ? 1440 * 60_000 : untilStart;
}
