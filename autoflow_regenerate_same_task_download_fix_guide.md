# AutoFlow — Fix regenerate on same task + clear old thumbnail + restore image downloads

> Mục tiêu:
>
> 1. Khi bấm **reload / regenerate** cho một task, extension phải **chạy lại chính task đó**, không tạo task mới.
> 2. Ngay khi reset task để chạy lại, **ảnh đại diện cũ phải biến mất**, UI trở về trạng thái “trống / placeholder”.
> 3. Sau khi ảnh mới generate xong, **auto-download phải hoạt động lại bình thường**.

---

## 1) Hiện tượng bạn đang gặp

Từ ảnh bạn gửi, có 3 dấu hiệu rất rõ:

- Task regenerate vẫn còn hiển thị **thumbnail cũ**.
- Khu vực **Saving outputs** đang giữ trạng thái cũ, nên UI nhìn như task chưa thật sự được reset.
- Counter kiểu **`6/5 outputs - 4 saved`** cho thấy dữ liệu cũ và dữ liệu mới đang bị trộn vào nhau.

=> Đây không phải chỉ là lỗi UI. Đây là lỗi **state reset chưa sạch**.

---

## 2) Root cause (nguyên nhân gốc)

### Root cause A — `regenerateTask()` đang tạo queue/task mới

Trong repo hiện tại, `regenerateTask(taskId)` ở `src/sidepanel/app.js` đang build lại một `regeneratedJob`, rồi gọi:

```js
const { added } = await enqueueJobs([regeneratedJob], { modeOverride: mode });
```

=> Nghĩa là nút regenerate hiện đang **append job mới vào queue**, chứ không phải reset task cũ.

---

### Root cause B — khi reuse cùng `taskId`, state cũ chưa được xóa hết

Ngay cả khi bạn sửa để chạy lại trên **cùng task cũ**, nếu chỉ đổi `status = pending` thì vẫn **chưa đủ**.

Bạn còn phải xóa toàn bộ state cũ như:

- `outputs`
- `outputMediaIds`
- `statusRows`
- `submitOutputRows`
- `downloadedMediaIds`
- `downloadErrorMediaIds`
- `foundImages`, `foundVideos`
- `downloadedCount`
- thumbnail / preview liên quan

Nếu không xóa, UI vẫn sẽ lấy ảnh cũ làm thumbnail đại diện.

---

### Root cause C — stale runtime events đang “bơm lại” download/result cũ vào task đã reset

Trong background có logic repair queue download state từ runtime events:

- `downloadResultsFromRuntimeEvents(...)`
- `repairQueueDownloadStateFromEvents(...)`
- `queueState()` cũng gọi repair trước khi trả snapshot.

Vì bạn muốn **reuse cùng taskId**, nên nếu `runtimeState.events` vẫn còn các event cũ của task đó, hệ thống repair có thể:

- gắn lại kết quả download cũ
- gắn lại lỗi download cũ
- làm counter bị lệch
- làm task mới bị “nhiễm” trạng thái cũ

=> Đây là lý do vì sao sau regenerate bạn có thể thấy:

- thumbnail cũ vẫn còn
- output count sai (`6/5`)
- download không chạy đúng

---

### Root cause D — auto-download chỉ chạy khi task đủ điều kiện

Background hiện chỉ auto-download khi task đủ điều kiện, ví dụ:

- task `status === complete`
- `task.download.enabled === true`
- output ledger cho rằng vẫn còn output chưa download

Nếu khi reset task bạn không **clear `downloadedMediaIds` / `downloadErrorMediaIds` / output download status cũ**, hoặc bạn làm mất `download.enabled`, thì download mới sẽ không được kích hoạt lại đúng cách.

---

## 3) Hướng sửa đúng

### Kết quả mong muốn

Luồng chuẩn sau khi bấm regenerate phải là:

```text
Task A complete
↓
Click regenerate
↓
Reset Task A tại chỗ
- status = pending
- outputs = []
- outputMediaIds = []
- download state = reset
- thumbnail cũ biến mất
- runtime events cũ của task A bị purge hoặc bị cô lập
↓
Queue runner pick lại Task A
↓
Task A generate lại output mới
↓
Task A auto-download output mới
```

