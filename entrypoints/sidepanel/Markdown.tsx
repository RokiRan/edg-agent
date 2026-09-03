import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Agent 交付内容的 Markdown 渲染：深色主题排版，链接新标签打开。 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="edg-md min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-snug text-[#d6dbe3]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-2 text-base font-semibold text-[#e6e9ee] first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1.5 mt-2 text-[15px] font-semibold text-[#e6e9ee] first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-1.5 text-sm font-semibold text-[#e6e9ee] first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-1 text-sm font-semibold text-[#d6dbe3] first:mt-0">{children}</h4>
          ),
          p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-1.5 list-disc pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-1.5 list-decimal pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="marker:text-[#5d6675]">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="break-all text-amber-300/90 underline decoration-amber-300/30 underline-offset-2 hover:text-amber-200"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-[#e6e9ee]">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="mb-1.5 border-l-2 border-[#2a3340] pl-3 text-[#aab2bf] last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-[#232b36]" />,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return <code className="font-mono text-[12px] text-[#d6dbe3]">{children}</code>;
            }
            return (
              <code className="break-all rounded border border-[#2f3a47] bg-[#181e27] px-1 py-px font-mono text-[12px] text-amber-300/90">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-1.5 overflow-x-auto rounded-md border border-[#232b36] bg-[#0c0f14] p-2.5 last:mb-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-1.5 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[#2a3340] bg-[#181e27] px-2 py-1 text-left font-semibold text-[#e6e9ee]">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-[#2a3340] px-2 py-1 align-top">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
