# AutoFlow - Fix Overlap Progress + Download Ownership

## Mục tiêu

Sửa 2 lỗi hiện tại:

1. **Task 1 không unlock Task 2 khi đang chạy**  
   Khi task 1 đang generate image, extension không bắt được tiến trình thật nên không gọi `pumpQueue()` đúng thời điểm. Kết quả: task 1 hoàn thành xong mới chạy liền task 2 và task 3.

2. **Task chạy bởi Overlap không tải ảnh về**  
   Task 2 / Task 3 có preview hoặc đã thấy output, nhưng bị kẹt ở `Saving outputs` hoặc `Generating in Flow`. Task chạy tuần tự bình thường thì tải được.

---

## Kết luận nguyên nhân

Overlap hiện mới giải quyết được phần **start nhiều task**, nhưng còn thiếu 2 cơ chế bắt buộc:

```txt
A. Progress heartbeat cho image task
   → task đang generating/downloading phải tự cập nhật progress theo foundImages/downloadedCount/timer
   → sau mỗi update phải gọi maybeUnlock + pumpQueue

B. Save/download ownership theo taskId
   → output của task nào phải được claim/save/download theo đúng taskId
   → không dùng currentTask/global latest output
   → không dùng mediaId-only dedupe
```

Điểm quan trọng:

```txt
Overlap không nên làm nhiều task cùng thao tác DOM submit cùng lúc.
Submit vẫn phải serialized bằng submit lock.
Nhưng sau khi task đã submit và đang generating, task tiếp theo có thể được submit.
```

---

## Files cần sửa

```txt
src/background/service-worker.js
src/core/queue/executor.js
src/core/queue/scheduler.js
src/core/queue/task-ledger.js
src/core/queue/overlap-controller.js
```

Có thể cần sửa thêm nếu save/download image đang nằm ở file khác:

```txt
src/core/media/flow-client.js
src/core/gallery/media-ledger.js
```

---

# PHẦN 1 - Sửa lỗi không bắt được progress để start Task 2

## Vấn đề

Hiện overlap-controller có `shouldUnlockNextTask(task)` nhưng task image không được cập nhật `progressPercent` trong lúc đang generate.

Với text-to-image, thường không có percent thật như video. Vì vậy phải tự tính progress từ:

```txt
foundImages / expectedImages
downloadedCount / expectedImages
elapsedSeconds / fallbackSeconds
```

Nếu không làm heartbeat, `shouldUnlockNextTask()` chỉ được gọi khi task hoàn thành, nên sau task 1 complete mới start liền task 2, task 3.

---

## Code cần thêm vào `service-worker.js`

### Code cũ cần tìm

Tìm các đoạn tương tự:

```js
function handleTaskProgress(taskId, percent, source) {
  overlapController.markTaskProgress(taskId, percent, source);

  const task = ledger.getTask(taskId);
  const unlock = overlapController.shouldUnlockNextTask(task);

  if (unlock.ok) {
    overlapController.markUnlockedNext(taskId, unlock.reason);
    pumpQueue();
  }
}
```

Hoặc đoạn đang update progress nhưng không có heartbeat timer.

---

### Code mới

Thêm helper này vào vùng queue runtime của `service-worker.js`:

