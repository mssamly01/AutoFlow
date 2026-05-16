# AutoFlow — Chèn Reference Chip Inline Ngay Sau Tên Character Trong Google Flow Prompt Box

## Mục tiêu

Google Flow tạo **reference chip** bằng thao tác:

```txt
focus prompt box
→ gõ @
→ bảng mention/reference hiện ra
→ search tên ảnh
→ chọn ảnh
→ chip được chèn tại vị trí con trỏ hiện tại
```

Bạn muốn chip nằm **ngay sau tên nhân vật**, ví dụ prompt gốc:

```txt
Lục Nhược Linh (Gender: Female, Age: Early 20s, Height: 165cm, Face: Oval face, delicate features, large expressive eyes, Hair: Long, silky black hair worn down, Eyes: Dark brown, Posture: sitting with hands clasped, Outfit: simple modest dress). Foreground: edge of the leather armchair. Midground: Lục Nhược Linh sitting. Background: blurred living room with hints of luxury decor and a family portrait on the wall. no text, no speech bubbles, no captions, no subtitles, no watermark, no logo.
```

Kết quả mong muốn trong prompt box Google Flow:

```txt
Lục Nhược Linh [chip: Lục Nhược Linh.jpeg] (Gender: Female, Age: Early 20s, Height: 165cm, Face: Oval face, delicate features, large expressive eyes, Hair: Long, silky black hair worn down, Eyes: Dark brown, Posture: sitting with hands clasped, Outfit: simple modest dress). Foreground: edge of the leather armchair. Midground: Lục Nhược Linh sitting. Background: blurred living room with hints of luxury decor and a family portrait on the wall. no text, no speech bubbles, no captions, no subtitles, no watermark, no logo.
```

---

# 1. Nguyên tắc quan trọng

## Không nhập full prompt một lần

Sai:

```js
await typePrompt(task.prompt);
await insertReferenceChipByMention("Lục Nhược Linh.jpeg");
```

Vì như vậy chip sẽ nằm cuối prompt hoặc đầu prompt, không nằm đúng sau tên character.

## Phải nhập prompt theo từng đoạn

Đúng:

```txt
1. Clear composer
2. Type phần trước tên character
3. Type tên character
4. Type space
5. Gõ @
6. Search ảnh "Lục Nhược Linh.jpeg"
7. Chọn mention result
8. Wait chip "Lục Nhược Linh.jpeg"
9. Type space
10. Type phần còn lại của prompt
11. Submit
```

---

# 2. Schema tương thích với AutoFlow hiện tại

Không tạo field mới:

```js
referenceImages
characterReferenceImages
```

Dùng schema hiện tại:

```js
task.refInputs
task.refMediaIds
```

Mỗi `refInput` cần có:

```js
{
  characterName: "Lục Nhược Linh",
  name: "Lục Nhược Linh.jpeg",
  fileName: "Lục Nhược Linh.jpeg"
}
```

Với cơ chế `@ mention`, thứ quan trọng nhất là:

```txt
characterName
fileName/name
```

vì Google Flow sẽ search ảnh đã có trong picker theo tên.

---

# 3. Files cần sửa

Ưu tiên:

```txt
src/page/page-hook.js
src/content/page-bridge.js
src/core/queue/executor.js
src/background/service-worker.js
```

Nếu task chưa có `characterName` / `refInputs` đúng, sửa thêm:

```txt
src/sidepanel/app.js
src/sidepanel/views.js
src/core/gallery/character-ref-matcher.js
src/core/gallery/scene-builder.js
```

Nếu chưa có file matcher thì tạo:

```txt
src/core/gallery/character-ref-matcher.js
```

---

# 4. Tạo helper normalize/match character ref

## File mới

```txt
src/core/gallery/character-ref-matcher.js
```

## Code mới

