import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Chat, type Video } from "./api";
import { readActiveId, readChats, writeActiveId, writeChats } from "./chatCache";
import { AddVideoForm } from "./components/AddVideoForm";
import { ChatWindow } from "./components/ChatWindow";
import { ProcessingView } from "./components/ProcessingView";
import { RecentChats } from "./components/RecentChats";
import { VideoList } from "./components/VideoList";

const isReady = (v: Video) => v.status === undefined || v.status === "ready";

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  // Chat names and the last open chat come from the browser cache first (instant), then the server replaces them.
  const [chats, setChats] = useState<Chat[]>(() => readChats() as Chat[]);
  const [activeChat, setActiveChat] = useState<Chat | null>(() => {
    const id = readActiveId();
    return (id && (readChats().find((c) => c.id === id) as Chat | undefined)) || null;
  });
  const [viewingId, setViewingId] = useState<string | null>(null); // a video that is still processing
  const [menuOpen, setMenuOpen] = useState(false);
  const [synced, setSynced] = useState(false);

  const refresh = useCallback(async () => {
    const [v, c] = await Promise.all([api.videos(), api.chats()]);
    setVideos(v);
    setChats(c);
    writeChats(c);
    setSynced(true);
    // keep the open chat's name fresh; forget it if it was deleted elsewhere
    setActiveChat((a) => (a ? c.find((x) => x.id === a.id) ?? null : a));
  }, []);
  useEffect(() => { refresh().catch(console.error); }, [refresh]);
  useEffect(() => { if (synced) writeActiveId(activeChat?.id ?? null); }, [activeChat?.id, synced]);

  // Processing and answers run on the server whether or not this page is open. While anything is in progress,
  // keep reading its progress; when everything is idle, stop polling.
  const processing = videos.some((v) => v.status === "processing");
  const analysing = videos.some((v) => isReady(v) && v.insights_ready === false);
  const writing = chats.some((c) => c.generating);
  useEffect(() => {
    if (!processing && !analysing && !writing) return;
    const timer = setInterval(() => refresh().catch(() => {}), processing || writing ? 2500 : 6000);
    return () => clearInterval(timer);
  }, [processing, analysing, writing, refresh]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refresh().catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const startChat = async (videoId: string | null) => {
    // reuse the latest chat for this video (the list is newest first) so memory persists
    const existing = chats.find((c) => c.video_id === videoId);
    const chat = existing ?? (await api.newChat(videoId));
    if (!existing) setChats((cs) => [chat, ...cs]);
    setViewingId(null);
    setActiveChat(chat);
    setMenuOpen(false);
  };

  const newChat = async (videoId: string | null) => {
    const chat = await api.newChat(videoId);
    setChats((cs) => [chat, ...cs]);
    setActiveChat(chat);
  };

  const openChat = (c: Chat) => { setViewingId(null); setActiveChat(c); setMenuOpen(false); };

  const removeChat = async (c: Chat) => {
    await api.deleteChat(c.id);
    if (activeChat?.id === c.id) setActiveChat(null);
    await refresh();
  };

  const select = (v: Video) => {
    setMenuOpen(false);
    if (isReady(v)) return void startChat(v.id);
    setActiveChat(null);
    setViewingId(v.id);
  };

  // When the video being watched finishes indexing, open its chat.
  const viewing = useMemo(() => videos.find((v) => v.id === viewingId) ?? null, [videos, viewingId]);
  useEffect(() => {
    if (viewing && isReady(viewing)) startChat(viewing.id).catch(console.error);
  }, [viewing?.status]);

  const activeVideo = useMemo(
    () => videos.find((v) => v.id === activeChat?.video_id) ?? null,
    [videos, activeChat],
  );

  const remove = async (v: Video) => {
    await api.deleteVideo(v.id);
    if (viewingId === v.id) setViewingId(null);
    if (activeChat?.video_id === v.id) setActiveChat(null);
    await refresh();
  };

  return (
    <div className="layout">
      <button className="menu" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">☰</button>
      <aside className={menuOpen ? "open" : ""}>
        <div className="brand"><span className="logo">✺</span> Video Chat</div>
        <button className="newchat" onClick={() => startChat(null)}>＋ Chat across all videos</button>
        <AddVideoForm
          onAdded={async (v) => {
            await refresh();
            if (isReady(v)) await startChat(v.id); // already added before
            else { setActiveChat(null); setViewingId(v.id); }
          }}
        />
        <RecentChats chats={chats} videos={videos} activeId={viewingId ? null : activeChat?.id ?? null} onOpen={openChat} onDelete={removeChat} />
        <div className="label">Library</div>
        <VideoList
          videos={videos}
          activeVideoId={viewingId ?? activeChat?.video_id ?? null}
          onSelect={select}
          onDelete={remove}
          onRetry={async (v) => { await api.retryVideo(v.id); await refresh(); setActiveChat(null); setViewingId(v.id); }}
        />
      </aside>
      <main>
        {viewing && !isReady(viewing) ? (
          <ProcessingView
            video={viewing}
            onRetry={async () => { await api.retryVideo(viewing.id); await refresh(); }}
            onDelete={() => remove(viewing)}
          />
        ) : activeChat ? (
          <ChatWindow key={activeChat.id} chat={activeChat} video={activeVideo} onNewChat={() => newChat(activeChat.video_id)} onUpdated={() => refresh().catch(console.error)} />
        ) : (
          <div className="home">
            <div className="logo big">✺</div>
            <h1>Learn from any tech video</h1>
            <p>Paste a YouTube link in the sidebar. It is processed in the background, so you can close this page and come back later. I'll pull the transcript, file it under a topic, and answer your questions about it.</p>
          </div>
        )}
      </main>
    </div>
  );
}