```js
const overlapHeartbeatTimers = new Map();

function isImageTask(task = {}) {
  return String(task.mode || "").toLowerCase() === "text-to-image";
}

function expectedOutputsForTask(task = {}) {
  if (isImageTask(task)) {
    return Math.max(
      1,
      Number(task.expectedImages || task.imageRepeatCount || task.repeatCount || 1) || 1
    );
  }

  return Math.max(
    1,
    Number(task.expectedVideos || task.repeatCount || 1) || 1
  );
}

function computeTaskProgressPercent(task = {}, presets = {}) {
  const expected = expectedOutputsForTask(task);

  const foundImages = Math.max(0, Number(task.foundImages || 0));
  const foundVideos = Math.max(0, Number(task.foundVideos || 0));
  const downloaded = Math.max(0, Number(task.downloadedCount || 0));

  const found = isImageTask(task) ? foundImages : foundVideos;

  const outputProgress = Math.min(100, (found / expected) * 100);
  const downloadProgress = Math.min(100, (downloaded / expected) * 100);

  // Timer progress không thay thế progress thật, chỉ giúp fallback unlock chạy đúng.
  const fallbackSeconds = Math.max(5, Number(presets.overlapFallbackSeconds || 45));
  const startedAt = Date.parse(
    task.overlapStartedAt ||
    task.submittedAt ||
    task.submitAttemptStartedAt ||
    ""
  );

  let timerProgress = 0;
  if (Number.isFinite(startedAt)) {
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    timerProgress = Math.min(99, (elapsed / fallbackSeconds) * 100);
  }

  return Math.max(outputProgress, downloadProgress, timerProgress);
}

function applyTaskProgressAndMaybePump(taskId, percent, source = "unknown") {
  if (!taskId) return;

  overlapController.markTaskProgress(taskId, percent, source);

  const latest = ledger.getTask(taskId);
  const unlock = overlapController.shouldUnlockNextTask(latest);

  if (unlock.ok) {
    overlapController.markUnlockedNext(taskId, unlock.reason);
    log?.("info", "queue.overlap.unlock", {
      taskId,
      reason: unlock.reason,
      progressPercent: latest?.progressPercent,
      status: latest?.status
    });

    pumpQueue();
  }

  broadcastQueueState?.();
}

function startOverlapHeartbeat(taskId) {
  if (!taskId || overlapHeartbeatTimers.has(taskId)) return;

  const timer = setInterval(() => {
    const task = ledger.getTask(taskId);
    if (!task) {
      stopOverlapHeartbeat(taskId);
      return;
    }

    if (
      task.status === TaskStatus.complete ||
      task.status === TaskStatus.failed ||
      task.status === TaskStatus.blocked ||
      task.status === TaskStatus.pending
    ) {
      stopOverlapHeartbeat(taskId);
      return;
    }

    const presets = getPresets?.() || state?.control?.presets || {};
    const percent = computeTaskProgressPercent(task, presets);

    applyTaskProgressAndMaybePump(taskId, percent, "heartbeat");
  }, 1000);

  overlapHeartbeatTimers.set(taskId, timer);
}

function stopOverlapHeartbeat(taskId) {
  const timer = overlapHeartbeatTimers.get(taskId);
  if (timer) clearInterval(timer);
  overlapHeartbeatTimers.delete(taskId);
}
```

> Nếu trong `service-worker.js` chưa import `TaskStatus`, thêm import từ `../core/queue/task-ledger.js`.

---

## Sửa `startTaskRun(task)`

### Code cũ thường gặp

```js
async function startTaskRun(task) {
  scheduler.markSubmitting(task.id);

  const promise = executor.runTask(task)
    .finally(() => {
      activeTaskRuns.delete(task.id);
      pumpQueue();
    });

  activeTaskRuns.set(task.id, promise);
}
```

---

### Code mới

```js
async function startTaskRun(task) {
  if (!task?.id) return;
  if (activeTaskRuns.has(task.id)) return;

  scheduler.markSubmitting(task.id);
  startOverlapHeartbeat(task.id);

  const promise = runTaskWithSerializedSubmit(task)
    .catch((error) => {
      scheduler.markFailure(task.id, error);
      log?.("error", "queue.task.failed", {
        taskId: task.id,
        error: error?.message || String(error)
      });
    })
    .finally(() => {
      activeTaskRuns.delete(task.id);
      stopOverlapHeartbeat(task.id);
      pumpQueue();
      broadcastQueueState?.();
    });

  activeTaskRuns.set(task.id, promise);
  broadcastQueueState?.();
}
```

---

## Thêm submit lock

### Vì sao cần

Khi overlap chạy 2 task, không được để 2 task cùng nhập prompt / attach ref / click generate cùng lúc. Nếu không, task 2/3 sẽ bị lẫn output hoặc kẹt download.

---

### Code mới

```js
function createAsyncMutex() {
  let chain = Promise.resolve();

  return async function withLock(fn) {
    const prev = chain;
    let release;
    chain = new Promise((resolve) => {
      release = resolve;
    });

    await prev;

    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const withSubmitLock = createAsyncMutex();
```

Sau đó sửa task runner:

```js
async function runTaskWithSerializedSubmit(task) {
  return await executor.runTask(task, {
    async beforeSubmit() {
      // optional hook nếu executor hỗ trợ
    },
    withSubmitLock,
    onProgress: ({ taskId, percent, source }) => {
      applyTaskProgressAndMaybePump(taskId || task.id, percent, source || "executor");
    },
    onImageOutputs: ({ taskId, outputs }) => {
      updateImageOutputsForTask(taskId || task.id, outputs);
      const latest = ledger.getTask(taskId || task.id);
      const percent = computeTaskProgressPercent(latest, getPresets?.() || {});
      applyTaskProgressAndMaybePump(taskId || task.id, percent, "image_outputs");
    }
  });
}
```

