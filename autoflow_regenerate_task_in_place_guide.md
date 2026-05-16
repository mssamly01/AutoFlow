# AutoFlow — Sửa chức năng “Tạo lại ảnh” để chạy lại trên chính task cũ

## Mục tiêu

Hiện tại, khi bấm **Tạo lại ảnh / Regenerate**, `src/sidepanel/app.js` đang lấy dữ liệu từ task cũ, tạo `regeneratedJob`, rồi gọi `enqueueJobs([regeneratedJob], ...)`. Kết quả là extension tạo **queue item / task mới**.

Mục tiêu mới:

```txt
Bấm Tạo lại ảnh
→ không tạo queue mới
→ không tạo task mới
→ reset chính task hiện tại về pending
→ xóa output/trạng thái cũ của task đó
→ queue runner chạy lại chính task đó
```

---

## Tóm tắt nguyên nhân lỗi

Trong `src/sidepanel/app.js`, function hiện tại:

```js
async function regenerateTask(taskId) {
  ...
  const regeneratedJob = { ... };
  const { added } = await enqueueJobs([regeneratedJob], { modeOverride: mode });
  ...
}
```

Đoạn này là nguyên nhân chính vì `enqueueJobs()` luôn thêm job mới vào queue. Vì vậy, muốn sửa đúng thì không dùng `enqueueJobs()` trong `regenerateTask()` nữa.

---

# PLAN

## Bước 1 — Thêm message mới

Thêm message `QueueResetTask` vào `src/core/contracts/messages.js`.

Message này dùng để sidepanel yêu cầu background reset một task cũ về trạng thái chờ chạy lại.

## Bước 2 — Thêm hàm reset task vào task ledger

Thêm function `resetTaskForRegenerate(id, patch = {})` vào `src/core/queue/task-ledger.js`.

Function này sẽ:

- giữ nguyên `id` của task
- giữ nguyên prompt / mode / model / aspectRatio / references
- reset `status` về `pending`
- reset lỗi cũ
- reset output/media cũ
- reset attempts
- thêm metadata `regeneratedAt`, `regenerateCount`

## Bước 3 — Thêm handler trong background service worker

Trong `src/background/service-worker.js`, thêm handler xử lý `MessageType.QueueResetTask`.

Handler này sẽ:

- nhận `taskId`
- tìm task trong ledger
- gọi `ledger.resetTaskForRegenerate(taskId, expectedPatch)`
- persist lại queue ledger snapshot
- start/resume queue nếu cần
- trả snapshot mới về sidepanel

## Bước 4 — Sửa `regenerateTask()` trong sidepanel

Trong `src/sidepanel/app.js`, thay toàn bộ logic tạo `regeneratedJob` bằng logic gửi message `QueueResetTask`.

---

# CODE

---

# 1. File: `src/core/contracts/messages.js`

## Code cũ cần tìm

```js
QueueRemove: "af.rebuild.queue.remove",
QueuePrune: "af.rebuild.queue.prune",
```

## Code mới

```js
QueueRemove: "af.rebuild.queue.remove",
QueueResetTask: "af.rebuild.queue.resetTask",
QueuePrune: "af.rebuild.queue.prune",
```

## Nếu file đang nằm một dòng

Repo hiện có thể đang format `messages.js` thành một dòng. Khi đó hãy tìm đoạn:

```js
QueueRemove: "af.rebuild.queue.remove", QueuePrune: "af.rebuild.queue.prune",
```

và thay bằng:

```js
QueueRemove: "af.rebuild.queue.remove", QueueResetTask: "af.rebuild.queue.resetTask", QueuePrune: "af.rebuild.queue.prune",
```

---

# 2. File: `src/core/queue/task-ledger.js`

## Code cũ cần tìm

Tìm trong `createTaskLedger()` đoạn object `api`, gần function `updateTask`:

```js
updateTask(id, patch) {
  const current = tasks.get(String(id));
  if (!current) throw new Error(`Unknown task id: ${id}`);
  const next = {
    ...current,
    ...patch,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        patch: sanitizeTaskEventPatch(patch)
      }
    ]
  };
  tasks.set(String(id), next);
  return next;
},
```

## Code mới

Giữ nguyên `updateTask`, sau đó thêm ngay bên dưới:

```js
resetTaskForRegenerate(id, patch = {}) {
  const current = tasks.get(String(id));
  if (!current) throw new Error(`Unknown task id: ${id}`);

  const resetPatch = {
    // Cho scheduler nhặt lại chính task này.
    status: TaskStatus.pending,

    // Reset vòng chạy.
    attempts: 0,
    submitAttemptStartedAt: "",
    submittedAt: "",
    completedAt: "",

    // Reset lỗi.
    lastError: "",
    failureClass: "",
    healAction: "",
    failureScope: "",
    partialFailure: false,

    // Reset output/media cũ.
    mediaIds: [],
    outputMediaIds: [],
    outputs: [],
    statusRows: [],
    submitOutputRows: [],
    downloadedMediaIds: [],
    skippedDownloadMediaIds: [],
    downloadErrorMediaIds: [],
    downloadedCount: 0,

    // Reset đếm output theo mode.
    expectedImages: 0,
    foundImages: 0,
    expectedVideos: 0,
    foundVideos: 0,
    failedOutputCount: 0,
    failedOutputMediaIds: [],

    // Metadata để UI/debug biết đây là regenerate trên task cũ.
    regeneratedAt: new Date().toISOString(),
    regenerateCount: Number(current.regenerateCount || 0) + 1,

    ...patch
  };

  const next = {
    ...current,
    ...resetPatch,
    events: [
      ...(Array.isArray(current.events) ? current.events : []),
      {
        at: new Date().toISOString(),
        patch: sanitizeTaskEventPatch({
          action: "regenerate.reset",
          ...resetPatch
        })
      }
    ]
  };

  tasks.set(String(id), next);
  return next;
},
```

## Ghi chú quan trọng

Không được reset các field input gốc sau:

```txt
prompt
sourcePrompt
imagePrompt
videoPrompt
mode
projectId
model
aspectRatio
repeatCount
submitPath
refInputs
startRefInput
endRefInput
refMediaIds
startMediaId
endMediaId
```

Vì đây là dữ liệu cần giữ lại để chạy lại đúng task cũ.

---

# 3. File: `src/background/service-worker.js`

## Code cũ cần tìm

Tìm khu vực background xử lý message queue, thường có các nhánh như:

```js
MessageType.QueueAddJob
MessageType.QueueStart
MessageType.QueueStop
MessageType.QueueClear
MessageType.QueueRemove
MessageType.QueuePrune
```

hoặc dạng:

```js
if (message.type === MessageType.QueueRemove) {
  ...
}
```

## Code mới cần thêm

Thêm nhánh này vào cùng khu vực xử lý queue message:

```js
if (message.type === MessageType.QueueResetTask) {
  const taskId = String(message.payload?.id || "").trim();
  if (!taskId) {
    throw new Error("Missing task id");
  }

  const task = ledger.getTask(taskId);
  if (!task) {
    throw new Error(`Unknown task id: ${taskId}`);
  }

  const mode = String(task.mode || "");

  const expectedPatch =
    mode === "text-to-image"
      ? {
          expectedImages: Math.max(
            1,
            Number(task.repeatCount || task.expectedImages || 1) || 1
          ),
          foundImages: 0,
          expectedVideos: 0,
          foundVideos: 0
        }
      : {
          expectedVideos: Math.max(
            1,
            Number(task.repeatCount || task.expectedVideos || 1) || 1
          ),
          foundVideos: 0,
          expectedImages: 0,
          foundImages: 0
        };

  const resetTask = ledger.resetTaskForRegenerate(taskId, expectedPatch);

  await persistQueueLedgerSnapshot?.();

  emitRuntimeEvent?.({
    type: "queue.task.regenerate",
    taskId,
    mode: resetTask.mode,
    status: resetTask.status,
    regenerateCount: resetTask.regenerateCount || 1
  });

  // Nếu queue chưa chạy, start/resume để pending task được xử lý ngay.
  if (!queueRunning) {
    runQueue?.();
  }

  return {
    ok: true,
    task: resetTask,
    queue: {
      tasks: ledger.snapshot?.() || ledger.listTasks()
    },
    queueRunning: true
  };
}
```

