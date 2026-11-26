import { useCallback, useEffect, useRef, useState } from "react";
import { api, continueMessage, sendMessage, type Chat, type Message, type Video } from "../api";
import { copyText, readClipboard } from "../clipboard";
import { DetailsPanel } from "./DetailsPanel";
import { Markdown } from "./Markdown";
import { ProgressBar } from "./ProgressBar";

const SUGGESTIONS = [
  "Give a detailed breakdown with every tool, person, resource and number",
  "What links and GitHub repos are mentioned?",
  "Explain the main concept step by step",
  "What are the key practices and rules the speakers recommend?",
];

type Props = { chat: Chat; video: Video | null; onNewChat: () => void; onUpdated: () => void };

export function ChatWindow({ chat, video, onNewChat, onUpdated }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false); // this page is watching the answer arrive
  const [error, setError] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const reload = useCallback(
    () => api.messages(chat.id).then((m) => { setMessages(m); setLoaded(true); }).catch((e) => setError(e.message)),
    [chat.id],
  );
  useEffect(() => { void reload(); }, [reload]);

  // The server writes answers in the background. If one is still being written and this page is not watching
  // it live (page reopened, connection dropped), read its progress from the server until it is done.
  const generating = messages.some((m) => m.role === "assistant" && m.status === "generating");
  useEffect(() => {
    if (!generating || streaming) return;
    const t = setInterval(() => { void reload(); }, 1500);
    return () => clearInterval(t);
  }, [generating, streaming, reload]);
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !generating) onUpdated(); // refresh sidebar titles / order when an answer finishes
    wasGenerating.current = generating;
  }, [generating]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  const patchLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  const finish = (end: { status: Message["status"]; error: string } | null) => {
    if (end) patchLast((m) => ({ ...m, status: end.status, error: end.error }));
    else void reload(); // the stream ended early; the server keeps writing, so read the result from it
  };

  const send = async (text: string, editFromId?: string) => {
    const content = text.trim();
    if (!content || streaming || generating) return;
    setInput("");
    setEditing(null);
    setError("");
    setStreaming(true);
    setMessages((ms) => {
      const base = editFromId ? ms.slice(0, Math.max(0, ms.findIndex((m) => m.id === editFromId))) : ms;
      return [...base, { role: "user", content, status: "done" }, { role: "assistant", content: "", status: "generating" }];
    });
    try {
      const end = await sendMessage(chat.id, content, {
        onMeta: ({ userId, assistantId }) =>
          setMessages((ms) => ms.map((m, i) => (i === ms.length - 2 ? { ...m, id: userId } : i === ms.length - 1 ? { ...m, id: assistantId } : m))),
        onDelta: (d) => patchLast((m) => ({ ...m, content: m.content + d })),
      }, editFromId);
      finish(end);
    } catch (err) {
      setError((err as Error).message);
      void reload();
    } finally {
      setStreaming(false);
      onUpdated();
    }
  };

  const stop = async () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (last?.id) await api.stopAnswer(chat.id, last.id).catch((e) => setError(e.message));
  };

  const resume = async (m: Message) => {
    if (!m.id || streaming || generating) return;
    setError("");
    setStreaming(true);
    setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: "generating", error: "" } : x)));
    try {
      const end = await continueMessage(chat.id, m.id, {
        onDelta: (d) => setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, content: x.content + d } : x))),
      });
      if (end) setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: end.status, error: end.error } : x)));
      else void reload();
    } catch (err) {
      setError((err as Error).message);
      void reload();
    } finally {
      setStreaming(false);
      onUpdated();
    }
  };

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500); }
    else setError("Couldn't copy. Select the text and press Ctrl+C instead.");
  };

  const paste = async () => {
    const text = await readClipboard();
    if (text == null) { setError("The browser blocked reading the clipboard. Press Ctrl+V in the box instead."); return; }
    const ta = taRef.current;
    const start = ta?.selectionStart ?? input.length, end = ta?.selectionEnd ?? input.length;
    setInput(input.slice(0, start) + text + input.slice(end));
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(start + text.length, start + text.length); });
  };

  const empty = loaded && messages.length === 0;
  const busy = streaming || generating;

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <div className="head-row">
            <h2>{video ? video.title : "All videos"}</h2>
            <button className="ghost" onClick={onNewChat} title="Start a fresh conversation">New chat</button>
          </div>
          {video && (
            <div className="chips">
              <span className="chip accent">{video.category}</span>
              {video.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
              <button className="textbtn" onClick={() => setShowSummary((s) => !s)}>
                {showSummary ? "Hide details" : "Details"}
              </button>
            </div>
          )}
          {video && video.insights_ready === false && (
            <div className="inline-progress">
              <ProgressBar value={video.progress ?? 60} busy={!!video.stage_detail} label="Detailed breakdown progress" />
              <span>{video.stage_label || "Building the detailed breakdown"} · {video.progress ?? 60}%{video.stage_detail ? ` · ${video.stage_detail}` : ""}</span>
            </div>
          )}
          {!video && <p className="hint">Questions are answered across every video you've added.</p>}
          {video && showSummary && <DetailsPanel video={video} onUpdated={onUpdated} />}
        </div>
      </header>

      <div className="scroll">
        <div className="column">
          {empty && (
            <div className="welcome">
              <div className="logo">✺</div>
              <h3>What would you like to know?</h3>
              <p>Ask anything about {video ? "this video" : "your videos"}. Answers are grounded in the transcript.</p>
              <div className="suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const key = m.id ?? `local-${i}`;
            if (m.role === "user") {
              return (
                <div key={key} className="msg user">
                  {editing && m.id && editing.id === m.id ? (
                    <div className="editbox">
                      <textarea
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ id: editing.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(editing.text, editing.id); }
                          if (e.key === "Escape") setEditing(null);
                        }}
                        rows={Math.min(10, Math.max(2, editing.text.split("\n").length))}
                      />
                      <div className="editactions">
                        <span className="hint">Editing asks again and replaces everything after this message.</span>
                        <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="primary" disabled={!editing.text.trim() || busy} onClick={() => send(editing.text, editing.id)}>Save and resend</button>
                      </div>
                    </div>
                  ) : (
                    <div className="ubody">
                      <div className="bubble">{m.content}</div>
                      <div className="mactions">
                        <button onClick={() => copy(key, m.content)}>{copied === key ? "Copied" : "Copy"}</button>
                        {m.id && <button disabled={busy} onClick={() => setEditing({ id: m.id!, text: m.content })}>Edit</button>}
                      </div>
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={key} className="msg assistant">
                <span className="avatar">✺</span>
                <div className="mbody">
                  {m.content ? <Markdown text={m.content} /> : m.status === "generating" ? <span className="thinking">Thinking<i>.</i><i>.</i><i>.</i></span> : null}
                  {m.status === "generating" && m.error && <p className="hint">{m.error}</p>}
                  {(m.status === "incomplete" || m.status === "stopped") && (
                    <div className="cutoff">
                      <span>{m.status === "stopped" ? "Stopped." : m.error || "This answer was cut off."}</span>
                      {m.id && <button className="textbtn" disabled={busy} onClick={() => resume(m)}>Continue</button>}
                    </div>
                  )}
                  {m.content && (
                    <div className="mactions">
                      <button onClick={() => copy(key, m.content)}>{copied === key ? "Copied" : "Copy"}</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-wrap">
        <div className="column">
          {error && <p className="banner">{error}</p>}
          <form
            className="composer"
            onSubmit={(e) => { e.preventDefault(); if (!busy) void send(input); }}
          >
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busy) void send(input); }
              }}
              placeholder={video ? "Ask about this video…" : "Ask across all your videos…"}
            />
            <button type="button" className="iconbtn" onClick={paste} title="Paste from clipboard" aria-label="Paste from clipboard">📋</button>
            {busy ? (
              <button type="button" className="send stop" onClick={stop} title="Stop answering" aria-label="Stop">■</button>
            ) : (
              <button className="send" disabled={!input.trim()} aria-label="Send">↑</button>
            )}
          </form>
          <p className="fineprint">Answers are written on the server, so you can close this page and come back. They come from video transcripts and can be wrong.</p>
        </div>
      </div>
    </div>
  );
}