```js
export function normalizeCharacterRefKey(value = "") {
  return String(value || "")
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\.(png|jpe?g|webp|gif)$/i, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ");
}

export function getRefInputFileName(ref = {}) {
  return String(
    ref.fileName ||
    ref.name ||
    ref.filename ||
    ref.originalName ||
    ref.displayName ||
    ""
  ).trim();
}

export function inferFirstCharacterNameFromPrompt(prompt = "") {
  const text = String(prompt || "").trim();

  // "Lục Nhược Linh (Gender: Female...)" => "Lục Nhược Linh"
  const match = text.match(/^(.{1,80}?)\s*\(/u);
  if (match?.[1]) {
    return match[1].trim().normalize("NFC").replace(/\s+/g, " ");
  }

  return "";
}

export function getTaskCharacterNames(task = {}) {
  if (Array.isArray(task.characters) && task.characters.length) {
    return task.characters
      .map((name) => String(name || "").trim().normalize("NFC"))
      .filter(Boolean);
  }

  if (Array.isArray(task.characterNames) && task.characterNames.length) {
    return task.characterNames
      .map((name) => String(name || "").trim().normalize("NFC"))
      .filter(Boolean);
  }

  if (task.characterName) {
    return [String(task.characterName).trim().normalize("NFC")].filter(Boolean);
  }

  const inferred = inferFirstCharacterNameFromPrompt(task.prompt || "");
  return inferred ? [inferred] : [];
}

export function refInputMatchesCharacter(ref = {}, characterName = "") {
  const refKey = normalizeCharacterRefKey(getRefInputFileName(ref));
  const charKey = normalizeCharacterRefKey(characterName);
  return Boolean(refKey && charKey && refKey === charKey);
}

export function normalizeTaskRefInputs(task = {}) {
  const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];

  return refInputs.map((ref) => {
    const fileName = getRefInputFileName(ref);

    return {
      ...ref,
      name: fileName || ref.name,
      fileName: fileName || ref.fileName,
      characterName:
        ref.characterName ||
        ref.character ||
        normalizeCharacterRefKey(fileName)
    };
  });
}

export function ensureTaskInlineCharacterRefs(task = {}, allRefInputs = []) {
  const characters = getTaskCharacterNames(task);

  if (!characters.length) {
    return {
      ...task,
      refInputs: normalizeTaskRefInputs(task)
    };
  }

  const existingRefs = normalizeTaskRefInputs(task);

  if (existingRefs.length) {
    return {
      ...task,
      characters,
      characterName: task.characterName || characters[0],
      refInputs: existingRefs.map((ref) => {
        const matchedCharacter =
          ref.characterName ||
          characters.find((name) => refInputMatchesCharacter(ref, name)) ||
          characters[0];

        return {
          ...ref,
          characterName: matchedCharacter
        };
      })
    };
  }

  const availableRefs = Array.isArray(allRefInputs) ? allRefInputs : [];
  const picked = [];

  for (const characterName of characters) {
    const matched = availableRefs.find((ref) =>
      refInputMatchesCharacter(ref, characterName)
    );

    if (!matched) {
      throw new Error(`Missing reference image for character: ${characterName}`);
    }

    const fileName = getRefInputFileName(matched) || `${characterName}.jpeg`;

    picked.push({
      ...matched,
      characterName,
      name: fileName,
      fileName
    });
  }

  return {
    ...task,
    characters,
    characterName: task.characterName || characters[0],
    refInputs: picked
  };
}
```

---

# 5. Sửa nơi build task

Tìm nơi tạo task queue trong:

```txt
src/sidepanel/app.js
src/sidepanel/views.js
src/core/gallery/scene-builder.js
```

## Code cũ mẫu

```js
const task = {
  id: createTaskId(),
  mode: FlowTaskMode.textToImage,
  prompt: row.prompt,
  refInputs: selectedRefInputs,
  refMediaIds: []
};

tasks.push(task);
```

## Code mới

Import:

```js
import {
  ensureTaskInlineCharacterRefs,
  inferFirstCharacterNameFromPrompt
} from "../core/gallery/character-ref-matcher.js";
```

Nếu file đang ở cấp folder khác, chỉnh lại relative path.

