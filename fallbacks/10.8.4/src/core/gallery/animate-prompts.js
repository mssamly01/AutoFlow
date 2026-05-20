const VIDEO_HINT_RE = /\b(video|animate|animation|motion|camera|shot|scene|pan|tilt|dolly|push|pull|zoom|rack focus|tracking|handheld|cinematic|duration|seconds|veo)\b/i;
const IMAGE_HINT_RE = /\b(image|still|photo|photograph|portrait|poster|reference|thumbnail|render|illustration|product shot)\b/i;
const REFERENCE_MATCH_STOPWORDS = new Set([
  "image", "img", "photo", "picture", "reference", "ref", "product", "shot",
  "still", "frame", "start", "end", "match", "test", "proof", "verify",
  "matrix", "sample", "upload", "prompt",
  "room", "bedroom", "apartment", "cafe", "villa", "terminal", "cabin", "bar",
  "house", "home", "office", "school", "street", "city", "kitchen", "garden",
  "campus", "background", "interior", "exterior", "place", "setting"
]);

export function sceneTag(value = "") {
  const match = String(value || "").match(/\[([^\]]+)\]/);
  return match ? normalizeTag(match[1]) : "";
}

export function normalizeTag(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function stripSceneTag(value = "") {
  return String(value || "").replace(/^\s*\[[^\]]+\]\s*/, "").trim();
}

