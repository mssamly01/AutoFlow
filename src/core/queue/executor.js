import { TaskStatus } from "./task-ledger.js";
import { base64FromDataUrl, getReferenceBlob, mimeTypeFromDataUrl } from "../storage/reference-blob-store.js";

export const FlowTaskMode = Object.freeze({
  textToImage: "text-to-image",
  textToVideo: "text-to-video",
  imageToVideo: "image-to-video",
  startEndImageToVideo: "start-end-image-to-video",
  ingredientsToVideo: "ingredients-to-video"
});

const VIDEO_MODES = new Set([
  FlowTaskMode.textToVideo,
  FlowTaskMode.imageToVideo,
  FlowTaskMode.startEndImageToVideo,
  FlowTaskMode.ingredientsToVideo
]);

export function normalizeFlowMediaStatus(status = "") {
  const raw = String(status || "").trim().toUpperCase();
  if (!raw) return "unknown";
  if (raw.includes("SUCCESSFUL") || raw === "COMPLETE" || raw === "COMPLETED") return "complete";
  if (raw.includes("FAILED") || raw.includes("REJECTED") || raw.includes("CANCELLED")) return "failed";
  if (raw.includes("PENDING") || raw.includes("RUNNING") || raw.includes("PROCESSING")) return "pending";
  return "unknown";
}

function collectFailureText(value, out = [], depth = 0, keyHint = "") {
  if (value == null || depth > 5) return out;
  const keyLooksRelevant = /error|fail|reason|message|status|detail|description|capacity|demand|busy/i.test(String(keyHint || ""));
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value || "").trim();
    if (text && keyLooksRelevant) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectFailureText(entry, out, depth + 1, keyHint));
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    collectFailureText(child, out, depth + 1, key);
  }
  return out;
}

function failureTextForMedia(media = {}, rawStatus = "") {
  const parts = [
    ...collectFailureText(media?.mediaMetadata?.mediaStatus),
    ...collectFailureText(media?.mediaStatus),
    ...collectFailureText(media?.error, [], 0, "error"),
    ...collectFailureText(media?.failure, [], 0, "failure"),
    ...collectFailureText(media?.status, [], 0, "status"),
    String(rawStatus || "").trim()
  ].map((part) => String(part || "").trim()).filter(Boolean);
  return [...new Set(parts)].join(" ");
}

export function extractVideoStatusRows(data) {
  const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
  return mediaRows.map((media) => {
    const video = media?.video || media?.videoData || {};
    const metaVideo = media?.mediaMetadata?.videoData || {};
    const generated = video?.generatedVideo || metaVideo?.generatedVideo || {};
    const rawStatus =
      media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ||
      media?.mediaStatus?.mediaGenerationStatus ||
      "";
    const status = normalizeFlowMediaStatus(rawStatus);
    const failureText = status === "failed" ? failureTextForMedia(media, rawStatus) : "";
    return {
      id: String(media?.name || "").trim(),
      workflowId: String(media?.workflowId || "").trim(),
      rawStatus,
      status,
      ...(failureText ? { failureText } : {}),
      model: String(generated.model || ""),
      aspectRatio: String(generated.aspectRatio || video.aspectRatio || metaVideo.aspectRatio || ""),
      mediaUrl: String(generated.fifeUri || generated.uri || generated.url || video.fifeUri || video.uri || video.url || media?.mediaData?.url || ""),
      thumbnailUrl: String(generated.thumbnailUri || generated.thumbnailUrl || video.thumbnailUri || video.thumbnailUrl || media?.thumbnailUrl || "")
    };
  });
}

function numberFromUnknown(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentFromFractionOrPercent(value) {
  const number = numberFromUnknown(value);
  if (number === null) return null;
  if (number > 0 && number <= 1) return Math.round(number * 100);
  if (number >= 0 && number <= 100) return Math.round(number);
  return null;
}

function extractProgressCandidate(value, depth = 0) {
  if (!value || depth > 6) return null;
  if (typeof value !== "object") {
    return percentFromFractionOrPercent(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => extractProgressCandidate(entry, depth + 1))
      .filter((entry) => Number.isFinite(Number(entry)));
    if (!values.length) return null;
    return Math.round(values.reduce((sum, item) => sum + item, 0) / values.length);
  }
  const keys = [
    "progress", "progressPercent", "percent", "percentage",
    "completionPercent", "mediaGenerationProgress", "generationProgress"
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const percent = percentFromFractionOrPercent(value[key]);
      if (percent !== null) return percent;
    }
  }
  for (const child of Object.values(value)) {
    const percent = extractProgressCandidate(child, depth + 1);
    if (percent !== null) return percent;
  }
  return null;
}

export function extractProgressPercent(data) {
  const percent = extractProgressCandidate(data);
  if (percent === null) return null;
  return Math.min(100, Math.max(0, percent));
}

function resultErrorText(result = {}) {
  const parts = [];
  const collect = (value) => {
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (value instanceof Error) {
      parts.push(value.message || String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === "object") {
      [
        value.error,
        value.code,
        value.reason,
        value.status,
        value.statusText,
        value.message,
        value.details
      ].forEach(collect);
      if (!parts.length) {
        try {
          parts.push(JSON.stringify(value));
        } catch {
          parts.push(String(value));
        }
      }
    }
  };
  [
    result.error,
    result.statusText,
    result.data?.error,
    result.data?.message,
    result.data?.status,
    result.data?.reason
  ].forEach(collect);
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" ");
}