## Nếu tên biến trong service worker khác

Nếu file của bạn không có đúng các tên này:

```js
ledger
persistQueueLedgerSnapshot
emitRuntimeEvent
queueRunning
runQueue
```

hãy đổi sang tên thực tế trong file.

Ý chính bắt buộc là:

```js
const resetTask = ledger.resetTaskForRegenerate(taskId, expectedPatch);
await lưu_lại_queue_ledger_snapshot();
start_or_resume_queue_if_needed();
return queue_snapshot_mới;
```

---

# 4. File: `src/sidepanel/app.js`

## Code cũ cần thay

Tìm toàn bộ function:

```js
async function regenerateTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;

  const sourceTask = (state.queue.items || []).find((item) => String(item?.id || "") === id);
  if (!sourceTask) {
    appendLog("warn", "queue", "Regenerate failed: task not found.");
    await persistState();
    render();
    return;
  }

  const prompt = String(sourceTask.prompt || "").trim();
  if (!prompt) {
    appendLog("warn", "queue", "Regenerate failed: original task has no prompt.");
    await persistState();
    render();
    return;
  }

  const mode = String(sourceTask.mode || state.control.mode || FLOW_MODES.textToImage);
  let projectId = String(sourceTask.projectId || state.runtime.projectId || "").trim();
  if (!projectId) {
    projectId = String(await ensureFlowProject() || state.runtime.projectId || "").trim();
  }
  if (!projectId) {
    appendLog("warn", "queue", "Regenerate failed: no Flow project is connected.");
    await persistState();
    render();
    return;
  }

  const repeatCount = Math.max(1, Number(sourceTask.repeatCount || sourceTask.expectedImages || sourceTask.expectedVideos || 1) || 1);
  const refInputs = Array.isArray(sourceTask.refInputs) ? sourceTask.refInputs.map((ref) => (ref && typeof ref === "object" ? { ...ref } : ref)).filter(Boolean) : [];
  const startRefInput = sourceTask.startRefInput && typeof sourceTask.startRefInput === "object" ? { ...sourceTask.startRefInput } : null;
  const endRefInput = sourceTask.endRefInput && typeof sourceTask.endRefInput === "object" ? { ...sourceTask.endRefInput } : null;
  const refMediaIds = (Array.isArray(sourceTask.refMediaIds) ? sourceTask.refMediaIds : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const fallbackMediaIds = (Array.isArray(sourceTask.mediaIds) ? sourceTask.mediaIds : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const mediaIds = refMediaIds.length ? refMediaIds : fallbackMediaIds;

  const regeneratedJob = {
    prompt,
    sourcePrompt: String(sourceTask.sourcePrompt || sourceTask.prompt || ""),
    imagePrompt: String(sourceTask.imagePrompt || ""),
    videoPrompt: String(sourceTask.videoPrompt || ""),
    sceneTag: String(sourceTask.sceneTag || ""),
    mode,
    projectId,
    model: String(sourceTask.model || (mode === FLOW_MODES.textToImage ? "nano_banana_pro" : "default")),
    aspectRatio: String(sourceTask.aspectRatio || "landscape"),
    repeatCount,
    videoLength: String(sourceTask.videoLength || sourceTask.videoDurationSeconds || state.control.presets.videoLength || "8"),
    videoDurationSeconds: String(sourceTask.videoDurationSeconds || sourceTask.videoLength || state.control.presets.videoLength || "8"),
    submitPath: String(sourceTask.submitPath || sourceTask.submitPathPreference || state.control.presets.submitPath || "api_first"),
    refInputs,
    startRefInput,
    endRefInput,
    mediaIds,
    startMediaId: String(sourceTask.startMediaId || startRefInput?.mediaId || ""),
    endMediaId: String(sourceTask.endMediaId || endRefInput?.mediaId || ""),
    returnSilentVideos: sourceTask.returnSilentVideos !== false
  };

  if (sourceTask.download && typeof sourceTask.download === "object") {
    regeneratedJob.download = { ...sourceTask.download };
  }

  const { added } = await enqueueJobs([regeneratedJob], { modeOverride: mode });
  if (added > 0) {
    state.ui.activeRoute = "live";
    state.ui.galleryTab = mode === FLOW_MODES.textToImage ? "images" : "videos";
    appendLog("info", "queue", `Regenerate queued for task ${id.slice(0, 8)}.`);
    await persistState();
    render();
    if (!state.queue.running) {
      await runQueue();
    } else {
      scheduleRuntimeRefresh(0);
      scheduleLiveQueueRefreshBurst();
    }
    return;
  }

  appendLog("warn", "queue", "Regenerate failed: could not add a new queue task.");
  await persistState();
  render();
}
```

