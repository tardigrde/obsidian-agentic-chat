import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { toolResult } from "./result";

export const CURRENT_TIME_TOOL_NAME = "current_time";

const CurrentTimeParameters = Type.Object({});

/**
 * The `current_time` tool: the local date, time, weekday, and time zone. The
 * system prompt carries only today's date, so this is the source for the time
 * of day. Read-only; deferred behind `search_tools`.
 */
export function createCurrentTimeTool(now: () => Date = () => new Date()): AgentTool<typeof CurrentTimeParameters> {
  return {
    name: CURRENT_TIME_TOOL_NAME,
    label: "Current time",
    description: "Current local date and time, weekday, UTC offset, and time zone.",
    parameters: CurrentTimeParameters,
    execute: async () => {
      const date = now();
      const clock = describeLocalTime(date);
      const text =
        `Local time: ${clock.date} ${clock.time} (${clock.weekday})\n` +
        `Time zone: ${clock.timeZone} (UTC${clock.utcOffset})\n` +
        `ISO 8601: ${clock.iso}`;
      return toolResult(text, { ...clock, epochMs: date.getTime() });
    },
  };
}

export interface LocalTimeDescription {
  /** YYYY-MM-DD in local time. */
  date: string;
  /** HH:MM:SS in local time, 24-hour. */
  time: string;
  weekday: string;
  /** IANA zone name, or "local" when the runtime does not report one. */
  timeZone: string;
  /** "+HH:MM" or "-HH:MM". */
  utcOffset: string;
  /** Local ISO 8601 with the UTC offset. */
  iso: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function describeLocalTime(date: Date): LocalTimeDescription {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return {
    date: day,
    time,
    weekday: WEEKDAYS[date.getDay()],
    timeZone: localTimeZone(),
    utcOffset,
    iso: `${day}T${time}${utcOffset}`,
  };
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

/** One system-prompt line with today's date only, so the prompt changes at most once a day. */
export function formatTodayLine(date: Date): string {
  const clock = describeLocalTime(date);
  return `Today is ${clock.weekday}, ${clock.date} (time zone ${clock.timeZone}). For the time of day, use the current_time tool.`;
}