export function normalizePromptText(value = "") {
  return stripSceneTag(value)
    .replace(/^\s*(image|still|reference|video|motion|animation)\s*prompt\s*:\s*/i, "")
    .replace(/^\s*(image|still|reference|video|motion|animation)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseAutoFlowPromptDocument(text = "") {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const entries = [];
  const byTag = new Map();

  for (const line of lines) {
    if (!line.includes("|||")) continue;
    const parts = line.split("|||").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const tag = sceneTag(line);
    if (!tag) continue;
    const entry = {
      tag,
      line,
      sides: parts,
      left: parts[0] || "",
      right: parts.slice(1).join(" ||| ")
    };
    entries.push(entry);
    if (!byTag.has(tag)) byTag.set(tag, entry);
  }

  return {
    entries,
    byTag,
    isAutoFlowFormat: entries.length > 0
  };
}

function scoreAutoFlowSides(entry, item = {}) {
  if (!entry) return "";
  const itemText = [
    item.prompt,
    item.title,
    item.fileName
  ].map((value) => normalizePromptText(value)).filter(Boolean).join(" ");

  const sides = entry.sides || [];
  if (sides.length < 2) return [];

  return sides.map((side, index) => {
    const normalized = normalizePromptText(side);
    const directItemMatch = normalized && itemText && (itemText.includes(normalized) || normalized.includes(itemText));
    const videoHints = VIDEO_HINT_RE.test(side) ? 2 : 0;
    const imageHints = IMAGE_HINT_RE.test(side) ? 1 : 0;
    return {
      index,
      side,
      normalized,
      directItemMatch,
      score: videoHints - imageHints + (index > 0 ? 0.25 : 0)
    };
  });
}

function likelyVideoSide(entry, item = {}) {
  const sideScores = scoreAutoFlowSides(entry, item);
  if (!sideScores.length) return null;
  const matchedImageSide = sideScores.find((candidate) => candidate.directItemMatch);
  if (matchedImageSide && sideScores.length > 1) {
    const opposite = sideScores
      .filter((candidate) => candidate.index !== matchedImageSide.index)
      .sort((a, b) => b.score - a.score)[0];
    if (opposite?.side) return opposite;
  }
  return [...sideScores].sort((a, b) => b.score - a.score)[0] || null;
}

export function promptForImageFromAutoFlowEntry(entry, item = {}) {
  if (!entry) return "";
  const sides = entry.sides || [];
  if (sides.length < 2) return stripSceneTag(entry.right || entry.left || "");
  const likelyVideo = likelyVideoSide(entry, item);
  return stripSceneTag(likelyVideo?.side || entry.right || entry.left || "");
}

export function imagePromptFromAutoFlowEntry(entry, item = {}) {
  if (!entry) return "";
  const sides = entry.sides || [];
  if (sides.length < 2) return stripSceneTag(entry.left || entry.right || "");
  const videoSide = likelyVideoSide(entry, item);
  const imageSide = scoreAutoFlowSides(entry, item)
    .filter((candidate) => candidate.index !== videoSide?.index)
    .sort((a, b) => a.score - b.score)[0];
  return stripSceneTag(imageSide?.side || entry.left || entry.right || "");
}

export function splitAutoFlowPromptLine(line = "") {
  const sourcePrompt = String(line || "").trim();
  const parsed = parseAutoFlowPromptDocument(sourcePrompt);
  const entry = parsed.entries[0] || null;
  if (!entry) {
    return {
      isAutoFlowFormat: false,
      tag: "",
      sourcePrompt,
      imagePrompt: sourcePrompt,
      videoPrompt: ""
    };
  }
  return {
    isAutoFlowFormat: true,
    tag: entry.tag || "",
    sourcePrompt,
    imagePrompt: imagePromptFromAutoFlowEntry(entry),
    videoPrompt: promptForImageFromAutoFlowEntry(entry)
  };
}

function normalizeAutoMatchFileNameText(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[a-z0-9]{2,8}$/i, "")
    .replace(/^run\s*[-_ ]*/i, "")
    .replace(/^ref\s*[-_ ]*/i, "")
    .replace(/^reference\s*[-_ ]*/i, "")
    .replace(/^image\s*[-_ ]*/i, "")
    .replace(/[_\-\.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAutoMatchPromptText(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-\.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function autoMatchImageBaseName(item = {}) {
  const rawName =
    item.fileName ||
    item.filename ||
    item.originalFileName ||
    item.sourceFileName ||
    item.localFileName ||
    item.uploadName ||
    "";

  return normalizeAutoMatchFileNameText(rawName);
}

function promptContainsAutoMatchName(promptText = "", imageName = "") {
  const prompt = normalizeAutoMatchPromptText(promptText);
  const name = normalizeAutoMatchFileNameText(imageName);

  if (!prompt || !name) return false;
  if (name.length < 3) return false;

  return ` ${prompt} `.includes(` ${name} `);
}

function escapedRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indexOfAutoMatchName(normalizedPrompt = "", normalizedName = "") {
  const prompt = ` ${normalizeAutoMatchPromptText(normalizedPrompt)} `;
  const name = normalizeAutoMatchPromptText(normalizedName);

  if (!prompt.trim() || !name) return -1;
  return prompt.indexOf(` ${name} `);
}

function normalizeForRoleDetection(value = "") {
  return normalizeAutoMatchPromptText(value);
}

function isCharacterReferenceMatch(promptText = "", imageName = "", firstIndex = -1) {
  const normalizedPrompt = normalizeForRoleDetection(promptText);
  const normalizedName = normalizeForRoleDetection(imageName);

  if (!normalizedPrompt || !normalizedName || firstIndex < 0) return false;

  const nameFollowedByParenLikeBlock = new RegExp(
    `(?:^|\\s)${escapedRegex(normalizedName)}\\s+(?:male|female|age|height|face|hair|eyes|posture|outfit)\\b`,
    "i"
  );

  if (nameFollowedByParenLikeBlock.test(normalizedPrompt)) {
    return true;
  }

  const screenContinuityIndex = normalizedPrompt.indexOf("screen continuity");
  if (screenContinuityIndex >= 0) {
    const locationIndex = normalizedPrompt.indexOf(" location ");
    const negativeIndex = normalizedPrompt.indexOf(" negative prompt ");
    const endIndex = [locationIndex, negativeIndex]
      .filter((value) => value > screenContinuityIndex)
      .sort((a, b) => a - b)[0] || Math.min(normalizedPrompt.length, screenContinuityIndex + 500);

    const screenContinuityText = normalizedPrompt.slice(screenContinuityIndex, endIndex);
    if (screenContinuityText.includes(` ${normalizedName} `)) {
      return true;
    }
  }

  return false;
}

function isLocationReferenceMatch(promptText = "", imageName = "", firstIndex = -1) {
  const normalizedPrompt = normalizeForRoleDetection(promptText);
  const normalizedName = normalizeForRoleDetection(imageName);

  if (!normalizedPrompt || !normalizedName || firstIndex < 0) return false;

  const locationMarkers = [
    "location",
    "location continuity",
    "background"
  ];

  for (const marker of locationMarkers) {
    const markerIndex = normalizedPrompt.indexOf(marker);
    if (markerIndex < 0) continue;

    const endIndex = Math.min(normalizedPrompt.length, markerIndex + 450);
    const segment = normalizedPrompt.slice(markerIndex, endIndex);
    if (segment.includes(` ${normalizedName} `)) {
      return true;
    }
  }

  return false;
}

function autoMatchRoleForReference(promptText = "", imageName = "", firstIndex = -1) {
  if (isCharacterReferenceMatch(promptText, imageName, firstIndex)) {
    return {
      role: "character",
      rolePriority: 0
    };
  }

  if (isLocationReferenceMatch(promptText, imageName, firstIndex)) {
    return {
      role: "location",
      rolePriority: 1
    };
  }

  return {
    role: "other",
    rolePriority: 2
  };
}

function effectiveCharacterIndex(promptText = "", imageName = "", fallbackIndex = -1) {
  const normalizedPrompt = normalizeForRoleDetection(promptText);
  const normalizedName = normalizeForRoleDetection(imageName);

  if (!normalizedPrompt || !normalizedName) {
    return fallbackIndex >= 0 ? fallbackIndex : Number.MAX_SAFE_INTEGER;
  }

  const sceneIndex = normalizedPrompt.indexOf(" scene ");
  if (sceneIndex >= 0) {
    const sceneText = normalizedPrompt.slice(sceneIndex);
    const localIndex = sceneText.indexOf(` ${normalizedName} `);
    if (localIndex >= 0) {
      return sceneIndex + localIndex;
    }
  }

  return fallbackIndex >= 0 ? fallbackIndex : Number.MAX_SAFE_INTEGER;
}

export function promptMatchesReferenceItem(prompt = "", item = {}) {
  const imageName = autoMatchImageBaseName(item);
  if (REFERENCE_MATCH_STOPWORDS.has(imageName)) return false;
  return promptContainsAutoMatchName(prompt, imageName);
}

export function matchedReferenceIdsForPrompt(prompt = "", refs = [], options = {}) {
  const normalizedPrompt = normalizeAutoMatchPromptText(prompt);
  if (!normalizedPrompt) return [];

  const limit = Math.max(
    0,
    Number(options.limit || refs.length || 0) || refs.length || 0
  );

  const matches = [];

  for (const ref of refs || []) {
    const id = String(ref?.id || "").trim();
    if (!id) continue;

    const imageName = autoMatchImageBaseName(ref);
    if (!imageName) continue;
    if (REFERENCE_MATCH_STOPWORDS.has(imageName)) continue;

    if (!promptContainsAutoMatchName(normalizedPrompt, imageName)) {
      continue;
    }

    const firstIndex = indexOfAutoMatchName(normalizedPrompt, imageName);
    const roleInfo = autoMatchRoleForReference(prompt, imageName, firstIndex);
    const effectiveIndex =
      roleInfo.role === "character"
        ? effectiveCharacterIndex(prompt, imageName, firstIndex)
        : firstIndex;

    matches.push({
      id,
      imageName,
      firstIndex: effectiveIndex >= 0 ? effectiveIndex : Number.MAX_SAFE_INTEGER,
      role: roleInfo.role,
      rolePriority: roleInfo.rolePriority,
      score: imageName.length
    });
  }

  if (options.debug) {
    console.table(matches.map((item) => ({
      id: item.id,
      imageName: item.imageName,
      role: item.role,
      rolePriority: item.rolePriority,
      firstIndex: item.firstIndex,
      score: item.score
    })));
  }

  return matches
    .sort((a, b) => {
      if (a.rolePriority !== b.rolePriority) {
        return a.rolePriority - b.rolePriority;
      }

      if (a.firstIndex !== b.firstIndex) {
        return a.firstIndex - b.firstIndex;
      }

      return b.score - a.score;
    })
    .slice(0, limit || matches.length)
    .map((item) => item.id);
}

export function buildAnimatePromptAssignments(selectedImages, mode, text) {
  const raw = String(text || "").trim();
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (mode === "shared") {
    return selectedImages.map((item) => ({ item, prompt: raw }));
  }
  if (mode === "document") {
    const document = parseAutoFlowPromptDocument(raw);
    return selectedImages.map((item) => {
      const tag = sceneTag(item.prompt) || sceneTag(item.title) || sceneTag(item.fileName);
      const entry = tag ? document.byTag.get(tag) : null;
      return { item, prompt: promptForImageFromAutoFlowEntry(entry, item) };
    });
  }
  return selectedImages.map((item, index) => ({ item, prompt: lines[index] || "" }));
}
