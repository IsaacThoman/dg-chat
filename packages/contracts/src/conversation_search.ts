function isConversationSearchControl(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return point <= 0x1f ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x061c || point === 0x200e || point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069);
}

/** Removes terminal and bidirectional controls without interpreting the remaining text. */
export function stripConversationSearchControls(value: string, replacement = ""): string {
  return Array.from(
    value,
    (character) => isConversationSearchControl(character) ? replacement : character,
  ).join("");
}

/** True when a term contains something visible after unsafe controls and whitespace are removed. */
export function hasVisibleConversationSearchText(value: string): boolean {
  return stripConversationSearchControls(value).trim().length > 0;
}
