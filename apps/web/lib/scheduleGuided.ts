export type ScheduleMode = "daily" | "weekdays" | "every-hours" | "custom";

export type GuidedScheduleState = {
  mode: ScheduleMode;
  time: string;
  intervalHours: number;
  summary: string;
};

function isDigitsToken(value: string) {
  return /^\d+$/.test(value);
}

function parseTimeValue(value: string) {
  const text = String(value || "").trim();
  const parts = text.split(":");
  if (parts.length !== 2 || !isDigitsToken(parts[0] ?? "") || !isDigitsToken(parts[1] ?? "")) {
    return { hour: 7, minute: 0, text: "07:00" };
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 7, minute: 0, text: "07:00" };
  }
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function parseGuidedScheduleFromCron(expression: string): GuidedScheduleState {
  const value = String(expression || "").trim();
  if (!value) {
    return {
      mode: "daily",
      time: "07:00",
      intervalHours: 6,
      summary: "Daily at 07:00.",
    };
  }

  const parts = value.split(/\s+/);
  if (parts.length < 5) {
    return {
      mode: "custom",
      time: "07:00",
      intervalHours: 6,
      summary: "Custom cron schedule in use.",
    };
  }

  const minute = parts[0] ?? "";
  const hour = parts[1] ?? "";
  const dayOfMonth = parts[2] ?? "";
  const month = parts[3] ?? "";
  const dayOfWeek = parts[4] ?? "";
  const isDaily = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
  const isWeekdays = dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5";

  if ((isDaily || isWeekdays) && isDigitsToken(minute) && isDigitsToken(hour)) {
    const parsedMinute = Number(minute);
    const parsedHour = Number(hour);
    if (parsedMinute >= 0 && parsedMinute <= 59 && parsedHour >= 0 && parsedHour <= 23) {
      const time = `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
      return {
        mode: isWeekdays ? "weekdays" : "daily",
        time,
        intervalHours: 6,
        summary: `${isWeekdays ? "Weekdays at " : "Daily at "}${time}.`,
      };
    }
  }

  if (
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*" &&
    isDigitsToken(minute) &&
    hour.startsWith("*/") &&
    isDigitsToken(hour.slice(2))
  ) {
    const parsedMinute = Number(minute);
    const intervalHours = Number(hour.slice(2));
    if (parsedMinute >= 0 && parsedMinute <= 59 && intervalHours >= 1 && intervalHours <= 23) {
      return {
        mode: "every-hours",
        time: `00:${String(parsedMinute).padStart(2, "0")}`,
        intervalHours,
        summary: `Every ${intervalHours} hour${intervalHours === 1 ? "" : "s"} at minute ${String(parsedMinute).padStart(2, "0")}.`,
      };
    }
  }

  return {
    mode: "custom",
    time: "07:00",
    intervalHours: 6,
    summary: "Custom cron schedule in use.",
  };
}

export function guidedScheduleToCron(mode: ScheduleMode, time: string, intervalHours: number): string | null {
  if (mode === "custom") return null;

  const parsedTime = parseTimeValue(time);
  const minute = parsedTime.minute;
  const hour = parsedTime.hour;

  if (mode === "daily") return `${minute} ${hour} * * *`;
  if (mode === "weekdays") return `${minute} ${hour} * * 1-5`;

  const boundedInterval = Math.max(1, Math.min(23, Math.trunc(intervalHours || 1)));
  return `${minute} */${boundedInterval} * * *`;
}
