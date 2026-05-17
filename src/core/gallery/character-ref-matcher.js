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

  // 1. Support "Character: Name (details)"
  const characterLabelMatch = text.match(
    /(?:^|[\n.])\s*Character\s*:\s*([^(\n.]{1,80})\s*\(/iu
  );
  if (characterLabelMatch?.[1]) {
    return characterLabelMatch[1]
      .trim()
      .normalize("NFC")
      .replace(/\s+/g, " ");
  }

  // 2. Support "Nhân vật: Name (chi tiết)"
  const vietnameseLabelMatch = text.match(
    /(?:^|[\n.])\s*Nhân\s*vật\s*:\s*([^(\n.]{1,80})\s*\(/iu
  );
  if (vietnameseLabelMatch?.[1]) {
    return vietnameseLabelMatch[1]
      .trim()
      .normalize("NFC")
      .replace(/\s+/g, " ");
  }

  // 3. Fallback: text before the first "("
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
  return Boolean(
    refKey &&
    charKey &&
    (
      refKey === charKey ||
      refKey.startsWith(`${charKey} `) ||
      refKey.endsWith(` ${charKey}`) ||
      refKey.includes(` ${charKey} `)
    )
  );
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

  // If we already have refs, preserve non-character refs and tag only the
  // refs that can be tied to a character by metadata, filename, or sole-ref use.
  if (existingRefs.length) {
    return {
      ...task,
      characters,
      characterName: task.characterName || characters[0],
      refInputs: existingRefs.map((ref) => {
        const explicitCharacter = String(ref.characterName || ref.character || "").trim().normalize("NFC");
        const matchedCharacter =
          characters.find((name) => explicitCharacter && normalizeCharacterRefKey(name) === normalizeCharacterRefKey(explicitCharacter)) ||
          characters.find((name) => refInputMatchesCharacter(ref, name)) ||
          (existingRefs.length === 1 && characters.length === 1 ? characters[0] : "");

        return {
          ...ref,
          characterName: matchedCharacter || explicitCharacter || ref.characterName || "",
          role: matchedCharacter ? "character_reference" : (ref.role || "")
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