---

## 4) File cần sửa

```txt
src/core/contracts/messages.js
src/core/queue/task-ledger.js
src/background/service-worker.js
src/sidepanel/app.js
src/sidepanel/views.js            (nếu cần ép UI clear placeholder)
```

---

# 5) PLAN triển khai

## PLAN A — Thêm message reset task

Thêm một message riêng để sidepanel yêu cầu background reset task cũ:

- `QueueResetTask`

Mục tiêu: regenerate không còn gọi `enqueueJobs()` nữa.

---

## PLAN B — Tạo helper reset task trong ledger

Thêm 1 helper kiểu:

- `resetTaskForRegenerate(taskId, patch)`

Helper này phải reset sạch toàn bộ state runtime của task, nhưng **giữ nguyên input gốc**:

Giữ nguyên:

- `prompt`
- `sourcePrompt`
- `imagePrompt`
- `videoPrompt`
- `mode`
- `projectId`
- `model`
- `aspectRatio`
- `repeatCount`
- `refInputs`
- `startRefInput`
- `endRefInput`
- `refMediaIds`
- `download` config

Reset:

- `status`
- `attempts`
- `outputs`
- `outputMediaIds`
- `statusRows`
- `submitOutputRows`
- `downloadedMediaIds`
- `downloadErrorMediaIds`
- `skippedDownloadMediaIds`
- `downloadedCount`
- `foundImages`
- `foundVideos`
- `failedOutputCount`
- `failedOutputMediaIds`
- `lastError`
- `failureClass`
- `healAction`
- `failureScope`
- thumbnail/preview runtime fields nếu có

---

## PLAN C — Purge stale runtime artifacts theo `taskId`

Đây là phần **rất quan trọng** để fix lỗi ảnh cũ + lỗi download.

Khi reset task để regenerate trên cùng `taskId`, background phải xóa sạch runtime artifacts cũ của task đó, ví dụ:

- `media.download`
- `media.download.error`
- `media.download.filename_suggest`
- `queue.download_reconcile`
- `queue.download_repair`
- `queue.flow_generation_feed`
- các event generation cũ có `taskId`

Nếu không làm bước này, cùng `taskId` sẽ tiếp tục bị reconcile bằng event cũ.

> Nếu bạn muốn hệ thống sạch hơn về lâu dài, có thể dùng thêm `runNonce` / `regenEpoch` cho task, rồi gắn epoch đó vào runtime events. Nhưng để fix nhanh, purge events cũ theo `taskId` là đủ hiệu quả.

---

## PLAN D — Sidepanel regenerate phải gọi reset task, không enqueue job mới

Sửa `regenerateTask(taskId)` để:

- validate task tồn tại
- gửi `QueueResetTask`
- apply runtime payload mới
- chuyển UI về tab `live`
- render lại ngay

Không được gọi `enqueueJobs()` nữa.

---

## PLAN E — UI phải fallback về placeholder khi task chưa có output

Trong `views.js`, nếu task sau reset có:

- `outputs.length === 0`
- `outputMediaIds.length === 0`
- không có preview URL hiện hành

thì UI phải:

- **không render thumbnail cũ**
- render icon / placeholder trống

Đây là lớp bảo vệ UI, ngay cả khi state bị chậm 1 tick.

---

## PLAN F — Re-arm auto-download cho run mới

Sau reset task:

- giữ nguyên `task.download.enabled`
- clear toàn bộ trạng thái download cũ
- khi output mới complete, background phải lại đi qua luồng `shouldAttemptAutoDownloadForTask(task)`

Nếu cần, ở cuối regenerate reset có thể set thêm cờ:

- `downloadRetryArmed = true`
- `downloadSessionId = Date.now()` (optional)

để debug dễ hơn.

---

# 6) CODE — `src/core/contracts/messages.js`

## Code cũ

Tìm block `MessageType` có đoạn gần giống:

```js
QueueAddJob: "af.rebuild.queue.addJob",
QueueStart: "af.rebuild.queue.start",
QueueResume: "af.rebuild.queue.resume",
QueueStop: "af.rebuild.queue.stop",
QueueClear: "af.rebuild.queue.clear",
QueueRemove: "af.rebuild.queue.remove",
QueuePrune: "af.rebuild.queue.prune",
```