## Code mới thay toàn bộ function trên

```js
async function regenerateTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;

  const sourceTask = (state.queue.items || []).find(
    (item) => String(item?.id || "") === id || String(item?.jobId || "") === id
  );

  if (!sourceTask) {
    appendLog("warn", "queue", "Regenerate failed: task not found.");
    await persistState();
    render();
    return;
  }

  const prompt = String(sourceTask.prompt || "").trim();
  if (!prompt) {
    appendLog("warn", "queue", "Regenerate failed: original task has no prompt.");
    await persistState();
    render();
    return;
  }

  const response = await send(MessageType.QueueResetTask, { id }).catch((error) => ({
    payload: {
      error: error?.message || String(error || "Unknown error")
    }
  }));

  if (response?.payload?.error) {
    appendLog("warn", "queue", `Regenerate failed: ${response.payload.error}`);
    await persistState();
    render();
    return;
  }

  applyRuntimePayload(response?.payload || {});

  const mode = String(sourceTask.mode || state.control.mode || FLOW_MODES.textToImage);
  state.ui.activeRoute = "live";
  state.ui.galleryTab = mode === FLOW_MODES.textToImage ? "images" : "videos";

  appendLog("info", "queue", `Regenerate reset task ${id.slice(0, 8)}.`);

  await persistState();
  render();

  scheduleRuntimeRefresh(0);
  scheduleLiveQueueRefreshBurst();
}
```

## Điểm khác biệt quan trọng

Code mới không còn đoạn này:

```js
const { added } = await enqueueJobs([regeneratedJob], { modeOverride: mode });
```

Đây là điều bắt buộc để không tạo task mới.

---

# 5. Kiểm tra button “Tạo lại”

Nếu button hiện đang gọi:

```js
regenerateTask(taskId)
```

thì giữ nguyên.

Nếu button hoặc gallery action đang tự tạo job mới, ví dụ:

```js
enqueueJobs(...)
```

hãy đổi thành:

```js
regenerateTask(taskId)
```

Nếu item từ gallery không có `taskId`, hãy map task id như sau:

```js
const taskId =
  item.taskId ||
  item.sourceTaskId ||
  item.queueTaskId ||
  item.id;
```

Sau đó gọi:

```js
regenerateTask(taskId);
```

---

# 6. Hành vi đúng sau khi sửa

## Trước khi sửa

```txt
Task A: complete
Bấm Tạo lại
→ tạo Task B: pending
→ Task A vẫn complete
```

Đây là hành vi sai.

