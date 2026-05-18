// AutoFlow Overlap Queue Controller.
// Manages concurrency gating: decides when the next task can start
// based on a time-based delay (overlapDelaySeconds).
//
// API submits can run in parallel up to the configured slot count.
// DOM submits share one composer/debugger path, so only the DOM submit action is
// serialized while generation/polling still overlaps for DOM and API tasks.

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

function getTaskStartedAtMs(task = {}) {
  const raw =
    task.overlapStartedAt ||
    task.submittedAt ||
    task.submitAttemptStartedAt ||
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

  function pickNextTasksToStart() {
    const config = getConfig();
    const activeTasks = getActiveTasks();
    const activeCount = activeTasks.length;
    const freeSlots = Math.max(0, config.maxConcurrentTasks - activeCount);

    if (freeSlots <= 0) return [];

    let startLimit = freeSlots;

    // In overlap mode, starts are paced one-by-one. The first task starts
    // immediately; each later task needs one active task to unlock it after
    // overlapDelaySeconds.
    if (config.enabled && activeCount > 0) {
      const hasUnlock = activeTasks.some(t => t.overlapUnlockedNext === true);
      if (!hasUnlock) return [];
      startLimit = 1;
    } else if (config.enabled) {
      startLimit = 1;
    }

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

    const startedAtMs = getTaskStartedAtMs(task);

    if (!Number.isFinite(startedAtMs)) {
      return { ok: false, reason: "missing_started_at" };
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