## Code mới

Thêm `QueueResetTask`:

```js
QueueAddJob: "af.rebuild.queue.addJob",
QueueStart: "af.rebuild.queue.start",
QueueResume: "af.rebuild.queue.resume",
QueueStop: "af.rebuild.queue.stop",
QueueClear: "af.rebuild.queue.clear",
QueueRemove: "af.rebuild.queue.remove",
QueueResetTask: "af.rebuild.queue.resetTask",
QueuePrune: "af.rebuild.queue.prune",
```

---

# 7) CODE — `src/core/queue/task-ledger.js`

## Code cũ

Hiện ledger mới có các hàm chính như:

```js
addTask(task) { ... }
updateTask(id, patch) { ... }
getTask(id) { ... }
listTasks() { ... }
clearTasks() { ... }
pruneTasks(predicate) { ... }
replaceTasks(nextTasks = []) { ... }
snapshot() { ... }
debugSnapshot() { ... }
hasOpenTasks() { ... }
```

## Code mới

Thêm helper mới vào `api`:

```js
resetTaskForRegenerate(id, patch = {}) {
  const current = tasks.get(String(id));
  if (!current) throw new Error(`Unknown task id: ${id}`);

  const now = new Date().toISOString();

  const next = {
    ...current,

    // Re-run on the same task
    status: TaskStatus.pending,
    attempts: 0,

    // Clear timing/runtime markers
    submitAttemptStartedAt: "",
    submittedAt: "",
    completedAt: "",

    // Clear error/failure state
    lastError: "",
    failureClass: "",
    healAction: "",
    failureScope: "",
    partialFailure: false,

    // Clear generated output state
    mediaIds: Array.isArray(current.refMediaIds) ? [] : [],
    outputMediaIds: [],
    outputs: [],
    statusRows: [],
    submitOutputRows: [],

    // Clear output counters
    expectedImages: Number(current.expectedImages || 0),
    foundImages: 0,
    expectedVideos: Number(current.expectedVideos || 0),
    foundVideos: 0,
    failedOutputCount: 0,
    failedOutputMediaIds: [],

    // Clear download state
    downloadedMediaIds: [],
    skippedDownloadMediaIds: [],
    downloadErrorMediaIds: [],
    downloadedCount: 0,
    skippedDownloadCount: 0,

    // Clear stale preview-ish fields if your task carries them
    previewUrl: "",
    thumbnailUrl: "",
    coverUrl: "",
    latestImageUrl: "",
    latestThumbUrl: "",

    // Useful debug metadata
    regeneratedAt: now,
    regenerateCount: Number(current.regenerateCount || 0) + 1,
    regenEpoch: Number(current.regenEpoch || 0) + 1,

    ...patch,

    events: [
      ...(Array.isArray(current.events) ? current.events : []),
      {
        at: now,
        patch: sanitizeTaskEventPatch({
          action: "regenerate.reset",
          status: TaskStatus.pending,
          regenEpoch: Number(current.regenEpoch || 0) + 1,
          ...patch
        })
      }
    ]
  };

  tasks.set(String(id), next);
  return next;
},
```

## Lưu ý rất quan trọng

### Không nên giữ lại output/generated `mediaIds` cũ

Nếu task của bạn đang dùng `mediaIds` vừa cho **reference media**, vừa cho **generated output media**, thì nên tách rõ:

- `refMediaIds` → reference input
- `outputMediaIds` → generated outputs

Trong regenerate reset:

- **giữ** `refMediaIds`
- **xóa** `outputMediaIds`
- **xóa** `outputs`

Nếu `mediaIds` hiện đang bị reuse cho output, bạn nên xem lại logic đó. Nếu chưa refactor kịp, thì regenerate reset phải xóa phần `mediaIds` output cũ để tránh thumbnail cũ quay lại.

---

# 8) CODE — `src/background/service-worker.js`

## Bước 1: thêm helper purge runtime artifacts cũ

Thêm helper mới:

```js
function purgeTaskRuntimeArtifacts(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return 0;

  const before = Array.isArray(runtimeState.events) ? runtimeState.events.length : 0;

  runtimeState.events = (Array.isArray(runtimeState.events) ? runtimeState.events : []).filter((event) => {
    const eventTaskId = String(event?.taskId || "").trim();
    if (eventTaskId !== id) return true;

    const type = String(event?.type || "");
    return ![
      "media.download",
      "media.download.error",
      "media.download.filename_suggest",
      "media.download.dedupe_blocked",
      "queue.download_reconcile",
      "queue.download_repair",
      "queue.flow_generation_feed",
      "queue.flow_generation_feed.unmatched",
      "flow_generation_response"
    ].includes(type);
  });

  const after = runtimeState.events.length;
  return Math.max(0, before - after);
}
```

> Nếu repo của bạn còn giữ pending native filename map / pending download map, cũng nên purge theo `taskId` ở đây luôn.

Ví dụ nếu bạn có các map kiểu:

```js
pendingNativeDownloadByMediaId
pendingNativeDownloadByDownloadId
```

thì cũng nên xóa các entry liên quan tới task này.

---

## Bước 2: thêm handler cho `QueueResetTask`

Tìm chỗ `chrome.runtime.onMessage` / switch / if-else đang xử lý:

- `QueueAddJob`
- `QueueStart`
- `QueueStop`
- `QueueClear`
- `QueueRemove`

Thêm case mới:

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

  // 1) purge stale runtime artifacts trước
  const purgedEvents = purgeTaskRuntimeArtifacts(taskId);

  // 2) compute expected counts theo mode
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

  // 3) reset task runtime state
  const resetTask = ledger.resetTaskForRegenerate(taskId, expectedPatch);

  // 4) persist queue
  await persistQueueState();

  recordEvent({
    type: "queue.task.regenerate",
    taskId,
    status: resetTask.status,
    mode: resetTask.mode,
    regenerateCount: Number(resetTask.regenerateCount || 1),
    regenEpoch: Number(resetTask.regenEpoch || 1),
    purgedEvents
  });

  // 5) restart queue if needed
  if (!queueRunning) {
    runQueue();
  }

  return {
    ok: true,
    task: resetTask,
    queue: {
      tasks: ledger.snapshot()
    },
    queueRunning: true
  };
}
```

---

## Bước 3: bảo vệ luồng repair / reconcile khỏi event cũ

Nếu bạn muốn fix chắc tay hơn, hãy nâng cấp thêm 1 lớp:

- mỗi task có `regenEpoch`
- khi record download events / generation events cho task đó, gắn thêm `regenEpoch`
- lúc reconcile, chỉ nhận event nếu `event.regenEpoch === task.regenEpoch`

Đây là bản fix **best practice**.

Nhưng nếu bạn cần fix nhanh, thì chỉ cần:

- `purgeTaskRuntimeArtifacts(taskId)`
- `resetTaskForRegenerate(...)`

là đã giải quyết được phần lớn vấn đề.

---

## Bước 4: re-arm auto-download

Sau khi task hoàn thành output mới, background hiện đã có nhánh gọi:

```js
if (shouldAttemptAutoDownloadForTask(after)) {
  await autoDownloadCompletedTasks([task.id], endpointKind);
}
```

Phần này giữ nguyên, nhưng bạn phải đảm bảo rằng task sau reset:

- vẫn giữ `task.download.enabled === true`
- không còn `downloadedMediaIds` cũ
- không còn `downloadErrorMediaIds` cũ
- `outputs` mới được set lại đúng

Nếu cần, sau reset bạn có thể ép thêm:

```js
const resetTask = ledger.resetTaskForRegenerate(taskId, {
  ...expectedPatch,
  download: {
    ...(task.download || {}),
    enabled: task?.download?.enabled !== false
  }
});
```

---

# 9) CODE — `src/sidepanel/app.js`

## Code cũ

Hiện `regenerateTask(taskId)` đang lấy `sourceTask`, build `regeneratedJob`, rồi gọi:

```js
const { added } = await enqueueJobs([regeneratedJob], { modeOverride: mode });
```

Đây là nguyên nhân trực tiếp tạo task/queue mới.

---

## Code mới

Thay toàn bộ `regenerateTask(taskId)` bằng:

```js
async function regenerateTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;

  const sourceTask = (state.queue.items || []).find(
    (item) => String(item?.id || "") === id
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

  state.ui.activeRoute = "live";
  state.ui.galleryTab =
    String(sourceTask.mode || "") === FLOW_MODES.textToImage ? "images" : "videos";

  appendLog("info", "queue", `Regenerate reset task ${id.slice(0, 8)}.`);

  await persistState();
  render();

  scheduleRuntimeRefresh(0);
  scheduleLiveQueueRefreshBurst();
}
```

---

# 10) CODE — `src/sidepanel/views.js`

## Mục tiêu

Ngay sau khi reset task:

- nếu task chưa có output mới
- UI **không được dùng thumbnail cũ**
- phải show placeholder/icon loading

## Ý tưởng sửa

Ở chỗ render card/live-queue item, thay logic thumbnail kiểu “fallback hơi rộng” bằng logic chặt hơn:

### Anti-pattern dễ gây lỗi

```js
const thumbUrl =
  task.outputs?.[0]?.thumbnailUrl ||
  task.outputs?.[0]?.imageUrl ||
  task.thumbnailUrl ||
  task.previewUrl ||
  previousThumbUrl;
