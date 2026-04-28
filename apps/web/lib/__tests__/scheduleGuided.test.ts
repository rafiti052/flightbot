import test from "node:test";
import assert from "node:assert/strict";

import { guidedScheduleToCron, parseGuidedScheduleFromCron } from "../scheduleGuided";

test("parses empty cron as default daily schedule", () => {
  assert.deepEqual(parseGuidedScheduleFromCron(""), {
    mode: "daily",
    time: "07:00",
    intervalHours: 6,
    summary: "Daily at 07:00.",
  });
});

test("parses standard daily and weekdays schedules", () => {
  assert.deepEqual(parseGuidedScheduleFromCron("30 9 * * *"), {
    mode: "daily",
    time: "09:30",
    intervalHours: 6,
    summary: "Daily at 09:30.",
  });

  assert.deepEqual(parseGuidedScheduleFromCron("45 6 * * 1-5"), {
    mode: "weekdays",
    time: "06:45",
    intervalHours: 6,
    summary: "Weekdays at 06:45.",
  });
});

test("parses every-hours schedule and summary", () => {
  assert.deepEqual(parseGuidedScheduleFromCron("15 */4 * * *"), {
    mode: "every-hours",
    time: "00:15",
    intervalHours: 4,
    summary: "Every 4 hours at minute 15.",
  });
});

test("falls back to custom mode for unsupported or invalid cron", () => {
  assert.deepEqual(parseGuidedScheduleFromCron("0 7 * * 0,6"), {
    mode: "custom",
    time: "07:00",
    intervalHours: 6,
    summary: "Custom cron schedule in use.",
  });

  assert.deepEqual(parseGuidedScheduleFromCron("70 9 * * *"), {
    mode: "custom",
    time: "07:00",
    intervalHours: 6,
    summary: "Custom cron schedule in use.",
  });
});

test("converts guided modes to cron and blocks custom conversion", () => {
  assert.equal(guidedScheduleToCron("daily", "09:05", 6), "5 9 * * *");
  assert.equal(guidedScheduleToCron("weekdays", "9:5", 6), "5 9 * * 1-5");
  assert.equal(guidedScheduleToCron("custom", "09:05", 6), null);
});

test("sanitizes invalid time and interval during conversion", () => {
  assert.equal(guidedScheduleToCron("daily", "not-a-time", 6), "0 7 * * *");
  assert.equal(guidedScheduleToCron("every-hours", "12:30", 0), "30 */1 * * *");
  assert.equal(guidedScheduleToCron("every-hours", "12:30", 24), "30 */23 * * *");
  assert.equal(guidedScheduleToCron("every-hours", "12:30", 5.9), "30 */5 * * *");
});

test("preserves critical state transitions for guided round-trips", () => {
  const dailyCron = guidedScheduleToCron("daily", "08:20", 6);
  assert.equal(dailyCron, "20 8 * * *");
  assert.equal(parseGuidedScheduleFromCron(dailyCron ?? "").mode, "daily");

  const weekdaysCron = guidedScheduleToCron("weekdays", "11:40", 6);
  assert.equal(weekdaysCron, "40 11 * * 1-5");
  assert.equal(parseGuidedScheduleFromCron(weekdaysCron ?? "").mode, "weekdays");

  const everyHoursState = parseGuidedScheduleFromCron("10 */3 * * *");
  assert.equal(everyHoursState.mode, "every-hours");
  assert.equal(guidedScheduleToCron(everyHoursState.mode, everyHoursState.time, everyHoursState.intervalHours), "10 */3 * * *");
});
