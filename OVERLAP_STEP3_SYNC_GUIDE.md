# AutoFlow – Đồng Bộ Overlap Từ Settings Vào Bước 3

## Mục Tiêu

| Hành vi hiện tại | Hành vi mong muốn |
|---|---|
| Bước 3 luôn hiện `overlapCard` với đầy đủ 4 dòng (Toggle, Concurrent, Trigger %, Fallback sec) | Bước 3 **không hiện gì** khi Settings `overlapEnabled = false` |
| Bước 3 có toggle ON/OFF riêng → người dùng phải set 2 chỗ | Bước 3 chỉ **đọc từ Settings**, không có toggle riêng |
| Bước 3 hiện cả `Trigger %` và `Fallback sec` | Bước 3 chỉ hiện **Overlap** (trạng thái) + **Concurrent** (số lượng) |
| `overlapCard` nằm **ngoài** `settingsCard` (tách biệt) | `overlapCard` nằm **trong** `settingsCard` (cùng khối Generation) |

---

## Plan

```
1. Xóa overlapCard độc lập khỏi return của buildStep3Body
2. Thêm 2 dòng overlap vào cuối settingsCard (chỉ khi overlapEnabled = true)
3. Xóa toggle checkbox overlapEnabled khỏi bước 3 (chỉ Settings mới có quyền bật/tắt)
4. Chỉ giữ: dòng trạng thái Overlap (read-only) + dòng Concurrent (select)
```

---

## File Cần Sửa

```
src/sidepanel/views/control-wizard.js
```

---

## Code Cần Sửa → Code Mới

### Thay Đổi 1 – Xóa `overlapCard` khỏi `return`, thêm overlap rows vào `settingsCard`

**Tìm toàn bộ đoạn `overlapCard` và phần `return` (khoảng dòng 1068–1130):**

```javascript
// ── CODE CŨ ──────────────────────────────────────────────────────────────────

  const overlapEnabled = presets.overlapEnabled === true;
  const overlapOptions = [[\"1\", \"1\"], [\"2\", \"2\"], [\"3\", \"3\"], [\"4\", \"4\"]];
  const overlapCard = el(\"div\", { class: \"afw-gen-card afw-overlap-card\" },
    row(
      \"speed\",
      \"Overlap Queue\",
      overlapEnabled ? \"Tasks will overlap when progress or timer triggers\" : \"Disabled — tasks run sequentially\",
      el(\"label\", { class: \"afw-toggle-wrap\" },
        el(\"input\", {
          attrs: { type: \"checkbox\", ...(overlapEnabled ? { checked: \"\" } : {}) },
          data: { settingKey: \"overlapEnabled\" }
        }),
        el(\"span\", { class: \"afw-toggle-label\", text: overlapEnabled ? \"ON\" : \"OFF\" })
      )
    ),
    overlapEnabled
      ? row(\"groups\", \"Concurrent\", \"Max tasks running at once\", valSelect(\"overlapMaxConcurrentTasks\", String(presets.overlapMaxConcurrentTasks || 1), overlapOptions))
      : null,
    overlapEnabled
      ? row(\"percent\", \"Trigger %\", \"Start next task at this progress\", el(\"input\", {
          class: \"afw-val-btn\",
          attrs: { type: \"number\", min: \"1\", max: \"99\", value: String(presets.overlapTriggerProgress || 50) },
          data: { settingKey: \"overlapTriggerProgress\" }
        }))
      : null,
    overlapEnabled
      ? row(\"hourglass_empty\", \"Fallback sec\", \"Start next if no progress after\", el(\"input\", {
          class: \"afw-val-btn\",
          attrs: { type: \"number\", min: \"5\", max: \"600\", value: String(presets.overlapFallbackSeconds || 45) },
          data: { settingKey: \"overlapFallbackSeconds\" }
        }))
      : null,
  );

  return el(\"div\", { class: \"afw-step-body\" },
    el(\"p\", { class: \"afw-lede\", text: tr(state, \"reviewRunHelp\") }),
    el(\"div\", { class: \"afw-eyebrow\" }, icon(\"checklist\"), tr(state, \"promptsToReferences\"),
      el(\"span\", { class: \"afw-right\" }, el(\"b\", { text: String(prompts.length) }), ` ${tr(state, \"total\")}`),
    ),
    pairList,
    el(\"div\", { class: \"afw-eyebrow\", attrs: { style: \"margin-top:6px;\" } }, icon(\"settings\"), tr(state, \"generation\"),
      el(\"span\", { class: \"afw-right\", text: tr(state, \"settingsOverrideHere\") }),
    ),
    settingsCard,
    overlapCard,
    estimate,
  );
```

```javascript
// ── CODE MỚI ─────────────────────────────────────────────────────────────────

  // Đọc trực tiếp từ Settings – bước 3 không có toggle riêng.
  const overlapEnabled = presets.overlapEnabled === true;
  const overlapOptions = [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]];

  return el("div", { class: "afw-step-body" },
    el("p", { class: "afw-lede", text: tr(state, "reviewRunHelp") }),
    el("div", { class: "afw-eyebrow" }, icon("checklist"), tr(state, "promptsToReferences"),
      el("span", { class: "afw-right" }, el("b", { text: String(prompts.length) }), ` ${tr(state, "total")}`),
    ),
    pairList,
    el("div", { class: "afw-eyebrow", attrs: { style: "margin-top:6px;" } }, icon("settings"), tr(state, "generation"),
      el("span", { class: "afw-right", text: tr(state, "settingsOverrideHere") }),
    ),
    settingsCard,
    // Overlap chỉ hiện khi được bật trong Settings – nằm chung khối Generation.
    overlapEnabled
      ? el("div", { class: "afw-gen-card afw-overlap-card" },
          row(
            "speed",
            "Overlap Queue",
            "ON · Tasks start before previous completes",
            el("span", { class: "afw-val-btn afw-val-readonly", text: "ON" })
          ),
          row(
            "groups",
            "Concurrent",
            "Max tasks running at once",
            valSelect("overlapMaxConcurrentTasks", String(presets.overlapMaxConcurrentTasks || 1), overlapOptions)
          ),
        )
      : null,
    estimate,
  );