Sửa build task:

```js
const baseTask = {
  id: createTaskId(),
  mode: FlowTaskMode.textToImage,
  prompt: row.prompt,
  characterName:
    row.characterName ||
    inferFirstCharacterNameFromPrompt(row.prompt),
  characters:
    Array.isArray(row.characters) && row.characters.length
      ? row.characters
      : undefined,
  refInputs: Array.isArray(row.refInputs) ? row.refInputs : [],
  refMediaIds: Array.isArray(row.refMediaIds) ? row.refMediaIds : []
};

const task = ensureTaskInlineCharacterRefs(
  baseTask,
  allAvailableRefInputs
);

tasks.push(task);
```

`allAvailableRefInputs` là danh sách ảnh tham chiếu user đã nạp vào app. Mỗi item ít nhất cần:

```js
{
  name: "Lục Nhược Linh.jpeg",
  fileName: "Lục Nhược Linh.jpeg"
}
```

---

# 6. Nếu chưa có allAvailableRefInputs

Thêm helper trong sidepanel/app hoặc nơi quản lý state:

```js
function collectAvailableRefInputs(state = {}) {
  const candidates = [
    ...(Array.isArray(state.refInputs) ? state.refInputs : []),
    ...(Array.isArray(state.referenceInputs) ? state.referenceInputs : []),
    ...(Array.isArray(state.uploadedRefs) ? state.uploadedRefs : []),
    ...(Array.isArray(state.characterRefs) ? state.characterRefs : [])
  ];

  return candidates
    .filter(Boolean)
    .map((ref) => {
      const fileName = String(
        ref.fileName ||
        ref.name ||
        ref.filename ||
        ref.originalName ||
        ""
      ).trim();

      return {
        ...ref,
        name: fileName,
        fileName,
        mimeType: ref.mimeType || ref.type || "image/jpeg"
      };
    })
    .filter((ref) => ref.fileName);
}
```

Dùng:

```js
const allAvailableRefInputs = collectAvailableRefInputs(appState);
```

---

# 7. Sửa page-hook.js — thêm hàm thao tác prompt box

## File cần sửa

```txt
src/page/page-hook.js
```

Thêm các helper sau.

## Code mới

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomText(value = "") {
  return String(value || "")
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stripImageExtension(value = "") {
  return String(value || "").replace(/\.(png|jpe?g|webp|gif)$/i, "");
}

function getPromptInput() {
  return (
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector('[role="textbox"]') ||
    document.querySelector("textarea")
  );
}

function getComposerRoot() {
  const input = getPromptInput();

  return (
    input?.closest("form") ||
    input?.closest("[role='dialog']") ||
    input?.closest("main") ||
    input?.parentElement ||
    document.body
  );
}

async function typeTextIntoPrompt(text = "") {
  const input = getPromptInput();

  if (!input) {
    throw new Error("Prompt input not found");
  }

  input.focus();

  const value = String(text || "");
  if (!value) return;

  const ok = document.execCommand?.("insertText", false, value);

  if (!ok && "value" in input) {
    input.value = `${input.value || ""}${value}`;
  }

  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    })
  );

  await sleep(30);
}
```

---

# 8. Sửa page-hook.js — mention picker

Thêm các hàm tìm mention panel/result.

```js
async function waitForMentionPanel(timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const nodes = [
      ...document.querySelectorAll(
        "[role='listbox'], [role='menu'], [role='dialog'], div"
      )
    ];

    const panel = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 40) return false;

      const text = normalizeDomText(node.textContent || "");
      if (!text) return false;

      return true;
    });

    if (panel) return panel;

    await sleep(100);
  }

  throw new Error("Mention panel not found after typing @");
}

function findMentionResultByName(fileName) {
  const expectedFull = normalizeDomText(fileName);
  const expectedBase = normalizeDomText(stripImageExtension(fileName));

  const nodes = [
    ...document.querySelectorAll(
      "[role='option'], [role='menuitem'], button, div, span, [role='button']"
    )
  ];

  return (
    nodes.find((node) => {
      const text = normalizeDomText(node.textContent || "");
      if (!text) return false;

      const rect = node.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 16) return false;

      return text.includes(expectedFull) || text.includes(expectedBase);
    }) || null
  );
}