Nếu `executor.runTask()` chưa hỗ trợ `withSubmitLock`, sửa executor ở phần submit:

```js
const submitResult = await withSubmitLock(async () => {
  return await submitTaskToFlow(task);
});
```

---

# PHẦN 2 - Sửa Task overlap không tải ảnh về

## Vấn đề

Khi overlap chạy task 2/3, output có thể xuất hiện nhưng save/download đang dựa vào state global như:

```txt
currentTask
latestTask
latestGalleryItem
global saving flag
downloadedMediaIds global
```

Kết quả:

```txt
- task 2 có output nhưng không được claim đúng
- task 2 bị kẹt Saving outputs
- hoặc task 5 có preview nhưng vẫn Generating in Flow
```

---

## Nguyên tắc sửa

Mọi bước save/download phải nhận `taskId`.

```txt
Sai:
saveOutputs()
downloadOutput(output)
downloadedMediaIds.has(mediaId)

Đúng:
saveOutputsForTask(taskId)
downloadOutputForTask(taskId, output)
downloadedOutputKeys.has(`${taskId}:${mediaId}`)
```

---

## Code cần thêm vào `service-worker.js` hoặc file save/download hiện tại

```js
const savingTaskIds = new Set();
const downloadedOutputKeys = new Set();

function makeOutputKey(taskId, output = {}) {
  const mediaId = String(
    output.mediaId ||
    output.id ||
    output.mediaGenerationId ||
    output.generationId ||
    output.url ||
    output.imageUrl ||
    ""
  ).trim();

  return `${taskId}:${mediaId}`;
}

function normalizeImageOutputs(outputs = []) {
  const list = Array.isArray(outputs) ? outputs : [];
  const seen = new Set();

  return list
    .map((output) => {
      if (!output || typeof output !== "object") return null;

      const mediaId = String(
        output.mediaId ||
        output.id ||
        output.mediaGenerationId ||
        output.generationId ||
        ""
      ).trim();

      const imageUrl = String(
        output.imageUrl ||
        output.url ||
        output.downloadUrl ||
        output.mediaUrl ||
        output.thumbnailUrl ||
        ""
      ).trim();

      const key = mediaId || imageUrl;
      if (!key || seen.has(key)) return null;
      seen.add(key);

      return {
        ...output,
        mediaId,
        imageUrl,
        source: output.source || "flow"
      };
    })
    .filter(Boolean);
}

function mergeTaskOutputs(task = {}, outputs = []) {
  const existing = Array.isArray(task.outputs) ? task.outputs : [];
  const merged = [];
  const seen = new Set();

  for (const output of [...existing, ...outputs]) {
    const key = String(
      output?.mediaId ||
      output?.imageUrl ||
      output?.url ||
      output?.downloadUrl ||
      ""
    ).trim();

    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(output);
  }

  return merged;
}

function updateImageOutputsForTask(taskId, rawOutputs = []) {
  const task = ledger.getTask(taskId);
  if (!task) return null;

  const outputs = normalizeImageOutputs(rawOutputs);
  const mergedOutputs = mergeTaskOutputs(task, outputs);

  const outputMediaIds = [
    ...new Set(
      mergedOutputs
        .map((output) => String(output.mediaId || "").trim())
        .filter(Boolean)
    )
  ];

  const expected = expectedOutputsForTask(task);
  const foundImages = Math.min(expected, mergedOutputs.length);

  const patch = {
    outputs: mergedOutputs,
    outputMediaIds,
    expectedImages: expected,
    foundImages,
    progressPercent: Math.min(100, (foundImages / expected) * 100),
    progressUpdatedAt: new Date().toISOString(),
    lastProgressSource: "image_outputs"
  };

  const next = ledger.updateTask(taskId, patch);

  log?.("info", "queue.image.outputs.update", {
    taskId,
    expectedImages: expected,
    foundImages,
    outputCount: mergedOutputs.length,
    outputMediaIds
  });

  applyTaskProgressAndMaybePump(taskId, patch.progressPercent, "image_outputs");

  return next;
}
```

---

## Sửa save/download thành theo taskId

### Code cũ cần tìm

Tìm các function kiểu:

```js
async function saveOutputs() { ... }

async function saveGeneratedImages() { ... }

async function downloadImages(outputs) { ... }

async function downloadOutput(output) { ... }

if (savingOutputs) return;
```

---

### Code mới

