import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = (children as any)?.props?.children ?? "";
  const lang = /language-(\w+)/.exec((children as any)?.props?.className ?? "")?.[1] ?? "code";
  return (
    <div className="codeblock">
      <div className="codebar">
        <span>{lang}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(String(text)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          pre: CodeBlock as any,
          table: ({ children }) => <div className="tablewrap"><table>{children}</table></div>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