async function waitForMentionResult(fileName, timeoutMs = 8000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = findMentionResultByName(fileName);
    if (result) return result;

    await sleep(150);
  }

  throw new Error(`Mention result not found: ${fileName}`);
}

function findReferenceChipByFileName(fileName, root = getComposerRoot()) {
  const expectedFull = normalizeDomText(fileName);
  const expectedBase = normalizeDomText(stripImageExtension(fileName));

  const nodes = [
    ...root.querySelectorAll("button, div, span, [role='button']")
  ];

  return (
    nodes.find((node) => {
      const text = normalizeDomText(node.textContent || "");
      if (!text) return false;

      const rect = node.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 16) return false;

      return text.includes(expectedFull) || text.includes(expectedBase);
    }) || null
  );
}

async function waitForReferenceChip(fileName, timeoutMs = 10000) {
  const root = getComposerRoot();
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const chip = findReferenceChipByFileName(fileName, root);
    if (chip) {
      return {
        ok: true,
        fileName,
        text: chip.textContent || ""
      };
    }

    await sleep(150);
  }

  throw new Error(`Reference chip not found: ${fileName}`);
}
```

---

# 9. Sửa page-hook.js — chèn chip tại cursor hiện tại

Quan trọng: hàm này **không được clear composer**, không được nhập full prompt. Nó chỉ gõ `@` tại vị trí cursor hiện tại.

```js
async function insertReferenceChipByMention(fileName) {
  const input = getPromptInput();

  if (!input) {
    throw new Error("Prompt input not found");
  }

  input.focus();

  await typeTextIntoPrompt("@");
  await waitForMentionPanel();

  const searchText = stripImageExtension(fileName);

  await typeTextIntoPrompt(searchText);

  const result = await waitForMentionResult(fileName);

  result.click();

  const chip = await waitForReferenceChip(fileName);

  return {
    ok: true,
    fileName,
    chip
  };
}
```

Nếu Google Flow cần Enter thay vì click, dùng fallback:

```js
async function selectMentionResult(result) {
  result.click();
  await sleep(150);

  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true
    })
  );
}
```

Rồi thay:

```js
result.click();
```

bằng:

```js
await selectMentionResult(result);
```

---

# 10. Sửa page-hook.js — split prompt quanh character

Thêm helper:

```js
function splitPromptAroundCharacter(prompt, characterName) {
  const text = String(prompt || "");
  const name = String(characterName || "").trim();

  if (!text || !name) {
    return {
      found: false,
      before: "",
      characterText: "",
      after: text
    };
  }

  const index = text.indexOf(name);

  if (index < 0) {
    return {
      found: false,
      before: "",
      characterText: "",
      after: text
    };
  }

  return {
    found: true,
    before: text.slice(0, index),
    characterText: text.slice(index, index + name.length),
    after: text.slice(index + name.length)
  };
}