```js
async function saveOutputsForTask(taskId) {
  const task = ledger.getTask(taskId);
  if (!task) return;

  if (savingTaskIds.has(taskId)) {
    log?.("debug", "queue.save.skip_already_saving", { taskId });
    return;
  }

  savingTaskIds.add(taskId);

  try {
    scheduler.markDownloading(taskId);
    broadcastQueueState?.();

    const latestBeforeSave = ledger.getTask(taskId);
    const expected = expectedOutputsForTask(latestBeforeSave);
    const outputs = Array.isArray(latestBeforeSave.outputs)
      ? latestBeforeSave.outputs
      : [];

    log?.("info", "queue.save.start", {
      taskId,
      expected,
      outputCount: outputs.length,
      downloadedCount: Number(latestBeforeSave.downloadedCount || 0)
    });

    for (const output of outputs) {
      const key = makeOutputKey(taskId, output);
      if (!key || downloadedOutputKeys.has(key)) continue;

      await downloadSingleOutputForTask(taskId, output);

      downloadedOutputKeys.add(key);

      const current = ledger.getTask(taskId);
      const mediaId = String(
        output.mediaId ||
        output.id ||
        output.mediaGenerationId ||
        output.imageUrl ||
        output.url ||
        ""
      ).trim();

      const downloadedMediaIds = [
        ...new Set([
          ...(Array.isArray(current.downloadedMediaIds) ? current.downloadedMediaIds : []),
          mediaId
        ].filter(Boolean))
      ];

      const downloadedCount = downloadedMediaIds.length;

      ledger.updateTask(taskId, {
        downloadedMediaIds,
        downloadedCount,
        progressPercent: Math.min(100, (downloadedCount / expected) * 100),
        progressUpdatedAt: new Date().toISOString(),
        lastProgressSource: "download"
      });

      applyTaskProgressAndMaybePump(
        taskId,
        Math.min(100, (downloadedCount / expected) * 100),
        "download"
      );

      broadcastQueueState?.();
    }

    const latest = ledger.getTask(taskId);
    const done = Number(latest.downloadedCount || 0) >= expected;

    if (done) {
      scheduler.markComplete(taskId, {
        progressPercent: 100,
        progressUpdatedAt: new Date().toISOString(),
        lastProgressSource: "download_complete"
      });

      log?.("info", "queue.save.complete", {
        taskId,
        expected,
        downloadedCount: latest.downloadedCount
      });
    } else {
      // Không mark complete khi chưa download đủ.
      scheduler.markDownloading(taskId);

      log?.("warn", "queue.save.incomplete", {
        taskId,
        expected,
        downloadedCount: latest.downloadedCount,
        outputCount: Array.isArray(latest.outputs) ? latest.outputs.length : 0
      });
    }
  } finally {
    savingTaskIds.delete(taskId);
    broadcastQueueState?.();
    pumpQueue();
  }
}
```

---

## Hàm download single output

Nếu hiện đã có hàm download cũ, wrap lại như sau:

```js
async function downloadSingleOutputForTask(taskId, output) {
  if (!taskId) throw new Error("downloadSingleOutputForTask missing taskId");
  if (!output) throw new Error("downloadSingleOutputForTask missing output");

  const task = ledger.getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);

  const filename = buildOutputFilenameForTask(task, output);

  log?.("info", "queue.download.output", {
    taskId,
    mediaId: output.mediaId || "",
    filename
  });

  // Dùng lại logic download cũ ở đây.
  // Ví dụ:
  // return await flowClient.downloadImageOutput({ output, filename, task });
  // hoặc:
  // return await chrome.downloads.download({ url: output.imageUrl, filename });

  return await downloadImageOutputUsingExistingPipeline({
    taskId,
    task,
    output,
    filename
  });
}
```

Nếu chưa có `buildOutputFilenameForTask`, dùng tạm:

```js
function buildOutputFilenameForTask(task = {}, output = {}) {
  const index = Math.max(1, Number(task.jobIndex || task.index || 1));
  const mediaId = String(output.mediaId || output.id || Date.now()).slice(-8);
  return `Auto-Flow/task-${String(index).padStart(3, "0")}-${mediaId}.png`;
}
```

---

# PHẦN 3 - Không complete khi chỉ mới thấy ảnh

## Code cũ cần tìm

```js
if (foundImages >= expectedImages) {
  scheduler.markComplete(taskId);
}
```

Hoặc:

```js
if (outputs.length >= expected) {
  scheduler.markComplete(taskId);
}
```