## Sau khi sửa

```txt
Task A: complete
Bấm Tạo lại
→ Task A reset về pending
→ Task A generating
→ Task A downloading
→ Task A complete lại
```

Không xuất hiện Task B.

---

# 7. Checklist test thủ công

## Test 1 — Task complete tạo lại ảnh

```txt
1. Tạo 1 ảnh thành công.
2. Vào Live Queue.
3. Bấm Tạo lại trên task đó.
4. Kiểm tra queue.
```

Kết quả đúng:

```txt
Không có task mới.
Task cũ đổi status về pending/generating.
Task cũ hoàn thành lại với ảnh mới.
```

## Test 2 — Task failed tạo lại ảnh

```txt
1. Làm một task bị failed.
2. Bấm Tạo lại.
```

Kết quả đúng:

```txt
Task failed cũ reset về pending.
lastError bị xóa.
attempts reset về 0.
Task chạy lại.
```

## Test 3 — Không mất prompt/reference

```txt
1. Tạo task có prompt + reference image.
2. Sau khi complete, bấm Tạo lại.
```

Kết quả đúng:

```txt
Task vẫn dùng prompt cũ.
Task vẫn dùng reference cũ.
Không bị mất input gốc.
Chỉ output cũ bị reset.
```

## Test 4 — Reload extension sau khi reset

```txt
1. Bấm Tạo lại.
2. Reload sidepanel hoặc extension.
3. Mở lại Live Queue.
```

Kết quả đúng:

```txt
Task vẫn là task cũ.
Không bị nhân đôi queue.
Status phản ánh trạng thái mới nhất.
```

---

# 8. Checklist code review

Trước khi commit, kiểm tra lại:

```txt
[ ] MessageType có QueueResetTask.
[ ] task-ledger có resetTaskForRegenerate().
[ ] regenerateTask() không còn gọi enqueueJobs().
[ ] background/service-worker xử lý QueueResetTask.
[ ] Reset task không xóa prompt/mode/model/reference.
[ ] Reset task có xóa output/media/error cũ.
[ ] Sau khi reset có persist queue ledger snapshot.
[ ] Queue runner được start/resume nếu đang không chạy.
```

---

# 9. Gợi ý prompt cho Vibe Code / Codex

Bạn có thể đưa prompt này cho AI code:

```txt
Trong repo AutoFlow, sửa chức năng regenerate task.

Yêu cầu:
- Khi bấm regenerate/tạo lại ảnh, không được tạo queue item mới.
- Không được gọi enqueueJobs trong regenerateTask nữa.
- Phải reset chính task hiện tại về status pending.
- Giữ nguyên id, prompt, mode, model, aspectRatio, repeatCount, references của task cũ.
- Xóa output/media/error/trạng thái chạy cũ.
- Thêm MessageType.QueueResetTask.
- Thêm ledger.resetTaskForRegenerate(id, patch).
- Thêm background handler cho QueueResetTask để persist ledger và start/resume queue nếu cần.
- Sau khi reset, Live Queue phải hiển thị chính task cũ đang chạy lại.

Các file cần sửa:
- src/core/contracts/messages.js
- src/core/queue/task-ledger.js
- src/background/service-worker.js
- src/sidepanel/app.js

Không thay đổi kiến trúc lớn. Không refactor ngoài phạm vi lỗi này.
```

---

# 10. Kết luận

Lỗi không nằm ở UI button mà nằm ở logic regenerate hiện tại đang dùng `enqueueJobs()` để tạo job mới.

Cách sửa đúng là chuyển luồng thành:

```txt
sidepanel regenerateTask(taskId)
→ send MessageType.QueueResetTask
→ background reset chính task trong ledger
→ persist ledger
→ queue runner chạy lại task pending đó
```

Sau sửa, chức năng **Tạo lại ảnh** sẽ chạy lại trên chính task cũ, không tạo queue mới, không tạo task mới.