function getRefFileName(ref = {}) {
  return String(
    ref.fileName ||
    ref.name ||
    ref.filename ||
    ref.originalName ||
    ""
  ).trim();
}
```

---

# 11. Sửa page-hook.js — nhập prompt có chip sau character

## Một character

```js
async function typePromptWithSingleCharacterChip({ prompt, refInput }) {
  const characterName = String(refInput?.characterName || "").trim();
  const fileName = getRefFileName(refInput);

  if (!characterName || !fileName) {
    await typeTextIntoPrompt(prompt);
    return {
      ok: true,
      inserted: 0,
      reason: "missing_character_or_filename"
    };
  }

  const parts = splitPromptAroundCharacter(prompt, characterName);

  if (!parts.found) {
    throw new Error(`Character name not found in prompt: ${characterName}`);
  }

  if (parts.before) {
    await typeTextIntoPrompt(parts.before);
  }

  await typeTextIntoPrompt(parts.characterText);
  await typeTextIntoPrompt(" ");

  const outcome = await insertReferenceChipByMention(fileName);

  await typeTextIntoPrompt(" ");

  if (parts.after) {
    await typeTextIntoPrompt(parts.after.trimStart());
  }

  return {
    ok: true,
    inserted: 1,
    refs: [outcome]
  };
}
```

---

# 12. Sửa page-hook.js — nhiều character

Nếu task có nhiều refInputs, cần chèn theo thứ tự character xuất hiện trong prompt.

```js
async function typePromptWithInlineCharacterChips(task = {}) {
  const prompt = String(task.prompt || "");
  const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];

  if (!refInputs.length) {
    await typeTextIntoPrompt(prompt);
    return {
      ok: true,
      inserted: 0,
      reason: "no_ref_inputs"
    };
  }

  const matches = refInputs
    .map((ref) => {
      const characterName = String(ref.characterName || "").trim();
      const fileName = getRefFileName(ref);
      const index = characterName ? prompt.indexOf(characterName) : -1;

      return {
        ref,
        characterName,
        fileName,
        index
      };
    })
    .filter((item) => item.characterName && item.fileName && item.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (!matches.length) {
    throw new Error("No character reference names found in prompt");
  }

  let cursor = 0;
  const insertedRefs = [];

  for (const match of matches) {
    const { characterName, fileName } = match;

    if (match.index < cursor) {
      continue;
    }

    const before = prompt.slice(cursor, match.index);
    const characterText = prompt.slice(
      match.index,
      match.index + characterName.length
    );

    if (before) {
      await typeTextIntoPrompt(before);
    }

    await typeTextIntoPrompt(characterText);
    await typeTextIntoPrompt(" ");

    const outcome = await insertReferenceChipByMention(fileName);
    insertedRefs.push(outcome);

    await typeTextIntoPrompt(" ");

    cursor = match.index + characterName.length;
  }

  const rest = prompt.slice(cursor);

  if (rest) {
    await typeTextIntoPrompt(rest.trimStart());
  }

  return {
    ok: true,
    inserted: insertedRefs.length,
    refs: insertedRefs
  };
}
```

---

# 13. Sửa submit flow trong page-hook.js

Tìm hàm submit hiện tại.

## Code cũ mẫu

```js
async function submitTask(task) {
  await clearComposer();
  await typePrompt(task.prompt);
  await clickSubmit();

  return {
    ok: true
  };
}
```

## Code mới

```js
async function submitTask(task) {
  await clearComposer();

  let inlineChipOutcome = null;

  if (Array.isArray(task.refInputs) && task.refInputs.length) {
    inlineChipOutcome = await typePromptWithInlineCharacterChips(task);
  } else {
    await typeTextIntoPrompt(task.prompt || "");
  }

  await clickSubmit();

  return {
    ok: true,
    inlineChipOutcome
  };
}
```

---

# 14. Sửa content/page-bridge nếu cần message action

Nếu page-hook đang nhận command `FLOW_DOM_SUBMIT`, giữ command đó nhưng đảm bảo payload truyền full task.

## Code cũ dễ lỗi

```js
window.postMessage({
  type: "FLOW_DOM_SUBMIT",
  prompt: task.prompt
});
```

## Code mới

```js
window.postMessage({
  type: "FLOW_DOM_SUBMIT",
  task: {
    ...task,
    refInputs: Array.isArray(task.refInputs) ? task.refInputs : []
  }
});
```

Trong page hook handler:

```js
if (message.type === "FLOW_DOM_SUBMIT") {
  return await submitTask(message.task || {});
}
```

---

# 15. Sửa executor.js — đảm bảo task.refInputs còn đủ trước submit

Trong `src/core/queue/executor.js`, tìm hàm gọi DOM submit:

```js
domSubmitter.submitTask(task, ...)
```

## Code cũ mẫu

```js
const submitOutcome = await domSubmitter.submitTask(task, {
  signal
});
```

## Code mới

```js
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
        characterName: ref.characterName || task.characterName || ""
      };
    })
  };
}

