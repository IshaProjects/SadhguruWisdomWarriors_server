export function utcStartOfDay(value = new Date()) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function utcEndOfDay(value = new Date()) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export function parseYmdToUtcStart(ymd) {
  if (!ymd) return null;
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function parseYmdToUtcEnd(ymd) {
  if (!ymd) return null;
  return new Date(`${ymd}T23:59:59.999Z`);
}

export function utcDateString(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}
