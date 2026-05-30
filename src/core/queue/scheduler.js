import { TaskStatus } from "./task-ledger.js";

export const ACTIVE_TASK_STATUSES = Object.freeze([
  TaskStatus.submitting,
  TaskStatus.generating,
  TaskStatus.downloading
]);

export function isActiveTaskStatus(status) {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export function queueErrorText(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error === "number") return String(error);
  if (error instanceof Error) return error.message || String(error);
  const detailReasons = Array.isArray(error?.details)
    ? error.details.map((detail) => detail?.reason || detail?.status || detail?.message || "").join(" ")
    : "";
  const parts = [
    error?.code,
    error?.reason,
    error?.status,
    error?.statusText,
    error?.message,
    detailReasons,
    error?.error?.code,
    error?.error?.reason,
    error?.error?.status,
    error?.error?.message
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || "");
  }
}

export function isFlowRendererCrashText(raw = "") {
  const text = queueErrorText(raw).toLowerCase();
  if ((text.includes("number of requests sent exceeds the quota limit") || text.includes("quota limit")) && /error code:?\s*253/.test(text)) {
    return false;
  }
  return text.includes("flow_renderer_crashed") ||
    /aw,\s*snap!?/.test(text) ||
    text.includes("something went wrong while displaying this webpage") ||
    /error code:\s*[a-z0-9_-]+/.test(text);
}

export function flowRendererCrashErrorCode(raw = "") {
  return String(queueErrorText(raw) || "").match(/error code:\s*([a-z0-9_-]+)/i)?.[1] || "";
}

export function isFlowProjectLikeUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)labs\.google(?:\.com)?$/i.test(parsed.hostname)
      && /^\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /https:\/\/labs\.google(?:\.com)?\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/[0-9a-f-]{36}(?:\/|$|\?)/i.test(String(url || ""));
  }
}

export function detectFlowRendererCrashSnapshot(snapshot = {}) {
  const url = String(snapshot.url || snapshot.href || "");
  const title = String(snapshot.title || "");
  const bodyText = String(snapshot.text || snapshot.bodyText || snapshot.body || "");
  const error = String(snapshot.error || snapshot.cdpError || "");
  const combined = [title, bodyText, error].filter(Boolean).join(" ");
  const flowProjectUrl = isFlowProjectLikeUrl(url);
  const crashed = flowProjectUrl && isFlowRendererCrashText(combined);
  return {
    crashed,
    flowProjectUrl,
    class: crashed ? "flow_renderer_crashed" : "",
    retryable: crashed,
    healAction: crashed ? "recover_flow_page" : "",
    scope: crashed ? "global" : "",
    errorCode: crashed ? flowRendererCrashErrorCode(combined) : "",
    textPreview: combined.replace(/\s+/g, " ").trim().slice(0, 240)
  };
}