function compactIds(values = []) {
  return [...new Set((values || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

  function observedVideoIdsForTask(task = {}) {
    if (!VIDEO_MODES.has(String(task.mode || ""))) return [];
    return compactIds([
      ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
      ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows.map((row) => row?.id || row?.mediaId) : []),
      ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : [])
    ]);
  }

  function observedSubmitResultForTask(task = {}) {
    if (!VIDEO_MODES.has(String(task.mode || ""))) return null;
    const mediaIds = observedVideoIdsForTask(task);
    if (!mediaIds.length) return null;
    const statusRows = Array.isArray(task.statusRows) ? task.statusRows : [];
    return {
      ok: true,
      status: 202,
      statusText: "DOM_DEBUGGER_OBSERVED_BY_STATUS_FEED",
      mediaIds,
      outputRows: statusRows,
      data: {
        outputRows: statusRows,
        observedByStatusFeed: true
      },
      observedByStatusFeed: true
    };
  }

function isModelAccessDenied(result = {}) {
  return /public_error_model_access_denied|model_access_denied|model access denied/i.test(resultErrorText(result));
}

function isSessionHeatResult(result = {}) {
  if (isModelAccessDenied(result)) return false;
  return /public_error_unusual_activity|recaptcha|permission_denied|403|unusual activity/i.test(resultErrorText(result));
}

const VIDEO_MODEL_ACCESS_FALLBACK = "veo3_lite_low";

function fallbackVideoModelForTask(task = {}) {
  if (task.mode === FlowTaskMode.textToImage) return "";
  const current = String(task.model || "default").trim() || "default";
  if (current === VIDEO_MODEL_ACCESS_FALLBACK) return "";
  return VIDEO_MODEL_ACCESS_FALLBACK;
}

function canFallbackVideoModel(task = {}) {
  return Boolean(fallbackVideoModelForTask(task));
}

export function createQueueExecutor({
  ledger,
  scheduler,
  flowClient,
  domSubmitter = null,
  submitLock = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 5000,
  maxPolls = 96,
  logger = () => {},
  onTaskStateChange = async () => {},
  onTaskProgress = async () => {}
} = {}) {
  if (!ledger) throw new Error("Queue executor requires a task ledger");
  if (!scheduler) throw new Error("Queue executor requires a scheduler");
  if (!flowClient) throw new Error("Queue executor requires a Flow client");

  function submitPathFor(task) {
    const raw = String(task.submitPathPreference || task.submitPath || "api_first").trim();
    if (raw === "dom_first" || raw === "dom_fallback") return raw;
    return "api_first";
  }

  function taskLogFields(task = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];
    const refMediaIds = Array.isArray(task.refMediaIds) ? task.refMediaIds : [];
    const inlineRefCount = refInputs.filter((ref) => Boolean(ref?.imageBytes || ref?.dataUrl || ref?.imageUrl || ref?.mediaUrl)).length;
    return {
      mode: task.mode || "",
      submitPath: submitPathFor(task),
      attempt: Number(task.attempts || 0),
      jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : null,
      jobPromptCount: Number(task.jobPromptCount || 0),
      repeatCount: Number(task.repeatCount || 1) || 1,
      videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
      model: task.model || "",
      aspectRatio: task.aspectRatio || "",
      refCount: Math.max(refMediaIds.length, refInputs.length),
      mediaRefCount: refMediaIds.length,
      inlineRefCount
    };
  }

  function stableSeedFactory(baseSeed = 0) {
    const base = Math.max(1, Math.min(2147483646, Number(baseSeed || 0) || 0));
    if (!base) return undefined;
    let offset = 0;
    return () => {
      const next = ((base + offset) % 2147483646) || 1;
      offset += 1;
      return next;
    };
  }

  function freshBatchId() {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {}
    return `af-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function notifyTaskStateChange(taskId, reason = "") {
    try {
      await onTaskStateChange({
        taskId,
        reason,
        task: ledger.getTask(taskId) || null
      });
    } catch (error) {
      logger({
        type: "task_state_change_error",
        taskId,
        reason,
        error: String(error?.message || error || "task_state_change_failed")
      });
    }
  }

  async function submitViaApiRequest(task) {
    const inputMediaIds = Array.isArray(task.refMediaIds) && task.refMediaIds.length
      ? task.refMediaIds
      : Array.isArray(task.mediaIds)
        ? task.mediaIds
        : [];
    const common = {
      prompt: task.prompt,
      projectId: task.projectId,
      repeatCount: task.repeatCount || 1,
      model: task.model || "default",
      aspectRatio: task.aspectRatio || "landscape",
      videoLength: task.videoLength || task.videoDurationSeconds || "8",
      returnSilentVideos: task.returnSilentVideos !== false,
      batchId: task.batchId,
      forceFreshRecaptcha: task.forceFreshRecaptcha === true
    };

    if (task.mode === FlowTaskMode.textToImage) {
      return flowClient.submitTextToImage({
        ...common,
        model: task.model || "nano_banana_pro",
        mediaIds: inputMediaIds,
        refInputs: Array.isArray(task.refInputs) ? task.refInputs : [],
        characterName: task.characterName || "",
        characters: Array.isArray(task.characters) ? task.characters : [],
        characterConsistencyPrompt: task.characterConsistencyPrompt || "",
        seedFactory: stableSeedFactory(task.characterSeed)
      });
    }

    if (task.mode === FlowTaskMode.textToVideo) {
      return flowClient.submitTextToVideo(common);
    }

    if (task.mode === FlowTaskMode.imageToVideo) {
      return flowClient.submitVideoStartImage({
        ...common,
        startMediaId: task.startMediaId
      });
    }

    if (task.mode === FlowTaskMode.startEndImageToVideo) {
      return flowClient.submitVideoStartAndEndImage({
        ...common,
        startMediaId: task.startMediaId,
        endMediaId: task.endMediaId
      });
    }

    if (task.mode === FlowTaskMode.ingredientsToVideo) {
      return flowClient.submitVideoReferenceImages({
        ...common,
        mediaIds: inputMediaIds
      });
    }

    throw new Error(`Unsupported task mode: ${task.mode}`);
  }

  async function submitViaApi(task) {
    logger({
      type: "submit_path_start",
      taskId: task.id,
      path: "api",
      ...taskLogFields(task)
    });
    try {
      const result = await submitViaApiRequest(task);
      logger({
        type: "submit_path_result",
        taskId: task.id,
        path: "api",
        transport: "extension_api_submit",
        ok: result.ok === true,
        status: result.status || 0,
        statusText: result.statusText || "",
        mediaIdCount: Array.isArray(result.mediaIds) ? result.mediaIds.length : 0,
        endpoint: result.endpoint || "",
        error: result.data?.error || result.statusText || "",
        ...taskLogFields(task)
      });
      return result;
    } catch (error) {
      logger({
        type: "submit_path_error",
        taskId: task.id,
        path: "api",
        transport: "extension_api_submit",
        error: String(error?.message || error || "api_submit_failed"),
        ...taskLogFields(task)
      });
      throw error;
    }
  }

  function normalizeSubmitTaskRefs(task = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];

    return {
      ...task,
      refInputs: refInputs.map((ref) => {
        const fileName = String(
          ref.fileName ||
          ref.name ||
          ref.filename ||
          ref.originalName ||
          ""
        ).trim();

        return {
          ...ref,
          fileName,
          name: fileName || ref.name,
          characterName: ref.characterName || task.characterName || "",
          role: ref.role || "character_reference"
        };
      })
    };
  }

  async function submitViaDom(task, meta = {}) {
    if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
      throw new Error("DOM_SUBMIT_ADAPTER_UNAVAILABLE");
    }
    
    const taskForDom = normalizeSubmitTaskRefs(task);
    
    logger({
      type: "submit_path_start",
      taskId: taskForDom.id,
      path: "dom",
      repairFromApi: Boolean(meta.apiResult),
      ...taskLogFields(taskForDom)
    });
    try {
      const domSubmitPromise = domSubmitter.submitTask(taskForDom, {
        submitPath: submitPathFor(taskForDom),
        ...meta
      });

      const allowStatusFeedSubmitObservation = meta.allowStatusFeedSubmitObservation === true && meta.allowStatusFeedEarlyResolve === true;
      let cancelStatusFeedObservation = false;
      const observedPromise = allowStatusFeedSubmitObservation && VIDEO_MODES.has(String(task.mode || ""))
        ? (async () => {
            const deadline = Date.now() + Math.max(10000, Number(meta.statusFeedSubmitTimeoutMs || 90000));
            while (!cancelStatusFeedObservation && Date.now() < deadline) {
              await wait(500);
              if (cancelStatusFeedObservation) return null;
              const observedTask = ledger.getTask(task.id);
              const observed = observedSubmitResultForTask(observedTask);
              if (observed) return observed;
            }
            return null;
          })()
        : Promise.resolve(null);
      const first = allowStatusFeedSubmitObservation
        ? await Promise.race([
            domSubmitPromise.then((result) => ({ type: "dom", result })),
            observedPromise.then((result) => result ? { type: "observed", result } : { type: "observed_timeout", result: null })
          ])
        : { type: "dom", result: await domSubmitPromise };
      let result;
      if (first?.type === "observed" && first.result) {
        result = first.result;
        cancelStatusFeedObservation = true;
        domSubmitPromise
          .then((lateResult) => {
            logger({
              type: "submit_path_late_dom_result",
              taskId: task.id,
              path: "dom",
              ok: lateResult?.ok === true,
              status: lateResult?.status || 0,
              statusText: lateResult?.statusText || "",
              ignoredBecause: "status_feed_observed_submit",
              mediaIdCount: Array.isArray(lateResult?.mediaIds) ? lateResult.mediaIds.length : 0,
              ...taskLogFields(task)
            });
          })
          .catch((error) => {
            logger({
              type: "submit_path_late_dom_error",
              taskId: task.id,
              path: "dom",
              ignoredBecause: "status_feed_observed_submit",
              error: String(error?.message || error || "late_dom_submit_failed"),
              ...taskLogFields(task)
            });
          });
      } else {
        result = first?.type === "dom"
          ? first.result
          : await domSubmitPromise;
        cancelStatusFeedObservation = true;
      }
      logger({
        type: "submit_path_result",
        taskId: task.id,
        path: "dom",
        ok: result.ok === true,
        status: result.status || 0,
        statusText: result.statusText || "",
        mediaIdCount: Array.isArray(result.mediaIds) ? result.mediaIds.length : 0,
        error: result.data?.error || result.statusText || "",
        transport: result.data?.transport || result.transport || "dom_page_command",
        observedByStatusFeed: result.observedByStatusFeed === true,
        repairedFromApi: Boolean(meta.apiResult),
        attachOutcome: result.data?.attachOutcome || result.attachOutcome || null,
        ...taskLogFields(task)
      });
      return result;
    } catch (error) {
      logger({
        type: "submit_path_error",
        taskId: task.id,
        path: "dom",
        error: String(error?.message || error || "dom_submit_failed"),
        repairFromApi: Boolean(meta.apiResult),
        ...taskLogFields(task)
      });
      throw error;
    }
  }

  function domResultAllowsApiRepair(result = {}) {
    const error = String(result?.error || result?.data?.error || result?.statusText || "").trim();
    if (/^DOM_FRAME/i.test(error) || error === "STORE_DIRECT_FRAME_ATTACH_FAILED") return false;
    if (result?.data?.transport === "chrome_debugger" || /^DOM_DEBUGGER_/i.test(error) || /^dom_debugger_/i.test(error)) return false;
    if (/^DOM_/.test(error)) return true;
    if (/^dom_/i.test(error)) return true;
    if (error === "PROMPT_STORE_NOT_FOUND") return true;
    if (/^page_command_timeout$/i.test(error)) return true;
    return [
      "DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED",
      "DOM_CREATE_CLICK_FAILED",
      "DOM_SUBMIT_WRONG_ENDPOINT_FOR_MODE",
      "ASSET_BROWSER_NOT_OPEN",
      "ASSET_ROW_NOT_FOUND",
      "REF_ATTACH_NOT_PERSISTED",
      "REF_NOT_SERIALIZED"
    ].includes(error);
  }

  function domTaskAllowsApiRepair(task = {}, result = {}) {
    return task?.allowDomApiRepair === true && domResultAllowsApiRepair(result);
  }

  function mediaIdFromRef(ref = {}) {
    const raw = String(ref?.mediaId || ref?.assetImageId || "").trim();
    if (!raw || isLocalReferenceMediaId(raw, ref)) return "";
    const match = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : raw;
  }

  function trustedMediaId(value = "") {
    return String(value || "").trim();
  }

  function isLocalReferenceMediaId(value = "", ref = {}) {
    const mediaId = trustedMediaId(value);
    if (!mediaId || !ref || typeof ref !== "object") return false;
    const localIds = [
      ref.blobStoreId,
      ref.id
    ].map(trustedMediaId).filter(Boolean);
    return localIds.includes(mediaId);
  }

  function localReferenceIdsForTask(task = {}) {
    const refs = [
      task.startRefInput,
      task.endRefInput,
      ...(Array.isArray(task.refInputs) ? task.refInputs : [])
    ].filter((ref) => ref && typeof ref === "object");
    return new Set(refs.flatMap((ref) => [ref.blobStoreId, ref.id].map(trustedMediaId).filter(Boolean)));
  }

  function trustedTaskMediaId(value = "", task = {}) {
    const mediaId = trustedMediaId(value);
    if (!mediaId) return "";
    return localReferenceIdsForTask(task).has(mediaId) ? "" : mediaId;
  }

  function trustedTaskMediaIds(values = [], task = {}) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => trustedTaskMediaId(value, task))
      .filter(Boolean))];
  }

  function inlineImageBytesFromRef(ref = {}) {
    const direct = String(ref?.imageBytes || "").replace(/\s+/g, "");
    if (direct) return direct;
    const dataUrl = String(ref?.dataUrl || ref?.imageUrl || ref?.mediaUrl || "").trim();
    if (!/^data:/i.test(dataUrl)) return "";
    return base64FromDataUrl(dataUrl).replace(/\s+/g, "");
  }

  async function imageBytesFromRef(ref = {}) {
    const inline = inlineImageBytesFromRef(ref);
    if (inline) return inline;
    const blobStoreId = String(ref?.blobStoreId || "").trim();
    if (!blobStoreId) return "";
    const stored = await getReferenceBlob(blobStoreId).catch(() => null);
    return base64FromDataUrl(stored?.dataUrl || "").replace(/\s+/g, "");
  }

  async function mimeTypeFromRef(ref = {}) {
    const explicit = String(ref?.mimeType || "").trim().toLowerCase();
    if (explicit) return explicit;
    const dataUrl = String(ref?.dataUrl || ref?.imageUrl || ref?.mediaUrl || "").trim();
    const inlineMime = mimeTypeFromDataUrl(dataUrl);
    if (inlineMime) return inlineMime;
    const blobStoreId = String(ref?.blobStoreId || "").trim();
    if (blobStoreId) {
      const stored = await getReferenceBlob(blobStoreId).catch(() => null);
      return String(stored?.mimeType || mimeTypeFromDataUrl(stored?.dataUrl || "") || "image/png").toLowerCase();
    }
    return "image/png";
  }

  function fileNameFromRef(ref = {}, index = 0) {
    const raw = String(ref?.fileName || ref?.title || ref?.name || "").trim();
    return raw || `reference-${index + 1}.png`;
  }

  async function refNeedsUpload(ref = {}) {
    return !mediaIdFromRef(ref) && Boolean(await imageBytesFromRef(ref));
  }

  async function uploadInlineTaskRefs(task = {}, { isHidden = false, reason = "reference_prepare" } = {}) {
    const refs = Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [];
    const missingRefs = [];
    for (const [index, ref] of refs.entries()) {
      if (await refNeedsUpload(ref)) missingRefs.push({ ref, index });
    }
    if (!missingRefs.length) return task;
    if (typeof flowClient.uploadImage !== "function") {
      throw new Error("REFERENCE_UPLOAD_UNAVAILABLE");
    }

    const uploadedIds = [];
    for (const { ref, index } of missingRefs) {
      logger({
        type: "reference_upload_start",
        taskId: task.id,
        mode: task.mode || "",
        role: ref.role || "",
        fileName: fileNameFromRef(ref, index),
        reason
      });
      const result = await flowClient.uploadImage({
        projectId: task.projectId,
        imageBytes: await imageBytesFromRef(ref),
        mimeType: await mimeTypeFromRef(ref),
        fileName: fileNameFromRef(ref, index),
        isHidden
      });
      const mediaId = trustedMediaId(result?.mediaIds?.[0]);
      if (!result?.ok || !mediaId) {
        logger({
          type: "reference_upload_failed",
          taskId: task.id,
          mode: task.mode || "",
          role: ref.role || "",
          fileName: fileNameFromRef(ref, index),
          reason,
          status: result?.status || 0,
          statusText: result?.statusText || "",
          error: result?.data?.error || result?.error || "REFERENCE_UPLOAD_MISSING_MEDIA_ID"
        });
        throw (result?.data?.error || result?.error || new Error(result?.statusText || "REFERENCE_UPLOAD_MISSING_MEDIA_ID"));
      }
      refs[index] = mergeRefMediaId(ref, mediaId);
      uploadedIds.push(mediaId);
      logger({
        type: "reference_upload_ok",
        taskId: task.id,
        mode: task.mode || "",
        role: ref.role || "",
        mediaId,
        reason
      });
    }

    const refMediaIds = [...new Set([
      ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
      ...refs.map(mediaIdFromRef).filter(Boolean),
      ...uploadedIds
    ].map((id) => trustedTaskMediaId(id, { ...task, refInputs: refs })).filter(Boolean))];
    const patch = { refInputs: refs, refMediaIds };
    if ((task.mode === FlowTaskMode.imageToVideo || task.mode === FlowTaskMode.startEndImageToVideo) && !trustedTaskMediaId(task.startMediaId, task)) {
      const start = refs.find((ref) => String(ref.role || "") === "startFrameRef") || refs[0];
      const startMediaId = mediaIdFromRef(start);
      if (startMediaId) {
        patch.startMediaId = startMediaId;
        patch.startRefInput = mergeRefMediaId(task.startRefInput || start || {}, startMediaId);
      }
    }
    if (task.mode === FlowTaskMode.startEndImageToVideo && !trustedTaskMediaId(task.endMediaId, task)) {
      const end = refs.find((ref) => String(ref.role || "") === "endFrameRef");
      const endMediaId = mediaIdFromRef(end);
      if (endMediaId) {
        patch.endMediaId = endMediaId;
        patch.endRefInput = mergeRefMediaId(task.endRefInput || end || {}, endMediaId);
      }
    }
    const updated = ledger.updateTask(task.id, patch);
    await notifyTaskStateChange(task.id, reason);
    return updated || { ...task, ...patch };
  }

  async function prepareReferenceMediaForSubmit(task = {}) {
    if (![FlowTaskMode.textToImage, FlowTaskMode.ingredientsToVideo, FlowTaskMode.imageToVideo, FlowTaskMode.startEndImageToVideo].includes(task.mode)) {
      return task;
    }
    const submitPath = submitPathFor(task);
    if (submitPath === "dom_first") {
      return task;
    }
    if (submitPath === "api_first" || submitPath === "dom_fallback") {
      return uploadInlineTaskRefs(task, { isHidden: true, reason: "api_reference_prepare" });
    }
    return task;
  }

  function mergeRefMediaId(ref = {}, mediaId = "") {
    return {
      ...ref,
      mediaId: trustedMediaId(mediaId)
    };
  }

  function uploadedMediaIdsFromDomResult(result = {}) {
    const attachOutcome = result?.attachOutcome || result?.data?.attachOutcome || {};
    const steps = Array.isArray(attachOutcome?.steps) ? attachOutcome.steps : [];
    const ordered = [
      ...(Array.isArray(attachOutcome?.serializedIds) ? attachOutcome.serializedIds : []),
      ...(Array.isArray(attachOutcome?.attachedImageIds) ? attachOutcome.attachedImageIds : []),
      ...steps.flatMap((step) => [
        step?.confirmedImageId,
        step?.targetImageId,
        step?.rowImageId,
        step?.uploadedMediaId
      ])
    ];
    return [...new Set(ordered
      .map((mediaId) => mediaIdFromRef({ mediaId }))
      .filter(Boolean))];
  }

  function taskWithDomRepairMedia(task = {}, domResult = {}) {
    const uploadedIds = uploadedMediaIdsFromDomResult(domResult);
    const refIds = (Array.isArray(task.refInputs) ? task.refInputs : []).map(mediaIdFromRef).filter(Boolean);
    if (task.mode === FlowTaskMode.imageToVideo) {
      const startMediaId = uploadedIds[0] || refIds[0] || trustedTaskMediaId(task.startMediaId, task) || "";
      return {
        ...task,
        startMediaId,
        endMediaId: ""
      };
    }
    if (task.mode === FlowTaskMode.startEndImageToVideo) {
      const startMediaId = uploadedIds[0] || refIds[0] || trustedTaskMediaId(task.startMediaId, task) || "";
      const endMediaId = uploadedIds[1] || refIds[1] || trustedTaskMediaId(task.endMediaId, task) || "";
      return {
        ...task,
        startMediaId,
        endMediaId
      };
    }
    if (task.mode === FlowTaskMode.ingredientsToVideo) {
      const mediaIds = [...new Set([
        ...uploadedIds,
        ...refIds,
        ...trustedTaskMediaIds(task.mediaIds, task)
      ].filter(Boolean))];
      return mediaIds.length ? { ...task, mediaIds } : task;
    }
    return task;
  }

  async function firstInlineRef(task = {}, roles = []) {
    const refs = [
      task.startRefInput,
      task.endRefInput,
      ...(Array.isArray(task.refInputs) ? task.refInputs : [])
    ].filter((ref) => ref && typeof ref === "object");
    const wanted = new Set(roles.map((role) => String(role || "").trim()).filter(Boolean));
    for (const ref of refs) {
      if (wanted.size && !wanted.has(String(ref.role || "").trim())) continue;
      if (!mediaIdFromRef(ref) && await imageBytesFromRef(ref)) return ref;
    }
    return null;
  }

  async function uploadInlineRefForApiRepair(task, ref, index = 0) {
    if (!ref) return "";
    if (typeof flowClient.uploadImage !== "function") {
      throw new Error("API_REPAIR_UPLOAD_UNAVAILABLE");
    }
    const imageBytes = await imageBytesFromRef(ref);
    if (!imageBytes) return "";
    logger({
      type: "api_repair_media_upload_start",
      taskId: task.id,
      mode: task.mode || "",
      role: ref.role || "",
      fileName: fileNameFromRef(ref, index),
      hasDataUrl: Boolean(ref.dataUrl || ref.imageUrl || ref.mediaUrl)
    });
    const result = await flowClient.uploadImage({
      projectId: task.projectId,
      imageBytes,
      mimeType: await mimeTypeFromRef(ref),
      fileName: fileNameFromRef(ref, index),
      isHidden: true
    });
    const mediaId = trustedMediaId(result?.mediaIds?.[0]);
    if (!result?.ok || !mediaId) {
      throw new Error(result?.statusText || result?.data?.error || "API_REPAIR_UPLOAD_MISSING_MEDIA_ID");
    }
    logger({
      type: "api_repair_media_upload_ok",
      taskId: task.id,
      mode: task.mode || "",
      role: ref.role || "",
      mediaId
    });
    return mediaId;
  }

  function patchRefsWithUploadedIds(task = {}, mediaIdsByRole = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [];
    const patch = {};
    const patchRefListRole = (role, mediaId) => {
      if (!mediaId) return;
      const index = refInputs.findIndex((ref) => String(ref.role || "").trim() === role);
      if (index >= 0) refInputs[index] = mergeRefMediaId(refInputs[index], mediaId);
    };
    if (mediaIdsByRole.startFrameRef) {
      patch.startRefInput = mergeRefMediaId(task.startRefInput || {}, mediaIdsByRole.startFrameRef);
      patchRefListRole("startFrameRef", mediaIdsByRole.startFrameRef);
    }
    if (mediaIdsByRole.endFrameRef) {
      patch.endRefInput = mergeRefMediaId(task.endRefInput || {}, mediaIdsByRole.endFrameRef);
      patchRefListRole("endFrameRef", mediaIdsByRole.endFrameRef);
    }
    if (Array.isArray(mediaIdsByRole.ingredientsRefs) && mediaIdsByRole.ingredientsRefs.length) {
      let cursor = 0;
      for (let index = 0; index < refInputs.length; index += 1) {
        refInputs[index] = mergeRefMediaId(refInputs[index], mediaIdsByRole.ingredientsRefs[cursor] || "");
        cursor += 1;
        if (cursor >= mediaIdsByRole.ingredientsRefs.length) break;
      }
    }
    if (refInputs.length) patch.refInputs = refInputs;
    const refMediaIds = [...new Set([
      ...refInputs.map(mediaIdFromRef),
      mediaIdsByRole.startFrameRef,
      mediaIdsByRole.endFrameRef,
      ...(Array.isArray(mediaIdsByRole.ingredientsRefs) ? mediaIdsByRole.ingredientsRefs : [])
    ].map(trustedMediaId).filter(Boolean))];
    patch.refMediaIds = refMediaIds;
    return patch;
  }

  async function prepareApiRepairMedia(task = {}, domResult = {}) {
    let repaired = taskWithDomRepairMedia(task, domResult);
    const patch = {};
    const uploadedByRole = {};

    const repairedStartMediaId = trustedTaskMediaId(repaired.startMediaId, repaired);
    const repairedEndMediaId = trustedTaskMediaId(repaired.endMediaId, repaired);
    if ((repaired.mode === FlowTaskMode.imageToVideo || repaired.mode === FlowTaskMode.startEndImageToVideo) && repairedStartMediaId && repairedStartMediaId !== task.startMediaId) {
      patch.startMediaId = repairedStartMediaId;
      uploadedByRole.startFrameRef = repairedStartMediaId;
    }
    if (repaired.mode === FlowTaskMode.imageToVideo && trustedTaskMediaId(task.endMediaId, task)) {
      patch.endMediaId = "";
    }
    if ((repaired.mode === FlowTaskMode.startEndImageToVideo) && repairedEndMediaId && repairedEndMediaId !== task.endMediaId) {
      patch.endMediaId = repairedEndMediaId;
      uploadedByRole.endFrameRef = repairedEndMediaId;
    }
    if (repaired.mode === FlowTaskMode.ingredientsToVideo && Array.isArray(repaired.mediaIds) && repaired.mediaIds.length) {
      const prior = new Set(trustedTaskMediaIds(task.mediaIds, task));
      const nextIds = trustedTaskMediaIds(repaired.mediaIds, repaired);
      if (nextIds.some((id) => !prior.has(id))) {
        patch.mediaIds = nextIds;
        uploadedByRole.ingredientsRefs = nextIds.filter((id) => !prior.has(id));
      }
    }

    if ((repaired.mode === FlowTaskMode.imageToVideo || repaired.mode === FlowTaskMode.startEndImageToVideo) && !trustedTaskMediaId(repaired.startMediaId, repaired)) {
      const ref = await firstInlineRef(repaired, ["startFrameRef"]) || await firstInlineRef(repaired);
      const mediaId = await uploadInlineRefForApiRepair(repaired, ref, 0);
      if (mediaId) {
        uploadedByRole.startFrameRef = mediaId;
        patch.startMediaId = mediaId;
        repaired = { ...repaired, startMediaId: mediaId };
      }
    }

    if (repaired.mode === FlowTaskMode.startEndImageToVideo && !trustedTaskMediaId(repaired.endMediaId, repaired)) {
      const ref = await firstInlineRef({ ...repaired, startRefInput: null }, ["endFrameRef"]) || await firstInlineRef({ ...repaired, startRefInput: null });
      const mediaId = await uploadInlineRefForApiRepair(repaired, ref, 1);
      if (mediaId) {
        uploadedByRole.endFrameRef = mediaId;
        patch.endMediaId = mediaId;
        repaired = { ...repaired, endMediaId: mediaId };
      }
    }

    if (repaired.mode === FlowTaskMode.ingredientsToVideo) {
      const existing = [
        ...trustedTaskMediaIds(repaired.mediaIds, repaired),
        ...(Array.isArray(repaired.refInputs) ? repaired.refInputs.map(mediaIdFromRef).filter(Boolean) : [])
      ].filter(Boolean);
      if (!existing.length) {
        const refs = [];
        for (const ref of Array.isArray(repaired.refInputs) ? repaired.refInputs : []) {
          if (!mediaIdFromRef(ref) && await imageBytesFromRef(ref)) refs.push(ref);
        }
        const mediaIds = [];
        for (let index = 0; index < refs.length; index += 1) {
          mediaIds.push(await uploadInlineRefForApiRepair(repaired, refs[index], index));
        }
        const compactMediaIds = mediaIds.filter(Boolean);
        if (compactMediaIds.length) {
          uploadedByRole.ingredientsRefs = compactMediaIds;
        }
      }
    }

    Object.assign(patch, patchRefsWithUploadedIds(repaired, uploadedByRole));
    if (Object.keys(patch).length) {
      Object.assign(patch, {
        submitPathPreference: "api_first",
        domRepairMediaPreparedAt: new Date().toISOString()
      });
      repaired = { ...repaired, ...patch };
      ledger.updateTask(task.id, patch);
    }
    return repaired;
  }

  async function runDomSubmitExclusive(fn) {
    if (submitLock && typeof submitLock.runExclusive === "function") {
      return submitLock.runExclusive(fn);
    }
    return fn();
  }

  async function submitViaDomExclusive(task, meta = {}) {
    return runDomSubmitExclusive(() => submitViaDom(task, meta));
  }

  async function submit(task) {
    task = await prepareReferenceMediaForSubmit(task);
    const submitPath = submitPathFor(task);
    const domVideoObservationMeta = {};
    if (submitPath === "dom_first") {
      let domResult;
      try {
        domResult = await submitViaDomExclusive(task, domVideoObservationMeta);
      } catch (error) {
        domResult = {
          ok: false,
          status: 0,
          error: String(error?.message || error || "DOM_SUBMIT_FAILED"),
          statusText: String(error?.message || error || "DOM_SUBMIT_FAILED"),
          data: { error: String(error?.message || error || "DOM_SUBMIT_FAILED") }
        };
      }
      if (domResult.ok || !domTaskAllowsApiRepair(task, domResult)) {
        return domResult;
      }
      logger({
        type: "dom_api_repair",
        taskId: task.id,
        mode: task.mode,
        reason: domResult.error || domResult.data?.error || "DOM_SUBMIT_FAILED"
      });
      const apiResult = await submitViaApi(await prepareApiRepairMedia(task, domResult));
      return {
        ...apiResult,
        repairedFromDom: true,
        domError: domResult.error || domResult.data?.error || ""
      };
    }

    let apiResult = await submitViaApi(task);
    if (!apiResult.ok && isSessionHeatResult(apiResult)) {
      logger({
        type: "api_session_heat_retry",
        taskId: task.id,
        status: apiResult.status || 0,
        statusText: apiResult.statusText || "",
        error: resultErrorText(apiResult),
        ...taskLogFields(task)
      });
      await wait(1800);
      apiResult = await submitViaApi({
        ...task,
        batchId: freshBatchId(),
        forceFreshRecaptcha: true
      });
    }
    if (apiResult.ok || submitPath !== "dom_fallback") {
      if (!apiResult.ok && submitPath === "api_first" && isSessionHeatResult(apiResult) && domSubmitter && typeof domSubmitter.submitTask === "function") {
        logger({
          type: "api_session_heat_dom_fallback",
          taskId: task.id,
          status: apiResult.status || 0,
          statusText: apiResult.statusText || "",
          error: resultErrorText(apiResult),
          ...taskLogFields(task)
        });
        return submitViaDomExclusive(task, { ...domVideoObservationMeta, apiResult, apiSessionHeatFallback: true });
      }
      return apiResult;
    }
    if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
      return apiResult;
    }
    logger({
      type: "dom_fallback",
      taskId: task.id,
      status: apiResult.status || 0,
      statusText: apiResult.statusText || ""
    });
    return submitViaDomExclusive(task, { ...domVideoObservationMeta, apiResult });
  }

  async function pollVideoUntilTerminal(taskId, mediaIds, projectId) {
    let emptyRows = 0;
    const currentTask = ledger.getTask(taskId) || {};
    const durationSeconds = Number(currentTask.videoLength || currentTask.videoDurationSeconds || 0);
    const taskMaxPolls = Math.min(maxPolls, durationSeconds <= 4 ? 48 : durationSeconds <= 6 ? 60 : 72);
    for (let poll = 0; poll < taskMaxPolls; poll += 1) {
      await wait(pollIntervalMs);
      const beforePollTask = ledger.getTask(taskId) || {};
      if (beforePollTask.status === TaskStatus.complete || beforePollTask.status === TaskStatus.failed || beforePollTask.status === TaskStatus.blocked) {
        return beforePollTask;
      }
      const statusResult = await flowClient.pollVideoStatus({ projectId, mediaIds });
      const rows = extractVideoStatusRows(statusResult.data);

      // Extract progress from poll response for overlap gating.
      const rowProgressValues = rows
        .map((row) => Number(row?.progressPercent))
        .filter((value) => Number.isFinite(value));
      const progressPercent = rowProgressValues.length
        ? Math.round(rowProgressValues.reduce((sum, value) => sum + value, 0) / rowProgressValues.length)
        : extractProgressPercent(statusResult.data);

      logger({ type: "poll", taskId, poll, maxPolls: taskMaxPolls, rows, progressPercent });

      if (Number.isFinite(Number(progressPercent))) {
        try {
          await onTaskProgress({ taskId, percent: Number(progressPercent), source: "api" });
        } catch {}
      }

      const beforeUpdateTask = ledger.getTask(taskId) || {};
      if (beforeUpdateTask.status === TaskStatus.complete || beforeUpdateTask.status === TaskStatus.failed || beforeUpdateTask.status === TaskStatus.blocked) {
        return beforeUpdateTask;
      }

      const progressPatch = Number.isFinite(Number(progressPercent))
        ? {
            progressPercent: Number(progressPercent),
            progressUpdatedAt: new Date().toISOString(),
            lastProgressSource: "api"
          }
        : {};
      ledger.updateTask(taskId, {
        statusRows: rows,
        lastPollAt: new Date().toISOString(),
        ...progressPatch
      });
      await notifyTaskStateChange(taskId, "video_poll");
      const afterNotifyTask = ledger.getTask(taskId) || {};
      if (afterNotifyTask.status === TaskStatus.complete || afterNotifyTask.status === TaskStatus.failed || afterNotifyTask.status === TaskStatus.blocked) {
        return afterNotifyTask;
      }

      if (!rows.length) {
        emptyRows += 1;
        const current = ledger.getTask(taskId) || {};
        const domTextToVideo = String(current.mode || "") === FlowTaskMode.textToVideo
          && String(current.submitPath || current.submitPathPreference || "") === "dom_first";
        if (domTextToVideo && current.allowDomApiRepair === true && emptyRows >= 6 && current.domStatusRepairAttempted !== true) {
          logger({
            type: "dom_empty_status_api_repair",
            taskId,
            mediaIds,
            emptyRows
          });
          ledger.updateTask(taskId, {
            domStatusRepairAttempted: true,
            submitPathPreference: "api_first",
            lastError: "",
            failureClass: "",
            healAction: "",
            failureScope: ""
          });
          const repaired = await submitViaApi({ ...current, submitPathPreference: "api_first" });
          logger({ type: "submitted", taskId, result: repaired, domStatusRepair: true });
          if (!repaired.ok || !Array.isArray(repaired.mediaIds) || !repaired.mediaIds.length) {
            const failedTask = scheduler.markFailure(taskId, repaired.data?.error || repaired.statusText || repaired.error || "DOM_EMPTY_STATUS_API_REPAIR_FAILED");
            await notifyTaskStateChange(taskId, "dom_empty_status_api_repair_failed");
            return failedTask;
          }
          scheduler.markSubmitted(taskId, repaired.mediaIds);
          await notifyTaskStateChange(taskId, "dom_empty_status_api_repaired");
          return pollVideoUntilTerminal(taskId, repaired.mediaIds, projectId);
        }
        continue;
      }
      emptyRows = 0;
      const terminalRows = rows.filter((row) => row.status === "complete" || row.status === "failed");
      const completeRows = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter((entry) => entry.row.status === "complete");
      const failedRows = rows.filter((row) => row.status === "failed");
      const taskSnapshot = ledger.getTask(taskId) || {};
      const expectedRows = Math.max(1, Number(taskSnapshot.repeatCount || taskSnapshot.expectedVideos || mediaIds.length || 1) || 1);
      const capturedMediaIds = [...new Set((Array.isArray(mediaIds) ? mediaIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))];
      const capturedIdSet = new Set(capturedMediaIds);
      const capturedCompleteRows = capturedIdSet.size
        ? completeRows.filter((entry) => capturedIdSet.has(String(entry.row.id || "").trim()))
        : [];
      const allCapturedRowsTerminal = capturedIdSet.size > 0
        && rows.length >= capturedIdSet.size
        && rows
          .filter((row) => capturedIdSet.has(String(row.id || "").trim()))
          .every((row) => row.status === "complete" || row.status === "failed");
      if (terminalRows.length >= expectedRows) {
        if (!completeRows.length) {
          const failed = failedRows[0];
          const task = scheduler.markFailure(taskId, failed?.rawStatus || "MEDIA_GENERATION_FAILED");
          await notifyTaskStateChange(taskId, "video_failed");
          return task;
        }
        const outputs = completeRows.map(({ row, rowIndex }) => ({
          id: `${taskId}:${row.id || rowIndex}`,
          mediaId: row.id,
          mediaUrl: row.mediaUrl || "",
          thumbnailUrl: row.thumbnailUrl || "",
          prompt: taskSnapshot.prompt || "",
          kind: "videos",
          status: row.status,
          rawStatus: row.rawStatus,
          mediaIndex: rowIndex
        })).filter((output) => output.mediaId);
        const task = scheduler.markComplete(taskId, {
          statusRows: rows,
          outputs,
          outputMediaIds: outputs.map((output) => output.mediaId),
          foundVideos: outputs.length,
          expectedVideos: expectedRows,
          failedOutputCount: failedRows.length,
          failedOutputMediaIds: failedRows.map((row) => row.id).filter(Boolean),
          partialFailure: failedRows.length > 0
        });
        await notifyTaskStateChange(taskId, failedRows.length > 0 ? "video_partial_complete" : "video_complete");
        return task;
      }
      if (
        capturedMediaIds.length > 0 &&
        capturedMediaIds.length < expectedRows &&
        capturedCompleteRows.length > 0 &&
        allCapturedRowsTerminal
      ) {
        logger({
          type: "video_partial_captured_continue_wait",
          taskId,
          poll,
          captured: capturedMediaIds.length,
          expected: expectedRows,
          completeCaptured: capturedCompleteRows.length
        });
      }
    }
    const task = scheduler.markFailure(taskId, "VIDEO_STATUS_POLL_TIMEOUT");
    logger({ type: "poll_timeout", taskId, maxPolls: taskMaxPolls, pollIntervalMs, mediaIds });
    await notifyTaskStateChange(taskId, "video_timeout");
    return task;
  }

  return {
    async runNext() {
      const task = scheduler.nextPendingTask();
      if (!task) return null;
      return this.runTask(task.id);
    },

    async submitTaskOnly(taskId, options = {}) {
      const task = ledger.getTask(taskId);
      if (!task) throw new Error(`Unknown task id: ${taskId}`);
      if (task.status !== TaskStatus.pending) return task;

      scheduler.markSubmitting(taskId);
      await notifyTaskStateChange(taskId, "submitting");
      const submittingTask = ledger.getTask(taskId) || task;
      logger({
        type: "task_start",
        taskId,
        ...taskLogFields(submittingTask)
      });
      try {
        const result = await submit(task);
        logger({ type: "submitted", taskId, result });
        if (!result.ok && isModelAccessDenied(result) && canFallbackVideoModel(task)) {
          const preparedTask = ledger.getTask(taskId) || submittingTask || task;
          const fallbackModel = fallbackVideoModelForTask(preparedTask);
          const fallbackTask = { ...preparedTask, model: fallbackModel };
          logger({
            type: "model_fallback",
            taskId,
            fromModel: task.model || "",
            toModel: fallbackModel,
            reason: resultErrorText(result)
          });
          ledger.updateTask(taskId, {
            model: fallbackModel,
            modelFallbackFrom: task.model || "",
            lastError: "",
            failureClass: "",
            healAction: "",
            failureScope: ""
          });
          Object.assign(result, result.repairedFromDom
            ? {
                ...(await submitViaApi(fallbackTask)),
                repairedFromDom: true,
                domError: result.domError || ""
              }
            : await submit(fallbackTask));
          logger({ type: "submitted", taskId, result, modelFallback: true });
        }
        if (!result.ok) {
          const partialVideoMediaIds = VIDEO_MODES.has(task.mode) ? compactIds(result.mediaIds || []) : [];
          const expectedVideoCount = Math.max(1, Number(task.repeatCount || task.expectedVideos || partialVideoMediaIds.length || 1) || 1);
          const partialVideoSubmitError = resultErrorText(result);
          const canAdoptPartialVideoSubmit = partialVideoMediaIds.length > 0
            && partialVideoMediaIds.length < expectedVideoCount
            && expectedVideoCount > 1
            && /DOM_DEBUGGER_FRONTEND_NOT_UPDATED|DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS/i.test(partialVideoSubmitError);
          if (canAdoptPartialVideoSubmit) {
            logger({
              type: "partial_video_submit_adopted_for_repair",
              taskId,
              reason: partialVideoSubmitError,
              mediaIds: partialVideoMediaIds,
              foundVideos: partialVideoMediaIds.length,
              expectedVideos: expectedVideoCount
            });
            scheduler.markSubmitted(taskId, partialVideoMediaIds, {
              submitOutputRows: Array.isArray(result.outputRows || result.data?.outputRows)
                ? (result.outputRows || result.data?.outputRows)
                : []
            });
            const partialTask = ledger.updateTask(taskId, {
              status: TaskStatus.generating,
              mediaIds: partialVideoMediaIds,
              expectedVideos: expectedVideoCount,
              foundVideos: partialVideoMediaIds.length,
              partialSubmitRecovered: true,
              submitObservationRecovered: true,
              submitObservationError: partialVideoSubmitError,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: ""
            });
            await notifyTaskStateChange(taskId, "video_partial_submit_observed");
            return partialTask;
          }
          if (submitPathFor(task) === "dom_first" && domTaskAllowsApiRepair(task, result)) {
            logger({
              type: "dom_api_repair",
              taskId: task.id,
              mode: task.mode,
              reason: result.error || result.data?.error || result.statusText || "DOM_SUBMIT_FAILED",
              stage: "submitTaskOnly"
            });
            const repaired = await submitViaApi(await prepareApiRepairMedia(task, result));
            logger({ type: "submitted", taskId, result: repaired });
            if (repaired.ok) {
              result.mediaIds = repaired.mediaIds || [];
              result.ok = true;
              result.status = repaired.status || 200;
              result.data = repaired.data || {};
            } else {
              const failedTask = scheduler.markFailure(taskId, repaired.data?.error || repaired.statusText || `HTTP_${repaired.status}`);
              await notifyTaskStateChange(taskId, "api_repair_failed");
              return failedTask;
            }
          }
        }
        if (!result.ok) {
          const observedTask = options.allowStatusFeedSubmitObservation === true ? (ledger.getTask(taskId) || {}) : {};
          const observedVideoIds = observedVideoIdsForTask(observedTask);
          if (observedVideoIds.length) {
            logger({
              type: "submit_failure_adopted_from_status_feed",
              taskId,
              reason: result.data?.error || result.statusText || `HTTP_${result.status}`,
              observedMediaIds: observedVideoIds
            });
            const submitOutputRows = Array.isArray(observedTask.submitOutputRows)
              ? observedTask.submitOutputRows
              : [];
            scheduler.markSubmitted(taskId, observedVideoIds, { submitOutputRows });
            const videoTask = ledger.updateTask(taskId, {
              status: TaskStatus.generating,
              mediaIds: observedVideoIds,
              submitOutputRows,
              statusRows: Array.isArray(observedTask.statusRows) ? observedTask.statusRows : [],
              submittedAt: observedTask.submittedAt || new Date().toISOString(),
              expectedVideos: Number(task.repeatCount || observedTask.expectedVideos || observedVideoIds.length || 1) || 1,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: "",
              submitObservationRecovered: true,
              submitObservationError: result.data?.error || result.statusText || `HTTP_${result.status}`
            });
            await notifyTaskStateChange(taskId, "submit_observed_by_status_feed");
            return videoTask;
          }
          const failedTask = scheduler.markFailure(taskId, result.data?.error || result.statusText || `HTTP_${result.status}`);
          await notifyTaskStateChange(taskId, "submit_failed");
          return failedTask;
        }

        const mediaIds = result.mediaIds || [];
        const submitOutputRows = Array.isArray(result.outputRows || result.data?.outputRows) ? (result.outputRows || result.data?.outputRows) : [];
        scheduler.markSubmitted(taskId, mediaIds, { submitOutputRows });
        await notifyTaskStateChange(taskId, "submitted");

        if (task.mode === FlowTaskMode.textToImage) {
          const imageTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds,
            submittedAt: new Date().toISOString(),
            expectedImages: Number(task.repeatCount || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: ""
          });
          await notifyTaskStateChange(taskId, "image_generating");
          return imageTask;
        }

        if (!mediaIds.length && result.data?.frontSubmitObserved === true && task.mode !== FlowTaskMode.textToImage) {
          const videoTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds: [],
            submitOutputRows,
            submittedAt: new Date().toISOString(),
            expectedVideos: Number(task.repeatCount || task.expectedVideos || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: "",
            submitObservationRecovered: true,
            submitObservationError: result.statusText || "DOM_DEBUGGER_FRONT_SUBMIT_OBSERVED"
          });
          await notifyTaskStateChange(taskId, "video_front_submit_observed");
          return videoTask;
        }

        if (!mediaIds.length) {
          const failedTask = scheduler.markFailure(taskId, "MISSING_GENERATION_IDS");
          await notifyTaskStateChange(taskId, "missing_generation_ids");
          return failedTask;
        }

        const videoTask = ledger.updateTask(taskId, {
          status: TaskStatus.generating,
          mediaIds,
          submitOutputRows,
          submittedAt: new Date().toISOString(),
          expectedVideos: Number(task.repeatCount || mediaIds.length || 1) || 1,
          lastError: "",
          failureClass: "",
          healAction: ""
        });
        await notifyTaskStateChange(taskId, "video_generating_submit_only");
        return videoTask;
      } catch (error) {
        const failedTask = scheduler.markFailure(taskId, error);
        await notifyTaskStateChange(taskId, "exception");
        return failedTask;
      }
    },

    async runTask(taskId, options = {}) {
      if (options.submitOnly === true) {
        return this.submitTaskOnly(taskId, options);
      }
      const task = ledger.getTask(taskId);
      if (!task) throw new Error(`Unknown task id: ${taskId}`);
      if (task.status !== TaskStatus.pending) return task;

      scheduler.markSubmitting(taskId);
      await notifyTaskStateChange(taskId, "submitting");
      const submittingTask = ledger.getTask(taskId) || task;
      logger({
        type: "task_start",
        taskId,
        ...taskLogFields(submittingTask)
      });
      try {
        const result = await submit(task);
        logger({ type: "submitted", taskId, result });
        if (!result.ok && isModelAccessDenied(result) && canFallbackVideoModel(task)) {
          const preparedTask = ledger.getTask(taskId) || submittingTask || task;
          const fallbackModel = fallbackVideoModelForTask(preparedTask);
          const fallbackTask = { ...preparedTask, model: fallbackModel };
          logger({
            type: "model_fallback",
            taskId,
            fromModel: task.model || "",
            toModel: fallbackModel,
            reason: resultErrorText(result)
          });
          ledger.updateTask(taskId, {
            model: fallbackModel,
            modelFallbackFrom: task.model || "",
            lastError: "",
            failureClass: "",
            healAction: "",
            failureScope: ""
          });
          Object.assign(result, result.repairedFromDom
            ? {
                ...(await submitViaApi(fallbackTask)),
                repairedFromDom: true,
                domError: result.domError || ""
              }
            : await submit(fallbackTask));
          logger({ type: "submitted", taskId, result, modelFallback: true });
        }
        if (!result.ok) {
          const partialVideoMediaIds = VIDEO_MODES.has(task.mode) ? compactIds(result.mediaIds || []) : [];
          const expectedVideoCount = Math.max(1, Number(task.repeatCount || task.expectedVideos || partialVideoMediaIds.length || 1) || 1);
          const partialVideoSubmitError = resultErrorText(result);
          const canAdoptPartialVideoSubmit = partialVideoMediaIds.length > 0
            && partialVideoMediaIds.length < expectedVideoCount
            && expectedVideoCount > 1
            && /DOM_DEBUGGER_FRONTEND_NOT_UPDATED|DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS/i.test(partialVideoSubmitError);
          if (canAdoptPartialVideoSubmit) {
            logger({
              type: "partial_video_submit_adopted_for_repair",
              taskId,
              reason: partialVideoSubmitError,
              mediaIds: partialVideoMediaIds,
              foundVideos: partialVideoMediaIds.length,
              expectedVideos: expectedVideoCount
            });
            scheduler.markSubmitted(taskId, partialVideoMediaIds, {
              submitOutputRows: Array.isArray(result.outputRows || result.data?.outputRows)
                ? (result.outputRows || result.data?.outputRows)
                : []
            });
            ledger.updateTask(taskId, {
              mediaIds: partialVideoMediaIds,
              expectedVideos: expectedVideoCount,
              foundVideos: partialVideoMediaIds.length,
              partialSubmitRecovered: true,
              submitObservationRecovered: true,
              submitObservationError: partialVideoSubmitError,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: ""
            });
            await notifyTaskStateChange(taskId, "video_partial_submit_observed");
            if (options.submitOnlyVideos === true || options.submitOnly === true) {
              return ledger.getTask(taskId);
            }
            return pollVideoUntilTerminal(taskId, partialVideoMediaIds, task.projectId);
          }
          if (submitPathFor(task) === "dom_first" && domTaskAllowsApiRepair(task, result)) {
            logger({
              type: "dom_api_repair",
              taskId: task.id,
              mode: task.mode,
              reason: result.error || result.data?.error || result.statusText || "DOM_SUBMIT_FAILED",
              stage: "runTask"
            });
            const repaired = await submitViaApi(await prepareApiRepairMedia(task, result));
            logger({ type: "submitted", taskId, result: repaired });
            if (repaired.ok) {
              result.mediaIds = repaired.mediaIds || [];
              result.ok = true;
              result.status = repaired.status || 200;
              result.data = repaired.data || {};
            } else {
              const failedTask = scheduler.markFailure(taskId, repaired.data?.error || repaired.statusText || `HTTP_${repaired.status}`);
              await notifyTaskStateChange(taskId, "api_repair_failed");
              return failedTask;
            }
          }
        }
        if (!result.ok) {
          const observedTask = options.allowStatusFeedSubmitObservation === true ? (ledger.getTask(taskId) || {}) : {};
          const observedVideoIds = observedVideoIdsForTask(observedTask);
          if (observedVideoIds.length) {
            logger({
              type: "submit_failure_adopted_from_status_feed",
              taskId,
              reason: result.data?.error || result.statusText || `HTTP_${result.status}`,
              observedMediaIds: observedVideoIds
            });
            const submitOutputRows = Array.isArray(observedTask.submitOutputRows)
              ? observedTask.submitOutputRows
              : [];
            scheduler.markSubmitted(taskId, observedVideoIds, { submitOutputRows });
            const videoTask = ledger.updateTask(taskId, {
              status: TaskStatus.generating,
              mediaIds: observedVideoIds,
              submitOutputRows,
              statusRows: Array.isArray(observedTask.statusRows) ? observedTask.statusRows : [],
              submittedAt: observedTask.submittedAt || new Date().toISOString(),
              expectedVideos: Number(task.repeatCount || observedTask.expectedVideos || observedVideoIds.length || 1) || 1,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: "",
              submitObservationRecovered: true,
              submitObservationError: result.data?.error || result.statusText || `HTTP_${result.status}`
            });
            await notifyTaskStateChange(taskId, "submit_observed_by_status_feed");
            return videoTask;
          }
          const failedTask = scheduler.markFailure(taskId, result.data?.error || result.statusText || `HTTP_${result.status}`);
          await notifyTaskStateChange(taskId, "submit_failed");
          return failedTask;
        }

        const mediaIds = result.mediaIds || [];
        const submitOutputRows = Array.isArray(result.outputRows || result.data?.outputRows) ? (result.outputRows || result.data?.outputRows) : [];
        scheduler.markSubmitted(taskId, mediaIds, { submitOutputRows });
        await notifyTaskStateChange(taskId, "submitted");

        if (task.mode === FlowTaskMode.textToImage) {
          const imageTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds,
            submittedAt: new Date().toISOString(),
            expectedImages: Number(task.repeatCount || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: ""
          });
          await notifyTaskStateChange(taskId, "image_generating");
          return imageTask;
        }

        if (!mediaIds.length && result.data?.frontSubmitObserved === true && task.mode !== FlowTaskMode.textToImage) {
          const videoTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds: [],
            submitOutputRows,
            submittedAt: new Date().toISOString(),
            expectedVideos: Number(task.repeatCount || task.expectedVideos || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: "",
            submitObservationRecovered: true,
            submitObservationError: result.statusText || "DOM_DEBUGGER_FRONT_SUBMIT_OBSERVED"
          });
          await notifyTaskStateChange(taskId, "video_front_submit_observed");
          return videoTask;
        }

        if (!mediaIds.length) {
          const failedTask = scheduler.markFailure(taskId, "MISSING_GENERATION_IDS");
          await notifyTaskStateChange(taskId, "missing_generation_ids");
          return failedTask;
        }

        if (options.submitOnlyVideos === true || options.submitOnly === true) {
          const videoTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds,
            submitOutputRows,
            submittedAt: new Date().toISOString(),
            expectedVideos: Number(task.repeatCount || mediaIds.length || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: ""
          });
          await notifyTaskStateChange(taskId, "video_generating_submit_only");
          return videoTask;
        }

        return pollVideoUntilTerminal(taskId, mediaIds, task.projectId);
      } catch (error) {
        const failedTask = scheduler.markFailure(taskId, error);
        await notifyTaskStateChange(taskId, "exception");
        return failedTask;
      }
    }
  };
}