---

## Code mới

```js
if (foundImages >= expectedImages) {
  scheduler.markDownloading(taskId);
  await saveOutputsForTask(taskId);
}

const latest = ledger.getTask(taskId);
if (Number(latest.downloadedCount || 0) >= Number(latest.expectedImages || expectedImages || 1)) {
  scheduler.markComplete(taskId, {
    progressPercent: 100,
    lastProgressSource: "download_complete"
  });
}
```

Nguyên tắc:

```txt
Found/generated đủ ảnh chỉ có nghĩa là được chuyển sang Saving outputs.
Complete chỉ khi downloadedCount >= expectedImages.
```

---

# PHẦN 4 - Sửa poll image outputs để gọi update/save theo taskId

## Code cũ cần tìm

Trong `executor.js` hoặc `service-worker.js`, tìm đoạn poll output image:

```js
const outputs = await flowClient.findGeneratedImages(...);

if (outputs.length) {
  // update UI / task
}
```

Hoặc đoạn dùng gallery mới nhất:

```js
const latestImages = galleryItems.slice(0, expected);
```

---

## Code mới

```js
async function handleImagePollResult(taskId, rawOutputs = []) {
  const task = ledger.getTask(taskId);
  if (!task) return;

  const expected = expectedOutputsForTask(task);
  const next = updateImageOutputsForTask(taskId, rawOutputs);

  if (!next) return;

  const found = Number(next.foundImages || 0);

  if (found >= expected) {
    scheduler.markDownloading(taskId);
    await saveOutputsForTask(taskId);
  }
}
```

Nếu poll nằm trong executor, không cho executor tự save. Executor chỉ callback:

```js
onImageOutputs?.({
  taskId: task.id,
  outputs
});
```

Background mới là nơi gọi `saveOutputsForTask(task.id)`.

---

# PHẦN 5 - Fix lỗi "task 2,3 chạy liền sau task 1"

## Nguyên nhân

`pumpQueue()` có thể đang start tất cả pending theo freeSlots sau khi task 1 complete. Nếu active count chưa đúng hoặc task 2/3 chưa được set status ngay lập tức, nó sẽ start quá nhiều.

---

## Code cần có trong `pumpQueue()`

```js
function pumpQueue() {
  if (!queueRunning || queuePaused) return;

  const presets = getPresets?.() || state?.control?.presets || {};
  const overlapEnabled = presets.overlapEnabled === true;
  const maxConcurrent = overlapEnabled
    ? Math.max(1, Math.min(4, Number(presets.overlapMaxConcurrentTasks || 1)))
    : 1;

  const activeCount = activeTaskRuns.size;
  const freeSlots = Math.max(0, maxConcurrent - activeCount);

  if (freeSlots <= 0) return;

  const nextTasks = scheduler.nextPendingTasks(freeSlots);

  for (const task of nextTasks) {
    if (activeTaskRuns.size >= maxConcurrent) break;
    if (activeTaskRuns.has(task.id)) continue;

    // Quan trọng: markSubmitting đồng bộ trước khi loop tiếp tục
    scheduler.markSubmitting(task.id);
    startTaskRunAfterMarked(task);
  }

  broadcastQueueState?.();
}

function startTaskRunAfterMarked(task) {
  if (!task?.id || activeTaskRuns.has(task.id)) return;

  startOverlapHeartbeat(task.id);

  const promise = runTaskWithSerializedSubmit(task)
    .catch((error) => scheduler.markFailure(task.id, error))
    .finally(() => {
      activeTaskRuns.delete(task.id);
      stopOverlapHeartbeat(task.id);
      pumpQueue();
      broadcastQueueState?.();
    });

  activeTaskRuns.set(task.id, promise);
}
```

Nếu bạn giữ `scheduler.markSubmitting(task.id)` bên trong `startTaskRun()`, vẫn được, nhưng phải đảm bảo nó chạy **trước khi** `pumpQueue()` có thể chọn pending task lần nữa.

---

# PHẦN 6 - Debug logs bắt buộc thêm

Thêm log ở 4 điểm:

