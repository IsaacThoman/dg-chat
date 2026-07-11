export interface FocusRoot {
  querySelector(selector: string): { focus(): void } | null;
}

export function restoreGeneratedAssetFocus(root: FocusRoot, assetId: string): boolean {
  const escaped = globalThis.CSS?.escape
    ? globalThis.CSS.escape(assetId)
    : assetId.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const target = root.querySelector(
    `[data-generated-asset-id="${escaped}"] .generated-image-preview`,
  );
  target?.focus();
  return target !== null;
}

export function imageMutationBelongsToQuery(startGeneration: number, currentGeneration: number) {
  return startGeneration === currentGeneration;
}
