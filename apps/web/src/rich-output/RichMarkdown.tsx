import {
  Children,
  Component,
  type ComponentPropsWithoutRef,
  type ErrorInfo,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { Options as RehypeKatexOptions } from "rehype-katex";
import remarkGfm from "remark-gfm";
import { ArtifactBlock } from "./ArtifactBlock.tsx";
import { artifactForFence, deriveArtifacts } from "./artifacts.ts";
import { writeClipboard } from "./clipboard.ts";
import { MermaidDiagram, MermaidSourceFallback } from "./MermaidDiagram.tsx";

export const MAX_RENDERED_MERMAID_DIAGRAMS = 3;

type LoadedMath = {
  remarkMath: (typeof import("remark-math"))["default"];
  rehypeKatex: (typeof import("rehype-katex"))["default"];
};

let mathRuntime: Promise<LoadedMath> | null = null;
function loadMath(): Promise<LoadedMath> {
  if (!mathRuntime) {
    mathRuntime = Promise.all([
      import("remark-math"),
      import("rehype-katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([remark, rehype]) => ({ remarkMath: remark.default, rehypeKatex: rehype.default }));
  }
  return mathRuntime;
}

export function containsMath(markdown: string): boolean {
  return /\$\$|(?:^|[\s(])\$[^$\n]+\$(?=[\s).,!?:;]|$)/m.test(markdown);
}

export function blocksRemoteImageSource(source: string): boolean {
  // Markdown is model-, tool-, and import-controlled. Even a relative URL can target an
  // authenticated same-origin endpoint, so every non-empty image source requires an explicit
  // user gesture before the browser is allowed to request it.
  return source.trim().length > 0;
}

export function imageSourceHasConsent(
  approvedSource: string | undefined,
  currentSource: string,
): boolean {
  return approvedSource === currentSource;
}

function ConsentImage(
  { alt, src, ...props }: Omit<ComponentPropsWithoutRef<"img">, "src"> & {
    src?: string | Blob;
  },
) {
  const [approvedSource, setApprovedSource] = useState<string>();
  const source = typeof src === "string" ? src : undefined;
  if (!source) return <span className="rich-remote-image-blocked">Image unavailable</span>;
  if (!imageSourceHasConsent(approvedSource, source)) {
    return (
      <span className="rich-remote-image-blocked">
        <span>Remote image blocked{alt ? `: ${alt}` : ""}</span>
        <button
          type="button"
          aria-label={alt ? `Load image: ${alt}` : "Load image"}
          onClick={() => setApprovedSource(source)}
        >
          Load image
        </button>
      </span>
    );
  }
  return (
    <img
      {...props}
      src={source}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
    />
  );
}

function reactText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactText).join("");
  return isValidElement<{ children?: ReactNode }>(value) ? reactText(value.props.children) : "";
}

function codeLanguage(className: string | undefined): string {
  return className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() ?? "text";
}

interface MarkdownBoundaryProps {
  source: string;
  children: ReactNode;
}

class MarkdownBoundary extends Component<MarkdownBoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The source fallback below is deliberately local: one malformed response must not blank chat.
  }
  componentDidUpdate(previous: MarkdownBoundaryProps) {
    if (this.state.failed && previous.source !== this.props.source) {
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed
      ? <MarkdownSourceFallback source={this.props.source} />
      : this.props.children;
  }
}

function MarkdownSourceFallback({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rich-markdown-fallback" role="alert">
      <strong>Rich preview unavailable</strong>
      <p>The original response is preserved below.</p>
      <button type="button" onClick={() => void writeClipboard(source).then(setCopied)}>
        {copied ? "Copied" : "Copy source"}
      </button>
      <pre><code>{source}</code></pre>
    </div>
  );
}

export interface RichMarkdownProps {
  source: string;
  className?: string;
  artifacts?: boolean;
  blockRemoteImages?: boolean;
}

/** Secure Markdown renderer shared by live chat, reasoning, user turns, and public snapshots. */
export function RichMarkdown({
  source,
  className = "markdown",
  artifacts: artifactsEnabled = true,
  blockRemoteImages = true,
}: RichMarkdownProps) {
  const wantsMath = containsMath(source);
  const [math, setMath] = useState<LoadedMath | null>(null);
  const [mathFailed, setMathFailed] = useState(false);
  const fences = useMemo(() => deriveArtifacts(source), [source]);
  const artifacts = artifactsEnabled ? fences : [];
  const mermaidFences = useMemo(
    () => fences.filter((artifact) => artifact.language === "mermaid"),
    [fences],
  );
  const idPrefix = useId().replace(/[^A-Za-z0-9_-]/g, "");

  useEffect(() => {
    let active = true;
    if (wantsMath && !math) {
      void loadMath().then((loaded) => {
        if (active) setMath(loaded);
      }).catch(() => {
        if (active) setMathFailed(true);
      });
    }
    return () => {
      active = false;
    };
  }, [math, wantsMath]);

  const components: Components = {
    a: ({ node: _node, children, href, ...props }) =>
      href
        ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
    img: ({ node: _node, alt, src, ...props }) => {
      if (blockRemoteImages && src && blocksRemoteImageSource(src)) {
        return <ConsentImage {...props} src={src} alt={alt} />;
      }
      return (
        <img
          {...props}
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      );
    },
    pre: ({ node, children }) => {
      const only = Children.count(children) === 1 ? Children.only(children) : children;
      const className = isValidElement<{ className?: string }>(only)
        ? only.props.className
        : undefined;
      const language = codeLanguage(className);
      const code = reactText(only).replace(/\n$/, "");
      if (language === "mermaid") {
        const fence = artifactForFence(mermaidFences, code, language, node?.position?.start.line);
        const mermaidIndex = fence ? mermaidFences.indexOf(fence) : -1;
        return mermaidIndex >= 0 && mermaidIndex < MAX_RENDERED_MERMAID_DIAGRAMS
          ? <MermaidDiagram source={code} />
          : <MermaidSourceFallback source={code} />;
      }
      const startLine = node?.position?.start.line;
      const artifact = artifactForFence(artifacts, code, language, startLine);
      if (artifactsEnabled && artifact?.artifact) {
        return <ArtifactBlock artifact={artifact} idPrefix={idPrefix} />;
      }
      return <pre>{children}</pre>;
    },
  };

  const remarkPlugins = math ? [remarkGfm, math.remarkMath] : [remarkGfm];
  const katexOptions: RehypeKatexOptions = {
    strict: "error",
    trust: false,
    output: "htmlAndMathml",
    errorColor: "#b42318",
  };
  const rehypePlugins = math
    ? [
      rehypeHighlight,
      [math.rehypeKatex, katexOptions] as [typeof math.rehypeKatex, RehypeKatexOptions],
    ]
    : [rehypeHighlight];

  return (
    <div className={className} data-rich-markdown>
      {wantsMath && !math && !mathFailed && (
        <span className="sr-only" role="status">Loading math formatting</span>
      )}
      {mathFailed && <MarkdownSourceFallback source={source} />}
      {!mathFailed && (
        <MarkdownBoundary source={source}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
            skipHtml
            urlTransform={defaultUrlTransform}
          >
            {source}
          </ReactMarkdown>
        </MarkdownBoundary>
      )}
    </div>
  );
}
