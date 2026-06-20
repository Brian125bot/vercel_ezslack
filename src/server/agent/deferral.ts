/**
 * W4-F1: Time-Deferred Request Detection
 *
 * Parses natural-language time references from user messages to determine
 * whether a durable task should be scheduled for later execution rather
 * than queued immediately.
 */

export interface DeferralResult {
  deferred: boolean;
  delayMs?: number;
  label?: string;
}

const MS_MINUTE = 60_000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

/**
 * Detect time-deferred language in a message and return the delay.
 *
 * Handles:
 *  - "remind me in X (minutes|hours|days)"
 *  - "remind me tomorrow"
 *  - "follow up (tomorrow|next week|in N units)"
 *  - "in X (minutes|hours|days)" at start/end of message
 *  - "schedule (this|it) for tomorrow / next week / in N units"
 */
export function detectDeferral(text: string): DeferralResult {
  const t = text.toLowerCase().trim();

  // "remind me in X (minutes|hours|days|weeks)"
  const remindIn = t.match(
    /remind\s+me\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)/
  );
  if (remindIn) {
    const n = parseInt(remindIn[1], 10);
    const unit = normalizeUnit(remindIn[2]);
    const ms = n * unitToMs(unit);
    return { deferred: true, delayMs: ms, label: `remind you in ${n} ${unit}` };
  }

  // "remind me tomorrow"
  if (/remind\s+me\s+tomorrow/.test(t)) {
    return { deferred: true, delayMs: msUntilTomorrow9am(), label: 'remind you tomorrow' };
  }

  // "follow up tomorrow" / "follow up next week" / "follow up in N units"
  const followUpIn = t.match(
    /follow\s*up\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)/
  );
  if (followUpIn) {
    const n = parseInt(followUpIn[1], 10);
    const unit = normalizeUnit(followUpIn[2]);
    const ms = n * unitToMs(unit);
    return { deferred: true, delayMs: ms, label: `follow up in ${n} ${unit}` };
  }
  if (/follow\s*up\s+tomorrow/.test(t)) {
    return { deferred: true, delayMs: msUntilTomorrow9am(), label: 'follow up tomorrow' };
  }
  if (/follow\s*up\s+next\s+week/.test(t)) {
    return { deferred: true, delayMs: 7 * MS_DAY, label: 'follow up next week' };
  }

  // "schedule (this|it) for tomorrow / next week / in N units"
  const scheduleIn = t.match(
    /schedule\s+(?:this|it)\s+(?:for\s+)?in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)/
  );
  if (scheduleIn) {
    const n = parseInt(scheduleIn[1], 10);
    const unit = normalizeUnit(scheduleIn[2]);
    const ms = n * unitToMs(unit);
    return { deferred: true, delayMs: ms, label: `scheduled in ${n} ${unit}` };
  }
  if (/schedule\s+(?:this|it)\s+(?:for\s+)?tomorrow/.test(t)) {
    return { deferred: true, delayMs: msUntilTomorrow9am(), label: 'scheduled for tomorrow' };
  }
  if (/schedule\s+(?:this|it)\s+(?:for\s+)?next\s+week/.test(t)) {
    return { deferred: true, delayMs: 7 * MS_DAY, label: 'scheduled for next week' };
  }

  // Bare "in X (minutes|hours|days)" at start or end of the message
  // Be conservative — only match if preceded/followed by an action verb or at boundaries
  const bareIn = t.match(
    /(?:^|\s)in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)(?:\s|$)/
  );
  if (bareIn && hasActionContext(t)) {
    const n = parseInt(bareIn[1], 10);
    const unit = normalizeUnit(bareIn[2]);
    const ms = n * unitToMs(unit);
    return { deferred: true, delayMs: ms, label: `deferred ${n} ${unit}` };
  }

  return { deferred: false };
}

/**
 * Check if the message has an action-oriented context that suggests a deferral
 * rather than a reference to past time (e.g., "what happened in 2 hours" vs
 * "check this in 2 hours").
 */
function hasActionContext(text: string): boolean {
  return /\b(remind|check|follow|ping|notify|alert|revisit|review|send|post|do|run|execute)\b/.test(text);
}

function normalizeUnit(raw: string): string {
  const u = raw.toLowerCase();
  if (u.startsWith('min')) return 'minutes';
  if (u.startsWith('hr') || u.startsWith('hour')) return 'hours';
  if (u.startsWith('day')) return 'days';
  if (u.startsWith('week')) return 'weeks';
  return u;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case 'minutes': return MS_MINUTE;
    case 'hours': return MS_HOUR;
    case 'days': return MS_DAY;
    case 'weeks': return 7 * MS_DAY;
    default: return MS_MINUTE;
  }
}

/**
 * Milliseconds from now until 9:00 AM tomorrow (local server time).
 * If it's before 9 AM, "tomorrow" still means the *next* calendar day.
 */
function msUntilTomorrow9am(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}