```

### Nên sửa thành

```js
const firstOutput = Array.isArray(task.outputs) ? task.outputs[0] : null;

const thumbUrl =
  firstOutput?.thumbnailUrl ||
  firstOutput?.imageUrl ||
  firstOutput?.mediaUrl ||
  "";

const hasFreshOutput = Boolean(
  Array.isArray(task.outputs) && task.outputs.length > 0
);
```

Render:

```js
if (hasFreshOutput && thumbUrl) {
  // render image thumbnail
} else {
  // render placeholder icon / empty thumb
}
```

## Rule quan trọng

Đối với task đang ở các trạng thái:

- `pending`
- `submitting`
- `generating`
- `downloading` (sau reset, trước khi output mới về)

thì UI chỉ được render thumbnail nếu task thật sự có `outputs` mới.

Không fallback sang thumbnail cũ lưu đâu đó trong task state.

---

# 11) Optional fix tốt hơn — Dùng `regenEpoch`

Nếu bạn muốn hệ thống thật sự sạch và ổn định lâu dài, hãy thêm `regenEpoch`.

## Ý tưởng

Mỗi lần regenerate cùng task:

- tăng `task.regenEpoch += 1`
- mọi event mới của task đó phải record kèm `regenEpoch`
- mọi reconcile chỉ nhận event cùng `regenEpoch`

## Lợi ích

- Không sợ event cũ dính lại
- Không cần phụ thuộc hoàn toàn vào purge event
- Debug dễ hơn vì biết output nào thuộc lần generate thứ mấy

---

# 12) Checklist test thủ công

## Test 1 — thumbnail cũ phải biến mất ngay

```txt
1. Tạo 1 task ảnh thành công.
2. Task đang có thumbnail đại diện.
3. Bấm regenerate.
4. Ngay lập tức thumbnail cũ phải biến mất.
5. UI hiển thị placeholder / loading state.
```

### Expected

- Không còn ảnh cũ trên card task.
- Không còn preview cũ trong live queue.

---

## Test 2 — không tạo task mới

```txt
1. Có Task A complete.
2. Bấm regenerate.
3. Quan sát queue.
```

### Expected

- Không xuất hiện Task B.
- Chỉ có Task A đổi về `pending` -> `submitting` -> `generating`.

---

## Test 3 — output counter phải sạch

```txt
1. Có task ảnh repeatCount = 5.
2. Regenerate task đó.
```

### Expected

- Khu vực Saving outputs phải bắt đầu từ `0/5`.
- Không được có kiểu `6/5`, `7/5`.

Nếu vẫn thấy `6/5` hoặc số lớn hơn expected:

- bạn chưa clear `outputs` / `outputMediaIds`
- hoặc chưa purge `runtimeState.events` cũ của task đó

---

## Test 4 — auto-download ảnh mới phải chạy lại

```txt
1. Task hoàn thành output mới.
2. Theo dõi Saving outputs.
```

### Expected

- `downloadedCount` tăng từ 0 lên đúng số output mới.
- `downloadedMediaIds` chỉ chứa media của run mới.
- Không bị stuck ở Saving outputs.

---

## Test 5 — reload extension vẫn không nhiễm state cũ

```txt
1. Regenerate task.
2. Trong lúc generating hoặc sau complete, reload sidepanel / reopen extension.
```

### Expected

- Queue state vẫn đúng.
- Không xuất hiện lại thumbnail cũ.
- Không re-attach old download errors.

---

# 13) Edge cases cần chú ý

## Edge case A — task vừa regenerate vừa đang download

Nếu user bấm regenerate đúng lúc task đang `downloading`, bạn nên:

- chặn regenerate khi task active
- hoặc cho regenerate nhưng purge toàn bộ pending download mapping cũ

Khuyến nghị an toàn:

```js
if (["submitting", "generating", "downloading"].includes(task.status)) {
  // ask confirm hoặc chặn
}
```

---

## Edge case B — task mất `download.enabled`

Nếu sau reset task không còn `download.enabled`, auto-download sẽ không chạy.

=> regenerate reset phải **preserve** config download.

---

## Edge case C — cùng `taskId`, nhưng reconcile vẫn đọc event cũ

Nếu bạn đã purge event mà vẫn bị lỗi lặp:

- kiểm tra còn cache map nào khác trong background không
- ví dụ pending native filename map, in-flight download map, mediaId-to-task map

---

# 14) Prompt ngắn cho Vibe Code

Bạn có thể đưa prompt này cho AI/codex:

```md
Read these files first:
- src/sidepanel/app.js
- src/background/service-worker.js
- src/core/queue/task-ledger.js
- src/core/contracts/messages.js
- src/sidepanel/views.js