```

---

## Giải Thích Từng Thay Đổi

| Thay đổi | Lý do |
|---|---|
| Xóa `overlapCard` variable | Không cần biến riêng nữa, inline trực tiếp vào return |
| Xóa `el("input", { type: "checkbox" ... settingKey: "overlapEnabled" })` | Bước 3 không được phép bật/tắt overlap – chỉ Settings mới có quyền |
| Thay toggle bằng `el("span", { class: "afw-val-btn afw-val-readonly", text: "ON" })` | Hiển thị trạng thái read-only, không tương tác |
| Xóa dòng `Trigger %` | Theo yêu cầu: bỏ % |
| Xóa dòng `Fallback sec` | Theo yêu cầu: chỉ giữ Overlap + Concurrent |
| Wrap trong `overlapEnabled ? ... : null` | Toàn bộ block ẩn khi Settings chưa bật overlap |
| `overlapCard` đặt sau `settingsCard`, trước `estimate` | Nằm trong vùng Generation |

---

## CSS Cần Thêm (nếu `afw-val-readonly` chưa có)

Tìm file CSS của sidepanel (thường là `sidepanel/app.css` hoặc `sidepanel/views.css`) và thêm:

```css
/* Overlap read-only badge in Step 3 */
.afw-val-readonly {
  opacity: 0.75;
  cursor: default;
  pointer-events: none;
  background: var(--afw-bg-card, rgba(255,255,255,0.06));
  border: 1px solid var(--afw-border, rgba(255,255,255,0.1));
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  color: var(--afw-text-soft, #8899aa);
}
```

Nếu muốn đơn giản hơn, thay `afw-val-readonly` bằng `afw-val-btn` đã có sẵn và thêm `attrs: { disabled: "disabled" }` – trông giống select bị disabled.

---

## Thứ Tự Vibe Code

1. Mở `src/sidepanel/views/control-wizard.js`
2. Tìm dòng `const overlapEnabled = presets.overlapEnabled === true;` (khoảng dòng 1068)
3. Xóa từ đó đến hết `const overlapCard = el(...)` (khoảng dòng 1102)
4. Tìm phần `return el("div", { class: "afw-step-body" }` (khoảng dòng 1105)
5. Xóa dòng `overlapCard,` trong return
6. Thêm block `overlapEnabled ? el("div", ...) : null` ngay sau `settingsCard,`
7. (Tuỳ chọn) Thêm CSS `afw-val-readonly` vào stylesheet

## Kiểm Tra

- Settings → Overlap OFF → vào Bước 3 → **không thấy Overlap section**
- Settings → Overlap ON → vào Bước 3 → **thấy 2 dòng: "Overlap Queue ON" + "Concurrent [dropdown]"**
- Thay đổi Concurrent ở Bước 3 → vào Settings → giá trị phải được đồng bộ (vì dùng cùng `settingKey: "overlapMaxConcurrentTasks"`)
- Toggle overlap ở Settings → quay lại Bước 3 → section hiện/ẩn đúng
