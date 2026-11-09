import type { SettingControl } from "obsidian";

/**
 * Normalize a value written through the declarative settings API (#286).
 *
 * The control definition is the single schema: dropdown options come from the
 * same enum lists the defaults and heal functions use, and slider/number bounds
 * are the ones the UI shows. Text is trimmed, unknown enum values, wrong types
 * and non-finite numbers return `current` unchanged, numbers are clamped.
 * Without a visible control (a hidden row), only a type guard applies.
 */
export function normalizeControlValue(
  control: SettingControl | undefined,
  value: unknown,
  current: unknown,
): unknown {
  if (!control) return sameType(value, current) ? value : current;
  switch (control.type) {
    case "toggle":
      return typeof value === "boolean" ? value : current;
    case "dropdown":
      return typeof value === "string" && Object.prototype.hasOwnProperty.call(control.options, value)
        ? value
        : current;
    case "text":
    case "textarea":
    case "file":
    case "folder":
      return typeof value === "string" ? value.trim() : current;
    case "slider":
    case "number":
      return clampNumber(value, current, control.min, control.max);
    default:
      return sameType(value, current) ? value : current;
  }
}

function clampNumber(value: unknown, current: unknown, min?: number, max?: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return current;
  let next = value;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
}

function sameType(value: unknown, current: unknown): boolean {
  if (current === undefined || current === null) return true;
  if (typeof current === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof current && value !== null;
}

/** Index every declarative control in getSettingDefinitions() output by key. */
export function indexControls(items: readonly unknown[], into = new Map<string, SettingControl>()): Map<string, SettingControl> {
  for (const node of items) {
    if (!node || typeof node !== "object") continue;
    const item = node as { control?: SettingControl; items?: unknown[] };
    if (item.control?.key) into.set(item.control.key, item.control);
    if (item.items) indexControls(item.items, into);
  }
  return into;
}