const taskForSubmit = normalizeSubmitTaskRefs(task);

const submitOutcome = await domSubmitter.submitTask(taskForSubmit, {
  signal
});
```

---

# 16. Submit lock khi Overlap bật

Vì bạn đang dùng Overlap, toàn bộ đoạn sau phải nằm trong lock:

```txt
clear composer
type prompt chunks
insert @ chip
wait chip
submit
```

Không chỉ lock mỗi `clickSubmit`.

## Code cũ dễ lỗi

```js
await clearComposer();
await typePromptWithInlineCharacterChips(task);
await withSubmitLock(() => clickSubmit());
```

Sai vì Task 2 vẫn có thể chen vào lúc Task 1 đang type/chèn chip.

## Code mới đúng

```js
const submitOutcome = await withSubmitLock(async () => {
  return await domSubmitter.submitTask(taskForSubmit, {
    signal
  });
});
```

---

# 17. Debug log cần thêm

Thêm log để debug nhanh:

```js
console.info("[AutoFlow][InlineRef] submit task", {
  taskId: task.id,
  prompt: task.prompt,
  refInputs: task.refInputs?.map((ref) => ({
    characterName: ref.characterName,
    fileName: ref.fileName || ref.name
  }))
});

console.info("[AutoFlow][InlineRef] type character", {
  characterName,
  fileName
});

console.info("[AutoFlow][InlineRef] mention search", {
  fileName,
  searchText
});

console.info("[AutoFlow][InlineRef] chip inserted", {
  fileName
});

console.info("[AutoFlow][InlineRef] submit outcome", inlineChipOutcome);
```

---

# 18. Edge cases

## Case 1 — Prompt không có tên character

Ví dụ:

```txt
A young woman sitting in a luxury living room...
```

nhưng `refInput.characterName = "Lục Nhược Linh"`.

Nên throw:

```txt
Character name not found in prompt: Lục Nhược Linh
```

Không nên tự chèn chip vào đầu prompt vì user yêu cầu chip nằm sau tên character.

## Case 2 — Không tìm thấy mention result

Throw:

```txt
Mention result not found: Lục Nhược Linh.jpeg
```

Nguyên nhân có thể:
- ảnh chưa có trong Google Flow picker
- tên file không đúng
- Google Flow chưa load asset
- search cần base name thay vì full filename

## Case 3 — Chọn result nhưng chip không hiện

Throw:

```txt
Reference chip not found: Lục Nhược Linh.jpeg
```

Nếu Flow chỉ hiển thị base name, hàm `findReferenceChipByFileName()` đã có fallback base name.

---

# 19. Manual test checklist

## Test 1 — Một character

Task:

```js
{
  prompt: "Lục Nhược Linh (Gender: Female, Age: Early 20s...). Foreground...",
  refInputs: [
    {
      characterName: "Lục Nhược Linh",
      fileName: "Lục Nhược Linh.jpeg",
      name: "Lục Nhược Linh.jpeg"
    }
  ]
}
```

Kỳ vọng trong prompt box:

```txt
Lục Nhược Linh [chip: Lục Nhược Linh.jpeg] (Gender: Female, Age: Early 20s...). Foreground...
```

## Test 2 — Hai character

Task:

```js
{
  prompt: "Lục Nhược Linh and Tiêu Viêm are sitting in a luxury living room.",
  refInputs: [
    {
      characterName: "Lục Nhược Linh",
      fileName: "Lục Nhược Linh.jpeg"
    },
    {
      characterName: "Tiêu Viêm",
      fileName: "Tiêu Viêm.jpeg"
    }
  ]
}
```

Kỳ vọng:

```txt
Lục Nhược Linh [chip: Lục Nhược Linh.jpeg] and Tiêu Viêm [chip: Tiêu Viêm.jpeg] are sitting in a luxury living room.
```

## Test 3 — Sai tên character

Task:

```js
{
  prompt: "A woman is sitting in a chair.",
  refInputs: [
    {
      characterName: "Lục Nhược Linh",
      fileName: "Lục Nhược Linh.jpeg"
    }
  ]
}
```

Kỳ vọng:

```txt
Character name not found in prompt: Lục Nhược Linh
```

## Test 4 — Không có refInputs

Task:

```js
{
  prompt: "A luxury living room with soft light.",
  refInputs: []
}
```

Kỳ vọng:

```txt
Nhập prompt bình thường, không chèn chip.
```

## Test 5 — Overlap

Kỳ vọng:

```txt
Task 1 clear/type/chip/submit xong
Task 2 mới được clear/type/chip/submit
Không có chuyện Task 2 gõ @ vào prompt box của Task 1
```

---

# 20. Prompt đưa cho Vibe Code / Codex

```txt
Hãy đọc repo AutoFlow mới nhất trước khi sửa.