```js
log?.("info", "queue.overlap.progress", {
  taskId,
  status: ledger.getTask(taskId)?.status,
  progressPercent: ledger.getTask(taskId)?.progressPercent,
  foundImages: ledger.getTask(taskId)?.foundImages,
  expectedImages: ledger.getTask(taskId)?.expectedImages,
  downloadedCount: ledger.getTask(taskId)?.downloadedCount,
  source
});

log?.("info", "queue.overlap.pump", {
  activeTaskRunIds: [...activeTaskRuns.keys()],
  activeCount: activeTaskRuns.size,
  maxConcurrent,
  freeSlots,
  nextTaskIds: nextTasks.map((task) => task.id)
});

log?.("info", "queue.image.outputs.update", {
  taskId,
  foundImages,
  expectedImages,
  outputMediaIds
});

log?.("info", "queue.save.state", {
  taskId,
  status: ledger.getTask(taskId)?.status,
  expectedImages: ledger.getTask(taskId)?.expectedImages,
  foundImages: ledger.getTask(taskId)?.foundImages,
  downloadedCount: ledger.getTask(taskId)?.downloadedCount,
  savingTaskIds: [...savingTaskIds]
});
```

---

# PHẦN 7 - Checklist test thủ công

## Test 1 - Overlap unlock bằng fallback timer

Cài:

```txt
Overlap enabled: ON
Max concurrent: 2
Trigger progress: 50
Fallback seconds: 10
Image repeat count: 1
Prompt count: 5
```

Kỳ vọng:

```txt
Task 1 start
Sau khoảng 10s nếu chưa có output, Task 2 start
Không đợi task 1 complete
Không có quá 2 task active
```

---

## Test 2 - Overlap unlock bằng foundImages

Cài:

```txt
Overlap enabled: ON
Max concurrent: 2
Trigger progress: 50
Fallback seconds: 60
Image repeat count: 1
```

Kỳ vọng:

```txt
Task 1 vừa có 1/1 output → progress 100%
Task 2 start ngay
Task 1 chuyển Saving outputs
Task 1 Complete sau khi download xong
```

---

## Test 3 - Task overlap tải ảnh

Kỳ vọng:

```txt
Task 2 có preview
Task 2 chuyển Saving outputs
Task 2 downloadedCount tăng
Task 2 Complete
File ảnh tồn tại trong download folder
```

---

## Test 4 - Không complete sớm

Nếu tắt mạng hoặc làm download fail:

```txt
Task có foundImages = 1/1
Nhưng downloadedCount = 0
Task KHÔNG được Complete
Task phải ở Saving outputs hoặc Failed/Retry
```

---

## Test 5 - Không vượt max concurrent

Cài:

```txt
Max concurrent: 2
Prompt count: 5
```

Kỳ vọng:

```txt
Không bao giờ có 3 task đồng thời ở trạng thái:
submitting / generating / downloading
```

---

# Prompt đưa cho Vibe Code / Codex

```txt
Hãy đọc repo AutoFlow hiện tại.

Lỗi:
1. Overlap max concurrent = 2 nhưng task 1 không unlock task 2 khi đang chạy. Extension đợi task 1 hoàn thành rồi mới chạy liền task 2 và task 3.
2. Task chạy bởi overlap có preview/output nhưng không tải ảnh về, bị kẹt ở "Saving outputs" hoặc "Generating in Flow". Task chạy tuần tự thì tải được.

Yêu cầu sửa:
- Không sửa UI overlap nữa, tập trung service-worker/executor/save pipeline.
- Thêm heartbeat mỗi 1 giây cho active task để cập nhật progressPercent từ foundImages/downloadedCount/timer fallback.
- Sau mỗi progress update phải gọi overlapController.shouldUnlockNextTask + markUnlockedNext + pumpQueue.
- Submit prompt/attach refs phải serialized bằng submit mutex; generation/poll/download có thể overlap.
- Mọi output image phải được update/save/download theo taskId.
- Thêm saveOutputsForTask(taskId), không dùng saveOutputs global/currentTask.
- Duplicate key download phải là taskId + mediaId hoặc taskId + imageUrl, không dùng mediaId global.
- Không mark complete khi chỉ foundImages đủ. Chỉ mark complete khi downloadedCount >= expectedImages.
- Nếu executor poll được image outputs, executor chỉ callback onImageOutputs({taskId, outputs}); background chịu trách nhiệm update ledger và saveOutputsForTask(taskId).
- Thêm log debug: queue.overlap.progress, queue.overlap.pump, queue.image.outputs.update, queue.save.state.
```

---

# Ghi chú quan trọng

Nếu hiện tại task 2 có preview nhưng không download, lỗi **không nằm ở overlap-controller**. Lỗi nằm ở phần output claiming/save/download.

Nếu task 1 complete rồi task 2/3 mới chạy liền, lỗi nằm ở **thiếu heartbeat/progress callback**, không phải UI setting.
