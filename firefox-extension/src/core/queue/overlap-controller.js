// AutoFlow Overlap Queue Controller.
// Manages concurrency gating: decides when the next task can start
// based on a time-based delay (overlapDelaySeconds).
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

export function normalizeOverlapConfig(presets = {}) {
  const enabled = presets?.overlapEnabled === true;
  return {
    enabled,
    maxConcurrentTasks: enabled
      ? clampNumber(presets?.overlapMaxConcurrentTasks, 1, 4, 2)
      : 1,
    delaySeconds: clampNumber(presets?.overlapDelaySeconds, 5, 600, 30)
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

    const elapsedSeconds = Math.max(0, (now() - startedAtMs) / 1000);

    if (elapsedSeconds >= config.delaySeconds) {
      return { ok: true, reason: "timer" };
    }

    return { ok: false, reason: "waiting", elapsedSeconds, remaining: config.delaySeconds - elapsedSeconds };
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