Tôi muốn sửa logic reference chip của Google Flow.

Hiện Google Flow không thêm chip bằng upload file input. Cách đúng là:
- focus prompt box
- gõ @
- bảng mention/reference hiện ra
- search tên ảnh
- chọn ảnh
- chip được chèn tại vị trí cursor

Yêu cầu chính:
Tôi muốn chip reference nằm inline ngay sau tên character trong prompt.

Ví dụ prompt:
Lục Nhược Linh (Gender: Female, Age: Early 20s...). Foreground...

Task có:
refInputs: [
  {
    characterName: "Lục Nhược Linh",
    name: "Lục Nhược Linh.jpeg",
    fileName: "Lục Nhược Linh.jpeg"
  }
]

Kết quả trong prompt box phải là:
Lục Nhược Linh [chip: Lục Nhược Linh.jpeg] (Gender: Female, Age: Early 20s...). Foreground...

Yêu cầu code:
1. Không dùng upload file input cho reference chip.
2. Không tạo schema mới referenceImages. Dùng task.refInputs hiện có.
3. Không nhập full prompt một lần nếu có refInputs.
4. Split prompt quanh characterName.
5. Nhập theo thứ tự:
   - clear composer
   - type phần trước character
   - type characterName
   - type space
   - type @
   - wait mention panel
   - search fileName hoặc baseName
   - click mention result đúng fileName
   - wait chip đúng fileName
   - type space
   - type phần còn lại của prompt
   - submit
6. Với nhiều refInputs, chèn chip theo thứ tự characterName xuất hiện trong prompt.
7. Hàm insertReferenceChipByMention(fileName) không được clear composer. Nó chỉ chèn chip tại vị trí cursor hiện tại.
8. Nếu không tìm thấy characterName trong prompt, throw:
   Character name not found in prompt: <characterName>
9. Nếu không tìm thấy mention result, throw:
   Mention result not found: <fileName>
10. Nếu chọn result xong mà chip không hiện, throw:
   Reference chip not found: <fileName>
11. Khi Overlap bật, toàn bộ clear composer + type prompt chunks + insert chip + wait chip + submit phải nằm trong submit lock.
12. Thêm debug log prefix:
   [AutoFlow][InlineRef]

Các file ưu tiên sửa:
- src/page/page-hook.js
- src/content/page-bridge.js nếu cần truyền full task
- src/core/queue/executor.js để đảm bảo task.refInputs không bị strip
- src/background/service-worker.js nếu submit lock nằm ở đây

Không sửa page-flow-transport.js nhiều nếu không cần.
```

---

# 21. Kết luận

Cách sửa đúng là:

```txt
Không attach chip trước prompt.
Không nhập full prompt trước.
Không dùng upload file input.

Phải type prompt theo từng đoạn:
characterName
→ @ mention file
→ chip
→ phần còn lại của prompt
```

Khi đó chip sẽ nằm đúng sau tên character:

```txt
Lục Nhược Linh [chip: Lục Nhược Linh.jpeg] (Gender: Female...)
```