Goal:
Fix regenerate for image tasks so clicking reload/regenerate reuses the SAME task instead of creating a new queue item.

Requirements:
1. Replace regenerate behavior in sidepanel so it sends QueueResetTask instead of enqueueing a new job.
2. Add QueueResetTask message type.
3. Add a task-ledger helper resetTaskForRegenerate(taskId, patch) that resets runtime state but preserves the original task inputs and download config.
4. When resetting a task, clear old outputs, outputMediaIds, statusRows, submitOutputRows, downloadedMediaIds, skippedDownloadMediaIds, downloadErrorMediaIds, downloadedCount, foundImages/foundVideos, failure state, and any preview/thumbnail state.
5. In the background service worker, add a QueueResetTask handler that:
   - finds the task,
   - purges stale runtime events/artifacts for that taskId,
   - resets the task via resetTaskForRegenerate,
   - persists queue state,
   - restarts the queue if needed.
6. IMPORTANT: purge old runtime events for the same taskId (media.download, media.download.error, media.download.filename_suggest, queue.download_reconcile, queue.download_repair, queue.flow_generation_feed, flow_generation_response) so old outputs and stale download results do not contaminate the regenerated run.
7. Update the live queue UI rendering so if a task has no fresh outputs after reset, the old thumbnail is NOT shown; render a placeholder instead.
8. Preserve task.download.enabled so auto-download can run again on the new outputs.
9. Make sure after regeneration the saving counter starts cleanly (for example 0/5, not 6/5).

Do not create a new task or queue item.
Regenerate must run in-place on the existing task.
```

---

# 15) Kết luận ngắn

Bạn đang có **2 lỗi gắn chặt với nhau**:

1. regenerate chưa thật sự reset task cũ
2. stale output/download state vẫn còn bám vào cùng `taskId`

Nếu chỉ sửa `regenerateTask()` mà **không purge old task state + runtime events**, bạn vẫn sẽ gặp:

- ảnh đại diện cũ không mất
- counter saving sai (`6/5`)
- download ảnh mới không chạy đúng

=> Bản fix đúng là:

- `QueueResetTask`
- `resetTaskForRegenerate()`
- `purgeTaskRuntimeArtifacts(taskId)`
- UI placeholder fallback
- preserve & re-arm auto-download

---

Nếu bạn muốn, ở tin nhắn tiếp theo mình có thể làm tiếp cho bạn **file `.md` version 2 theo đúng format “Code Cần Sửa -> Code Mới” chi tiết hơn nữa cho từng file**, theo kiểu copy-paste từng block để bạn dùng thẳng trong VS Code/Codex.
