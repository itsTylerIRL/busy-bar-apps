// Thin client for the BUSY Bar local HTTP API, written against raw fetch.
// busy-lib's client needs AbortSignal, which firmware 1.3.1's JerryScript runtime lacks.

const BASE = `http://${__BUSY_ADDR__}/api`;

/** Lowest priority that still draws over a launched JS app's own screen (50 is refused). */
export const PRIORITY = 60;

/** A display element as the /display/draw endpoint takes it. */
export type Element = { id: string; type: string } & Record<string, unknown>;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Draws (or updates, by id) elements on the front screen. `led` blinks the status LED and must be #RRGGBBAA. */
export function draw(app: string, elements: Element[], led?: string): Promise<unknown> {
  const body: Record<string, unknown> = { application_name: app, priority: PRIORITY, elements };
  if (led) body.led_notification_color = led;
  return call("POST", "/display/draw", body);
}

/** Removes elements by id, or everything the app drew when ids is omitted. */
export function clear(app: string, ids?: string[]): Promise<unknown> {
  return call("DELETE", "/display/draw", ids ? { application_name: app, element_ids: ids } : { application_name: app });
}

/** Plays a firmware sound, e.g. "shared/sounds/calendar_event_starts.snd". */
export function playStock(app: string, stockPath: string): Promise<unknown> {
  return call("POST", "/audio/play", { application_name: app, stock_path: stockPath });
}

export function stopAudio(): Promise<unknown> {
  return call("DELETE", "/audio/play");
}

/** Stored values from appmeta/settings.json, or {} when unavailable. */
export async function loadSettings(app: string): Promise<Record<string, unknown>> {
  try {
    const res = (await call("GET", `/apps/settings?app_id=${app}`)) as { values?: Record<string, unknown> } | null;
    return res?.values ?? {};
  } catch {
    return {};
  }
}

/** A text element anchored at (x, y). */
export function text(
  id: string,
  value: string,
  font: string,
  x: number,
  y: number,
  align: string,
  color = "#FFFFFFFF",
  extra?: Record<string, unknown>,
): Element {
  const el: Element = { id, type: "text", text: value, font, x, y, align, color };
  if (extra) for (const k in extra) el[k] = extra[k];
  return el;
}