export function classifyQueueError(error) {
  const raw = queueErrorText(error).toLowerCase();
  if (isFlowRendererCrashText(raw)) {
    return { class: "flow_renderer_crashed", retryable: true, healAction: "recover_flow_page", scope: "global" };
  }
  if (
    raw.includes("store_direct_frame_attach_failed") ||
    raw.includes("dom_frame_ref_attach_not_persisted") ||
    raw.includes("dom_frame_upload") ||
    raw.includes("asset_file_input_not_found") ||
    raw.includes("verifyattachedrefspersisted")
  ) {
    return { class: "dom_frame_attach", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("dom_prompt_not_persisted") || raw.includes("dom_prompt_editor_not_found")) {
    return { class: "dom_debugger", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (
    raw.includes("flow_page_loading") ||
    raw.includes("dom_frontend_not_ready") ||
    raw.includes("composer_ready_state_failed") ||
    (raw.includes("composer_not_ready") && raw.includes("flow_loading")) ||
    raw.includes("message channel closed before a response was received")
  ) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (
    raw.includes("composer_not_ready") &&
    /editor_missing|editor_unstable|create_missing|create_unstable|settings_trigger_missing|settings_trigger_unstable/.test(raw)
  ) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (raw.includes("add_to_prompt_menuitem_not_found")) {
    return { class: "dom_ref_attach", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("dom_debugger_") || raw.includes("chrome_debugger")) {
    return { class: "dom_debugger", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("error code 253") || raw.includes("number of requests sent exceeds the quota limit")) {
    return { class: "rate_limit", retryable: true, healAction: "backoff", scope: "global" };
  }
  if (raw.includes("not_signed_in") || raw.includes("license_required") || raw.includes("subscription") || raw.includes("quota") || raw.includes("credits")) {
    return { class: "account_block", retryable: false, healAction: "account_action_required", scope: "global" };
  }
  if (
    raw.includes("high demand") ||
    raw.includes("capacity") ||
    raw.includes("temporarily unavailable") ||
    raw.includes("too busy") ||
    raw.includes("server busy") ||
    raw.includes("try again later") ||
    raw.includes("wait and try again") ||
    raw.includes("resource_exhausted")
  ) {
    return { class: "flow_capacity", retryable: true, healAction: "wait_for_capacity", scope: "global" };
  }
  if (raw.includes("public_error_model_access_denied") || raw.includes("model_access_denied") || raw.includes("model access denied")) {
    return { class: "model_access", retryable: false, healAction: "choose_supported_model", scope: "task" };
  }
  if (raw.includes("flow_tab_not_found") || raw.includes("missing_project_id") || raw.includes("flow_bridge_not_ready") || raw.includes("page_bridge")) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (raw.includes("unusual") || raw.includes("permission_denied") || raw.includes("403") || raw.includes("recaptcha")) {
    return { class: "session_heat", retryable: true, healAction: "cooldown_and_refresh", scope: "global" };
  }
  if (raw.includes("sexual") || raw.includes("safety") || raw.includes("policy") || raw.includes("inappropriate") || raw.includes("prohibited") || raw.includes("nudity")) {
    return { class: "prompt_safety", retryable: false, healAction: "needs_prompt_edit", scope: "task" };
  }
  if (raw.includes("media_generation_status_failed") || raw.includes("generation_failed") || raw.includes("generated media failed")) {
    return { class: "generation_failed", retryable: true, healAction: "retry_generation", scope: "task" };
  }
  if (raw.includes("upload") || raw.includes("missing_media_id") || raw.includes("missing_generation_ids")) {
    return { class: "media_input", retryable: true, healAction: "retry_media_prepare", scope: "task" };
  }
  if (raw.includes("ref_attach") || raw.includes("asset_browser") || raw.includes("asset_row") || raw.includes("ref_not_serialized")) {
    return { class: "ref_attach", retryable: true, healAction: "api_repair_or_retry_attach", scope: "task" };
  }
  if (raw.includes("queue") && raw.includes("full")) {
    return { class: "flow_queue_full", retryable: true, healAction: "wait_for_capacity", scope: "global" };
  }
  if (raw.includes("rate")) {
    return { class: "rate_limit", retryable: true, healAction: "backoff", scope: "global" };
  }
  return { class: "unknown", retryable: true, healAction: "bounded_retry", scope: "task" };
}

export function createScheduler({ ledger, maxAttempts = 3 } = {}) {
  if (!ledger) throw new Error("Scheduler requires a task ledger");

  return {
    nextPendingTask() {
      return ledger.listTasks().find((task) => task.status === TaskStatus.pending) || null;
    },

    nextPendingTasks(limit = 1) {
      const count = Math.max(1, Number(limit || 1));
      return ledger
        .listTasks()
        .filter((task) => task.status === TaskStatus.pending)
        .slice(0, count);
    },

    listActiveTasks() {
      return ledger
        .listTasks()
        .filter((task) => isActiveTaskStatus(task.status));
    },

    markSubmitting(taskId) {
      const task = ledger.getTask(taskId);
      const now = new Date().toISOString();
      return ledger.updateTask(taskId, {
        status: TaskStatus.submitting,
        attempts: Number(task?.attempts || 0) + 1,
        submitAttemptStartedAt: now,
        overlapStartedAt: now,
        overlapUnlockedNext: false,
        overlapUnlockReason: "",
        overlapUnlockConsumedAt: "",
        progressPercent: null,
        progressUpdatedAt: "",
        lastProgressSource: ""
      });
    },

    markSubmitted(taskId, mediaIds = [], extra = {}) {
      const task = ledger.getTask(taskId) || {};
      const mode = String(task.mode || "");
      const expected = Math.max(1, Number(task.repeatCount || mediaIds.length || 1) || 1);
      const mediaPatch = mode === "text-to-image"
        ? { foundImages: 0, expectedImages: expected }
        : (["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)
            ? { foundVideos: 0, expectedVideos: expected }
            : {});
      return ledger.updateTask(taskId, {
        status: TaskStatus.generating,
        mediaIds,
        outputMediaIds: [],
        outputs: [],
        statusRows: [],
        submitOutputRows: Array.isArray(extra.submitOutputRows) ? extra.submitOutputRows : [],
        downloadedMediaIds: [],
        skippedDownloadMediaIds: [],
        downloadErrorMediaIds: [],
        downloadedCount: 0,
        completedAt: "",
        partialFailure: false,
        failedOutputCount: 0,
        failedOutputMediaIds: [],
        ...mediaPatch,
        submittedAt: new Date().toISOString(),
        overlapStartedAt: task.overlapStartedAt || new Date().toISOString(),
        lastError: "",
        failureClass: "",
        healAction: "",
        failureScope: ""
      });
    },

    markDownloading(taskId) {
      return ledger.updateTask(taskId, {
        status: TaskStatus.downloading
      });
    },

    markComplete(taskId, patch = {}) {
      return ledger.updateTask(taskId, {
        ...patch,
        status: TaskStatus.complete,
        lastError: "",
        failureClass: "",
        healAction: "",
        failureScope: "",
        completedAt: new Date().toISOString()
      });
    },

    markFailure(taskId, error) {
      const task = ledger.getTask(taskId);
      const failure = classifyQueueError(error);
      const exhausted = Number(task?.attempts || 0) >= maxAttempts;
      const status = failure.retryable && !exhausted ? TaskStatus.pending : TaskStatus.failed;
      const patch = {
        status,
        lastError: queueErrorText(error),
        failureClass: failure.class,
        healAction: failure.healAction,
        failureScope: failure.scope
      };
      if (status === TaskStatus.failed) {
        patch.completedAt = new Date().toISOString();
      }
      return ledger.updateTask(taskId, patch);
    },

    markBlocked(taskId, reason) {
      const failure = classifyQueueError(reason);
      return ledger.updateTask(taskId, {
        status: TaskStatus.blocked,
        lastError: queueErrorText(reason),
        failureClass: failure.class === "unknown" ? "blocked" : failure.class,
        healAction: failure.healAction || "user_action_required",
        failureScope: failure.scope || "global",
        completedAt: new Date().toISOString()
      });
    }
  };
}
