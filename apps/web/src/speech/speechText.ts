export interface SpeechTextOptions {
  readCodeBlocks?: boolean;
  readCitations?: boolean;
}

function replaceMarkdownLinks(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const image = value[index] === "!" && value[index + 1] === "[";
    if (value[index] !== "[" && !image) {
      output += value[index++];
      continue;
    }
    const labelStart = index + (image ? 2 : 1);
    const labelEnd = value.indexOf("](", labelStart);
    if (labelEnd < 0) {
      output += value[index++];
      continue;
    }
    let depth = 1;
    let cursor = labelEnd + 2;
    for (; cursor < value.length && depth > 0; cursor++) {
      if (value[cursor] === "\\") cursor++;
      else if (value[cursor] === "(") depth++;
      else if (value[cursor] === ")") depth--;
    }
    if (depth !== 0) {
      output += value[index++];
      continue;
    }
    output += value.slice(labelStart, labelEnd);
    index = cursor;
  }
  return output;
}

/** Converts rendered-response Markdown into stable, provider-ready spoken text. */
export function speechTextForMarkdown(markdown: string, options: SpeechTextOptions = {}): string {
  const readCode = options.readCodeBlocks ?? false;
  const readCitations = options.readCitations ?? false;
  let value = markdown.replace(
    /```[^\n]*\n([\s\S]*?)```/g,
    (_match, code: string) => readCode ? `\nCode block.\n${code}\nEnd code block.\n` : "\n",
  );
  value = value.replace(/`([^`\n]+)`/g, "$1");
  value = replaceMarkdownLinks(value);
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  value = value.replace(/^\s*>\s?/gm, "");
  value = value.replace(/^\s*[-+*]\s+/gm, "");
  value = value.replace(/^\s*\d+[.)]\s+/gm, "");
  value = value.replace(/[*_~]{1,3}/g, "");
  if (!readCitations) value = value.replace(/\s*\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, "");
  return value.replace(/<\/?[A-Za-z][^<>]*>/g, " ").replace(/[ \t]+/g, " ").replace(
    /\n{3,}/g,
    "\n\n",
  ).trim();
}
