// AutoFlow Overlap Queue Controller.
// Manages concurrency gating: decides when the next task can start
// based on a time-based delay range (overlapDelayMinSeconds/MaxSeconds).
//
// Starts are paced one-by-one. The background pump owns the delay between
// starts; this controller only enforces active-slot limits and task metadata.

import { TaskStatus } from "./task-ledger.js";

const ACTIVE_STATUSES = new Set([
  TaskStatus.submitting,
  TaskStatus.generating,
  TaskStatus.downloading
]);

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRange(minValue, maxValue, minBound, maxBound, fallbackMin, fallbackMax = fallbackMin) {
  const min = clampNumber(minValue, minBound, maxBound, fallbackMin);
  const max = clampNumber(maxValue, minBound, maxBound, fallbackMax);
  return min <= max ? { min, max } : { min: max, max: min };
}

export function normalizeOverlapConfig(presets = {}) {
  const enabled = presets?.overlapEnabled === true;
  const hasStartMin = Object.prototype.hasOwnProperty.call(presets || {}, "overlapDelayMinSeconds");
  const hasStartMax = Object.prototype.hasOwnProperty.call(presets || {}, "overlapDelayMaxSeconds");
  const hasLegacyDelay = Object.prototype.hasOwnProperty.call(presets || {}, "overlapDelaySeconds");
  const legacyDelay = clampNumber(presets?.overlapDelaySeconds, 5, 600, 20);
  const startDelay = normalizeRange(
    hasStartMin ? presets?.overlapDelayMinSeconds : (hasLegacyDelay && !hasStartMax ? legacyDelay : 15),
    hasStartMax ? presets?.overlapDelayMaxSeconds : legacyDelay,
    5,
    600,
    15,
    legacyDelay
  );
  const completionDelay = normalizeRange(
    presets?.overlapCompletionDelayMinSeconds,
    presets?.overlapCompletionDelayMaxSeconds,
    0,
    600,
    4,
    6
  );
  return {
    enabled,
    maxConcurrentTasks: enabled
      ? clampNumber(presets?.overlapMaxConcurrentTasks, 1, 4, 2)
      : 1,
    delaySeconds: startDelay.max,
    delayMinSeconds: startDelay.min,
    delayMaxSeconds: startDelay.max,
    completionDelayMinSeconds: completionDelay.min,
    completionDelayMaxSeconds: completionDelay.max
  };
}

export function isOverlapActiveTask(task = {}) {
  return ACTIVE_STATUSES.has(task.status);
}

function getTaskDelayBaseAtMs(task = {}) {
  const raw =
    task.overlapStartedAt ||
    task.submitAttemptStartedAt ||
    task.submittedAt ||
    task.startedAt ||
    "";

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function randomRangeSeconds(minValue, maxValue) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? max : safeMin;
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);
  if (high <= low) return low;
  return low + Math.random() * (high - low);
}

function parseTimeMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createOverlapController({
  ledger,
  scheduler,
  getPresets = () => ({}),
  now = () => Date.now()
} = {}) {
  if (!ledger) throw new Error("Overlap controller requires a task ledger");
  if (!scheduler) throw new Error("Overlap controller requires a scheduler");

  function getConfig() {
    return normalizeOverlapConfig(getPresets() || {});
  }

  function getActiveTasks() {
    if (typeof scheduler.listActiveTasks === "function") {
      return scheduler.listActiveTasks();
    }

    return ledger
      .listTasks()
      .filter((task) => isOverlapActiveTask(task));
  }

  function getAvailableSlots() {
    const config = getConfig();
    const activeCount = getActiveTasks().length;
    return Math.max(0, config.maxConcurrentTasks - activeCount);
  }

  function pickNextTasksToStart(limit = null) {
    const config = getConfig();
    const activeTasks = getActiveTasks();
    const activeCount = activeTasks.length;
    const freeSlots = Math.max(0, config.maxConcurrentTasks - activeCount);

    if (freeSlots <= 0) return [];

    const requestedLimit = Number(limit);
    const startLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(freeSlots, requestedLimit)
      : (config.enabled ? 1 : freeSlots);

    if (typeof scheduler.nextPendingTasks === "function") {
      return scheduler.nextPendingTasks(startLimit);
    }

    const one = scheduler.nextPendingTask?.();
    return one ? [one] : [];
  }

  function shouldUnlockNextTask(task = {}) {
    const config = getConfig();

    if (!config.enabled) {
      return { ok: false, reason: "overlap_disabled" };
    }

    if (!task?.id) {
      return { ok: false, reason: "missing_task" };
    }

    if (task.overlapUnlockedNext === true) {
      return { ok: false, reason: "already_unlocked" };
    }

    if (task.overlapUnlockConsumedAt) {
      return { ok: false, reason: "unlock_consumed" };
    }

    if (!isOverlapActiveTask(task)) {
      return { ok: false, reason: "task_not_active" };
    }

    const startedAtMs = getTaskDelayBaseAtMs(task);

    if (!Number.isFinite(startedAtMs)) {
      return { ok: false, reason: "missing_delay_base" };
    }

    let unlockAtMs = parseTimeMs(task.nextOverlapUnlockAt);

    if (!Number.isFinite(unlockAtMs)) {
      const delaySeconds = randomRangeSeconds(
        config.delayMinSeconds,
        config.delayMaxSeconds
      );

      unlockAtMs = startedAtMs + Math.round(delaySeconds * 1000);

      ledger.updateTask(task.id, {
        nextOverlapUnlockAt: new Date(unlockAtMs).toISOString(),
        nextOverlapUnlockDelaySeconds: Number(delaySeconds.toFixed(2))
      });
    }

    const remainingSeconds = Math.max(0, (unlockAtMs - now()) / 1000);
    const elapsedSeconds = Math.max(0, (now() - startedAtMs) / 1000);

    if (remainingSeconds <= 0) {
      return {
        ok: true,
        reason: "timer",
        elapsedSeconds,
        delaySeconds: task.nextOverlapUnlockDelaySeconds || config.delayMaxSeconds
      };
    }

    return {
      ok: false,
      reason: "waiting",
      elapsedSeconds,
      remaining: remainingSeconds,
      delaySeconds: task.nextOverlapUnlockDelaySeconds || config.delayMaxSeconds
    };
  }

  function markUnlockedNext(taskId, reason = "unknown") {
    const task = ledger.getTask(taskId);
    if (!task) return null;

    return ledger.updateTask(taskId, {
      overlapUnlockedNext: true,
      overlapUnlockReason: String(reason || "unknown")
    });
  }

  function markUnlockConsumed(taskId) {
    const task = ledger.getTask(taskId);
    if (!task) return null;

    return ledger.updateTask(taskId, {
      overlapUnlockedNext: false,
      overlapUnlockConsumedAt: new Date(now()).toISOString()
    });
  }

  function maybeUnlockFromTask(taskId) {
    const task = ledger.getTask(taskId);
    const decision = shouldUnlockNextTask(task);

    if (!decision.ok) return decision;

    markUnlockedNext(taskId, decision.reason);
    return decision;
  }

  return {
    getConfig,
    getActiveTasks,
    getAvailableSlots,
    pickNextTasksToStart,
    shouldUnlockNextTask,
    markUnlockedNext,
    markUnlockConsumed,
    maybeUnlockFromTask,
    markTaskProgress(taskId, _percent, _source) {
      // Stub: purely time-based gating is now handled via shouldUnlockNextTask
    }
  };
}
