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
    .replace(/\u0110/g, "D")
    .replace(/\u0111/g, "d")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
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
    .replace(/\u0110/g, "D")
    .replace(/\u0111/g, "d")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
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

function autoMatchActualFileName(item = {}) {
  return String(
    item.fileName ||
    item.filename ||
    item.originalFileName ||
    item.sourceFileName ||
    item.localFileName ||
    item.uploadName ||
    ""
  ).trim();
}

function uniqueAutoMatchStrings(values = []) {
  return [...new Set(
    values
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

function autoMatchCandidateNameEntries(item = {}) {
  const fileName = autoMatchActualFileName(item);
  const fileBase = fileName.replace(/\.[a-z0-9]{2,8}$/i, "");
  const rawNames = uniqueAutoMatchStrings([
    fileName,
    fileBase,
    item.title,
    item.displayName,
    item.characterName,
    item.label,
    item.name,
    item.aliases
  ]);

  return rawNames
    .map((raw) => ({
      raw,
      normalized: normalizeAutoMatchFileNameText(raw)
    }))
    .filter((entry) => entry.normalized.length >= 3 && !REFERENCE_MATCH_STOPWORDS.has(entry.normalized));
}

function promptContainsAutoMatchName(promptText = "", imageName = "") {
  const prompt = normalizeAutoMatchPromptText(promptText);
  const name = normalizeAutoMatchFileNameText(imageName);

  if (!prompt || !name) return false;
  if (name.length < 3) return false;

  return ` ${prompt} `.includes(` ${name} `);
}

function normalizedPromptContainsPhrase(promptText = "", phrase = "") {
  const prompt = ` ${normalizeAutoMatchPromptText(promptText)} `;
  const normalized = normalizeAutoMatchPromptText(phrase);
  return Boolean(prompt.trim() && normalized && prompt.includes(` ${normalized} `));
}

function phraseContainmentScore(left = "", right = "") {
  const a = normalizeAutoMatchPromptText(left);
  const b = normalizeAutoMatchPromptText(right);
  if (!a || !b) return 0;
  if (a === b) return 120;
  if (` ${a} `.includes(` ${b} `)) return 80;
  return 0;
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

function roleInfoForNameAndDescription(name = "", description = "") {
  const text = normalizeForRoleDetection(`${name} ${description}`);
  const characterHints = /\b(gender|female|male|age|height|face|hair|eyes|posture|outfit|body|skin|expression)\b/i;
  const locationHints = /\b(location|house|home|room|interior|exterior|background|street|city|kitchen|bedroom|office|garden|school|shop|cafe)\b/i;

  if (characterHints.test(text)) {
    return { role: "character", rolePriority: 0 };
  }
  if (locationHints.test(text)) {
    return { role: "location", rolePriority: 1 };
  }
  return { role: "other", rolePriority: 2 };
}

function cleanEntityHeadingName(value = "") {
  return String(value || "")
    .replace(/^(character|location|place|setting|background)\s*:\s*/i, "")
    .replace(/^[\s"'“”‘’\-–—:]+|[\s"'“”‘’\-–—:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function autoMatchEntityMentionsFromPrompt(prompt = "") {
  const text = String(prompt || "");
  const mentions = [];
  const headingPattern = /(^|[\n\r.;!?])(\s*)([^\n\r()]{2,120}?)\s*(?=\()/gu;

  for (const match of text.matchAll(headingPattern)) {
    const prefix = match[1] || "";
    const spacing = match[2] || "";
    const rawHeading = match[3] || "";
    const leadingTrimmed = rawHeading.match(/^\s*/)?.[0]?.length || 0;
    const trailingTrimmed = rawHeading.match(/\s*$/)?.[0]?.length || 0;
    const rawStart = match.index + prefix.length + spacing.length + leadingTrimmed;
    const rawEnd = match.index + prefix.length + spacing.length + rawHeading.length - trailingTrimmed;
    const entityName = cleanEntityHeadingName(rawHeading);
    const normalized = normalizeAutoMatchPromptText(entityName);
    if (normalized.length < 3) continue;
    if (REFERENCE_MATCH_STOPWORDS.has(normalized)) continue;

    const descriptionStart = rawEnd;
    const descriptionEnd = Math.min(text.length, descriptionStart + 220);
    const roleInfo = roleInfoForNameAndDescription(entityName, text.slice(descriptionStart, descriptionEnd));
    mentions.push({
      source: "heading",
      entityName,
      normalized,
      start: rawStart,
      end: rawEnd,
      role: roleInfo.role,
      rolePriority: roleInfo.rolePriority
    });
  }

  return mentions;
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

export function matchedReferenceDetailsForPrompt(prompt = "", refs = [], options = {}) {
  const normalizedPrompt = normalizeAutoMatchPromptText(prompt);
  if (!normalizedPrompt) return [];

  const limit = Math.max(
    0,
    Number(options.limit || refs.length || 0) || refs.length || 0
  );

  const matches = [];
  const entityMentions = autoMatchEntityMentionsFromPrompt(prompt);

  for (const ref of refs || []) {
    const id = String(ref?.id || "").trim();
    if (!id) continue;

    const candidates = autoMatchCandidateNameEntries(ref);
    if (!candidates.length) continue;

    let best = null;

    for (const mention of entityMentions) {
      for (const candidate of candidates) {
        const matchScore = phraseContainmentScore(mention.normalized, candidate.normalized);
        if (!matchScore) continue;
        const score = matchScore + candidate.normalized.length;
        if (!best || score > best.score) {
          best = {
            source: "heading",
            imageName: candidate.normalized,
            matchedName: candidate.raw,
            entityName: mention.entityName,
            insertionStart: mention.start,
            insertionEnd: mention.end,
            firstIndex: mention.start,
            role: mention.role,
            rolePriority: mention.rolePriority,
            score
          };
        }
      }
    }

    if (!best) {
      for (const candidate of candidates) {
        if (!promptContainsAutoMatchName(normalizedPrompt, candidate.normalized)) {
          continue;
        }
        const firstIndex = indexOfAutoMatchName(normalizedPrompt, candidate.normalized);
        const roleInfo = autoMatchRoleForReference(prompt, candidate.normalized, firstIndex);
        const effectiveIndex =
          roleInfo.role === "character"
            ? effectiveCharacterIndex(prompt, candidate.normalized, firstIndex)
            : firstIndex;
        const score = candidate.normalized.length;
        if (!best || score > best.score) {
          best = {
            source: "name",
            imageName: candidate.normalized,
            matchedName: candidate.raw,
            entityName: "",
            insertionStart: null,
            insertionEnd: null,
            firstIndex: effectiveIndex >= 0 ? effectiveIndex : Number.MAX_SAFE_INTEGER,
            role: roleInfo.role,
            rolePriority: roleInfo.rolePriority,
            score
          };
        }
      }
    }

    if (!best) {
      continue;
    }

    matches.push({
      id,
      imageName: best.imageName,
      matchedName: best.matchedName,
      entityName: best.entityName,
      actualFileName: autoMatchActualFileName(ref),
      insertionStart: best.insertionStart,
      insertionEnd: best.insertionEnd,
      source: best.source,
      firstIndex: best.firstIndex,
      role: best.role,
      rolePriority: best.rolePriority,
      score: best.score
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
    .slice(0, limit || matches.length);
}

export function matchedReferenceIdsForPrompt(prompt = "", refs = [], options = {}) {
  return matchedReferenceDetailsForPrompt(prompt, refs, options).map((item) => item.id);
}

function promptAlreadyContainsFileName(prompt = "", fileName = "") {
  const raw = String(fileName || "").trim();
  if (!raw) return false;
  if (String(prompt || "").toLowerCase().includes(raw.toLowerCase())) return true;
  return normalizedPromptContainsPhrase(prompt, raw);
}

export function injectAutoMatchReferenceFilenames(prompt = "", matches = []) {
  let next = String(prompt || "");
  const insertions = [];
  const seenRanges = new Set();

  for (const match of Array.isArray(matches) ? matches : []) {
    const fileName = String(match?.actualFileName || "").trim();
    const start = Number(match?.insertionStart);
    const end = Number(match?.insertionEnd);
    if (!fileName || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (promptAlreadyContainsFileName(next, fileName)) continue;
    const key = `${start}:${end}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    insertions.push({ start, end, fileName });
  }

  for (const insertion of insertions.sort((a, b) => b.end - a.end)) {
    next = `${next.slice(0, insertion.end)} ${insertion.fileName}${next.slice(insertion.end)}`;
  }

  return next;
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
