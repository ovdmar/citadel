/**
 * Five-field cron parser used by the scheduled-agent runner. Vixie semantics:
 * when both DOM and DOW are non-wild, a date matches if EITHER does.
 */
export type CronExpression = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
};

const CRON_BOUNDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export function parseCronExpression(spec: string): CronExpression {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${parts.length}`);
  const fields = parts.map((part, index) => {
    const bounds = CRON_BOUNDS[index];
    if (!bounds) throw new Error("Unexpected cron field");
    return parseCronField(part, bounds.min, bounds.max);
  });
  const [minute, hour, dom, mon, dow] = fields;
  if (!minute || !hour || !dom || !mon || !dow) throw new Error("Failed to parse cron fields");
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    mon: mon.values,
    dow: dow.values,
    domWild: dom.wild,
    dowWild: dow.wild,
  };
}

function parseCronField(spec: string, min: number, max: number): { values: Set<number>; wild: boolean } {
  if (!spec.length) throw new Error("Empty cron field");
  let wild = false;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    let body = part;
    let step = 1;
    const stepMatch = body.match(/^(.*)\/(\d+)$/);
    if (stepMatch?.[1] !== undefined && stepMatch[2] !== undefined) {
      body = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid cron step in '${part}'`);
    }
    let lo: number;
    let hi: number;
    if (body === "*" || body === "") {
      lo = min;
      hi = max;
      if (spec === "*") wild = true;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number.parseInt(a ?? "", 10);
      hi = Number.parseInt(b ?? "", 10);
    } else {
      lo = Number.parseInt(body, 10);
      hi = lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`Invalid cron number in '${part}'`);
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron value '${part}' out of range [${min}, ${max}]`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw new Error("Cron field produced no values");
  return { values, wild };
}

export function cronMatches(expr: CronExpression, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!expr.minute.has(minute) || !expr.hour.has(hour) || !expr.mon.has(mon)) return false;
  if (expr.domWild && expr.dowWild) return true;
  if (expr.domWild) return expr.dow.has(dow);
  if (expr.dowWild) return expr.dom.has(dom);
  return expr.dom.has(dom) || expr.dow.has(dow);
}

export function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

/**
 * Return the next datetime (>= `from`, exclusive of `from` if seconds==0) at which
 * `spec` will fire. Walks forward minute-by-minute, bounded to one year ahead
 * so a pathological cron returns null instead of looping forever.
 */
export function nextCronRun(spec: string, from: Date = new Date()): Date | null {
  let expr: CronExpression;
  try {
    expr = parseCronExpression(spec);
  } catch {
    return null;
  }
  const start = floorToMinute(from);
  const limit = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
  const cursor = new Date(start.getTime() + 60_000);
  while (cursor.getTime() <= limit.getTime()) {
    if (cronMatches(expr, cursor)) return cursor;
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

/**
 * Plain-English summary of a five-field cron expression. Falls back to the
 * raw spec when the pattern isn't a known preset so the UI never lies about
 * unusual schedules.
 */
export function describeCron(spec: string): string {
  const trimmed = spec.trim();
  let expr: CronExpression;
  try {
    expr = parseCronExpression(trimmed);
  } catch {
    return trimmed;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const formatTime = () => {
    if (expr.hour.size === 1 && expr.minute.size === 1) {
      const hour = Array.from(expr.hour)[0] ?? 0;
      const minute = Array.from(expr.minute)[0] ?? 0;
      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    }
    return null;
  };
  const time = formatTime();
  if (expr.minute.size > 1 && expr.hour.size === 24) return "Every minute";
  if (expr.minute.size === 1 && expr.hour.size === 24) {
    const m = Array.from(expr.minute)[0] ?? 0;
    return m === 0 ? "Every hour" : `Every hour at :${m.toString().padStart(2, "0")}`;
  }
  if (time && expr.domWild && expr.dowWild) return `Every day at ${time}`;
  if (time && expr.domWild && !expr.dowWild) {
    const list = Array.from(expr.dow)
      .sort((a, b) => a - b)
      .map((d) => days[d])
      .join(", ");
    return `Every ${list} at ${time}`;
  }
  if (time && !expr.domWild && expr.dowWild) {
    const list = Array.from(expr.dom)
      .sort((a, b) => a - b)
      .join(", ");
    return `On day ${list} of the month at ${time}`;
  }
  return trimmed;
}
