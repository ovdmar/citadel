// Client-side mirror of the server cron parser + describeCron/nextCronRun.
// Kept here instead of importing @citadel/operations so the web bundle does
// not pull in the daemon dependency tree. If the cron grammar changes
// upstream, these helpers need to follow.

type ClientCron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
};

const CLIENT_CRON_BOUNDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const;

function parseClientCron(spec: string): ClientCron | null {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((part, index) => {
    const bounds = CLIENT_CRON_BOUNDS[index];
    if (!bounds) return null;
    return parseClientCronField(part, bounds.min, bounds.max);
  });
  if (parsed.some((entry) => entry === null)) return null;
  const [minute, hour, dom, mon, dow] = parsed as Array<{ values: Set<number>; wild: boolean }>;
  if (!minute || !hour || !dom || !mon || !dow) return null;
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

function parseClientCronField(spec: string, min: number, max: number): { values: Set<number>; wild: boolean } | null {
  if (!spec.length) return null;
  let wild = false;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    let body = part;
    let step = 1;
    const stepMatch = body.match(/^(.*)\/(\d+)$/);
    if (stepMatch?.[1] !== undefined && stepMatch[2] !== undefined) {
      body = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) return null;
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
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) return null;
  return { values, wild };
}

function cronMatchesClient(expr: ClientCron, date: Date): boolean {
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

export function nextCronRunClient(spec: string, from: Date = new Date()): Date | null {
  const expr = parseClientCron(spec);
  if (!expr) return null;
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);
  const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= limit) {
    if (cronMatchesClient(expr, cursor)) return cursor;
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

export function describeCronClient(spec: string): string {
  const trimmed = spec.trim();
  const expr = parseClientCron(trimmed);
  if (!expr) return trimmed || "(empty)";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const onlyOne = (set: Set<number>) => (set.size === 1 ? (Array.from(set)[0] ?? null) : null);
  const time = (() => {
    const hour = onlyOne(expr.hour);
    const minute = onlyOne(expr.minute);
    if (hour === null || minute === null) return null;
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  })();
  if (expr.minute.size > 1 && expr.hour.size === 24) return "Every minute";
  if (expr.minute.size === 1 && expr.hour.size === 24) {
    const minute = onlyOne(expr.minute) ?? 0;
    return minute === 0 ? "Every hour" : `Every hour at :${minute.toString().padStart(2, "0")}`;
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
