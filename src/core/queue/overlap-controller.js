// AutoFlow Overlap Queue Controller.
// Manages concurrency gating: decides when the next task can start
// based on real API/DOM progress or a time-based fallback.
//
// Submit remains serialized (via mutex in service-worker).
// Only generation/polling is overlapped.

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
      ? clampNumber(presets?.overlapMaxConcurrentTasks, 1, 4, 1)
      : 1,
    triggerProgress: clampNumber(presets?.overlapTriggerProgress, 1, 99, 50),
    fallbackSeconds: clampNumber(presets?.overlapFallbackSeconds, 5, 600, 45)
  };
}

export function isOverlapActiveTask(task = {}) {
  return ACTIVE_STATUSES.has(task.status);
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
    const freeSlots = getAvailableSlots();
    if (freeSlots <= 0) return [];

    if (typeof scheduler.nextPendingTasks === "function") {
      return scheduler.nextPendingTasks(freeSlots);
    }

    const one = scheduler.nextPendingTask?.();
    return one ? [one] : [];
  }

  function markTaskProgress(taskId, percent, source = "unknown") {
    const task = ledger.getTask(taskId);
    if (!task) return null;

    const numeric = Number(percent);
    const progressPercent = Number.isFinite(numeric)
      ? Math.min(100, Math.max(0, numeric))
      : null;

    return ledger.updateTask(taskId, {
      progressPercent,
      progressUpdatedAt: new Date(now()).toISOString(),
      lastProgressSource: String(source || "unknown")
    });
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

    if (!isOverlapActiveTask(task)) {
      return { ok: false, reason: "task_not_active" };
    }

    // Check real API/DOM progress first.
    const progress = Number(task.progressPercent);
    if (Number.isFinite(progress) && progress >= config.triggerProgress) {
      return { ok: true, reason: "progress" };
    }

    // Fall back to time-based gate.
    const startedAtMs = Date.parse(
      task.overlapStartedAt ||
      task.submittedAt ||
      task.submitAttemptStartedAt ||
      ""
    );

    if (Number.isFinite(startedAtMs)) {
      const elapsedSeconds = Math.max(0, (now() - startedAtMs) / 1000);
      if (elapsedSeconds >= config.fallbackSeconds) {
        return { ok: true, reason: "timer" };
      }
    }

    return { ok: false, reason: "waiting" };
  }

  function markUnlockedNext(taskId, reason = "unknown") {
    const task = ledger.getTask(taskId);
    if (!task) return null;

    return ledger.updateTask(taskId, {
      overlapUnlockedNext: true,
      overlapUnlockReason: String(reason || "unknown")
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
    markTaskProgress,
    shouldUnlockNextTask,
    markUnlockedNext,
    maybeUnlockFromTask
  };
}
