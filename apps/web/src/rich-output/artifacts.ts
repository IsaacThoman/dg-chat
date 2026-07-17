export const ARTIFACT_MIN_CHARACTERS = 600;
export const ARTIFACT_MIN_LINES = 18;

export interface ArtifactDescriptor {
  index: number;
  language: string;
  source: string;
  filename: string | null;
  title: string;
  declaredVersion: string | null;
  versionIndex: number;
  versionCount: number;
  siblingIndexes: number[];
  startLine: number;
  artifact: boolean;
}

interface ParsedFence
  extends Omit<ArtifactDescriptor, "versionIndex" | "versionCount" | "siblingIndexes"> {
  group: string;
}

const extensionByLanguage: Record<string, string> = {
  bash: "sh",
  csharp: "cs",
  css: "css",
  csv: "csv",
  deno: "ts",
  go: "go",
  html: "html",
  javascript: "js",
  json: "json",
  jsx: "jsx",
  markdown: "md",
  mermaid: "mmd",
  plaintext: "txt",
  python: "py",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  sql: "sql",
  text: "txt",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
};

function infoValue(info: string, key: string): string | null {
  const match = info.match(new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function artifactVersionGroup(value: string | null, index: number): string {
  if (!value) return `anonymous:${index}`;
  // Preserve the author-provided path as identity. Export still uses a safe basename below, but
  // src/Widget.tsx and tests/Widget.tsx are distinct artifacts rather than misleading versions.
  return value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "")
    .toLocaleLowerCase();
}

export function safeArtifactFilename(
  value: string | null,
  language: string,
  index: number,
): string {
  const fallback = `artifact-${index + 1}.${extensionByLanguage[language] ?? "txt"}`;
  if (!value) return fallback;
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const safe = basename.replace(/[^A-Za-z0-9._ -]/g, "-").replace(/^\.+/, "").slice(0, 120);
  return safe || fallback;
}

export function shouldPromoteArtifact(source: string, info = ""): boolean {
  const lines = source.split("\n").length;
  return /(?:^|\s)(?:artifact|filename|title|version)(?:=|\s|$)/i.test(info) ||
    source.length >= ARTIFACT_MIN_CHARACTERS || lines >= ARTIFACT_MIN_LINES;
}

/**
 * Derives artifact identity and version relationships from fenced Markdown without interpreting
 * its contents. A repeated filename is the only version relationship we infer: anonymous blocks
 * stay independent so unrelated code examples never acquire misleading navigation.
 */
export function deriveArtifacts(markdown: string): ArtifactDescriptor[] {
  const fence = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm;
  const parsed: ParsedFence[] = [];
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const info = match[3].trim();
    const language = (info.match(/^([^\s{]+)/)?.[1] ?? "text").toLowerCase();
    const source = match[4];
    const filenameValue = infoValue(info, "filename") ?? infoValue(info, "file");
    const filename = filenameValue
      ? safeArtifactFilename(filenameValue, language, parsed.length)
      : null;
    const declaredVersion = infoValue(info, "version");
    const explicitTitle = infoValue(info, "title");
    const index = parsed.length;
    parsed.push({
      index,
      language,
      source,
      filename,
      title: explicitTitle ?? filename ?? `${language || "Text"} artifact`,
      declaredVersion,
      startLine: markdown.slice(0, match.index).split("\n").length,
      artifact: language !== "mermaid" && shouldPromoteArtifact(source, info),
      group: artifactVersionGroup(filenameValue, index),
    });
  }

  const groups = new Map<string, number[]>();
  for (const item of parsed) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item.index]);
  }
  return parsed.map(({ group, ...item }) => {
    const siblingIndexes = groups.get(group) ?? [item.index];
    return {
      ...item,
      siblingIndexes,
      versionIndex: siblingIndexes.indexOf(item.index),
      versionCount: siblingIndexes.length,
    };
  });
}

export function artifactForFence(
  artifacts: ArtifactDescriptor[],
  source: string,
  language: string,
  startLine?: number,
): ArtifactDescriptor | null {
  if (startLine !== undefined) {
    const byLine = artifacts.find((item) =>
      item.startLine === startLine || item.startLine + 1 === startLine
    );
    if (byLine) return byLine;
  }
  return artifacts.find((item) =>
    item.source === source.replace(/\n$/, "") && item.language === language
  ) ??
    null;
}
