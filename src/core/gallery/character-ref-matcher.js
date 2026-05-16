/**
 * Normalizes a string for character reference matching.
 * Handles Vietnamese character normalization (NFC) and removes file extensions.
 */
export function normalizeCharacterRefKey(value = "") {
  return String(value || "")
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\.(png|jpe?g|webp|gif)$/i, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Gets the standard filename from a reference input object.
 */
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

/**
 * Infers the first character name from a prompt string.
 * Look for text before the first opening parenthesis.
 */
export function inferFirstCharacterNameFromPrompt(prompt = "") {
  const text = String(prompt || "").trim();

  // Match text before "("
  const match = text.match(/^(.{1,80}?)\s*\(/u);
  if (match?.[1]) {
    return match[1].trim().normalize("NFC").replace(/\s+/g, " ");
  }

  return "";
}

/**
 * Collects all character names associated with a task.
 */
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

/**
 * Checks if a reference input matches a specific character name.
 */
export function refInputMatchesCharacter(ref = {}, characterName = "") {
  const refKey = normalizeCharacterRefKey(getRefInputFileName(ref));
  const charKey = normalizeCharacterRefKey(characterName);
  return Boolean(refKey && charKey && refKey === charKey);
}

/**
 * Normalizes task refInputs to have consistent fields for character matching.
 */
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

/**
 * Ensures a task has the correct character reference inputs attached.
 * This version supports multi-character detection and proper tagging.
 */
export function ensureTaskInlineCharacterRefs(task = {}, allRefInputs = []) {
  const characters = getTaskCharacterNames(task);

  if (!characters.length) {
    return {
      ...task,
      refInputs: normalizeTaskRefInputs(task)
    };
  }

  const existingRefs = normalizeTaskRefInputs(task);

  // If we already have refs, ensure they have characterName metadata
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
          characterName: matchedCharacter,
          role: ref.role || "character_reference"
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

    if (matched) {
      const fileName = getRefInputFileName(matched) || `${characterName}.jpeg`;
      picked.push({
        ...matched,
        characterName,
        name: fileName,
        fileName,
        role: "character_reference"
      });
    } else {
      throw new Error(`Missing reference image for character: ${characterName}`);
    }

  }

  return {
    ...task,
    characters,
    characterName: task.characterName || characters[0],
    refInputs: picked
  };
}
