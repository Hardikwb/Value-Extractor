# Setup Report: Problems Faced and How They Were Resolved

Project: YouTube video chatbot (Express + React, TypeScript, Neon Postgres with pgvector, Groq LLM).
This report covers the problems hit while getting the server to start and connect to the database.

## 1. Server crashed on startup: `sharp` module not found

- **Symptom:** `Cannot find module '../build/Release/sharp-linux-x64.node'` when running `pnpm dev`.
- **Cause:** pnpm 12 does not run dependency install scripts by default. `sharp` (required by `@xenova/transformers`, which creates the local embeddings) was installed but never built.
- **Fix:** allowed the build scripts in `pnpm-workspace.yaml` and rebuilt.
  ```yaml
  allowBuilds:
    sharp: true
    esbuild: true
    protobufjs: true
  ```
  Then `pnpm rebuild`. The server then started and printed `API on http://localhost:3001`.
- **Note:** `onlyBuiltDependencies` in `package.json` and in the workspace file did not work with this pnpm version. Only `allowBuilds` did.

## 2. `ErrorEvent` on every database call (Neon serverless driver)

- **Symptom:** the server logged bare `ErrorEvent { type: 'error', ... }` objects and no useful message.
- **Cause:** the Neon serverless driver connects over WebSocket. The WebSocket connection was failing, and the driver surfaces that as an opaque `ErrorEvent`.
- **Fix attempt:** swapped to the standard `pg` driver. This led to problem 3.

## 3. `pg` driver: `ETIMEDOUT` on port 5432 and `ENETUNREACH` on IPv6

- **Symptom:** `connect ETIMEDOUT 3.142.41.151:5432` and `connect ENETUNREACH 2600:...:5432`.
- **Cause:** the user's network could not reach raw Postgres port 5432 (blocked or unroutable), and the machine had no IPv6 route. This was a connection problem, not a migration problem.
- **Fix attempt:** go back to the Neon driver, which uses port 443, with the `ws` package supplied as the WebSocket implementation. This led to problem 4.

## 4. WebSocket closed with code 1006 during `pnpm migrate`

- **Symptom:** `ErrorEvent` with a `WebSocket` target and `_closeCode: 1006` (closed before opening).
- **Diagnosis:** a reachability test showed port 443 was open over IPv4 and the host answered HTTPS. Only the WebSocket upgrade was failing. The exact reason for the WebSocket failure was not isolated.
- **Fix:** stopped using WebSockets. Switched to Neon's HTTP query mode.
  - `server/src/db/client.ts` now uses `neon(DATABASE_URL)` and `sql.query(...)`.
  - `server/src/db/migrate.ts` splits `schema.sql` on `;` and runs one statement per request, because HTTP mode allows one statement per call.
  - Removed the `ws` and `pg` dependencies.

## 5. HTTP mode: `fetch failed` / `ETIMEDOUT` on port 443

- **Symptom:** `NeonDbError: Error connecting to database: TypeError: fetch failed`, with `ETIMEDOUT` for each IPv4 address on port 443 and `ENETUNREACH` for each IPv6 address.
- **Puzzle:** `curl` connected to all three Neon IPs (HTTP 400, which is expected for a bare request) in 0.3 to 0.8 seconds, but Node's `fetch` timed out every time.
- **Root cause:** Node 22 tries each address for only 250 ms by default (`autoSelectFamilyAttemptTimeout`). The user's link takes about 330 to 800 ms to connect, so every attempt was abandoned before it finished.
- **Verification:** a Node `fetch` test with the timeout raised to 5 seconds reached Neon (HTTP 400 in about 1.5 s).
- **Fix:** added this at the top of `server/src/config.ts`, which both `pnpm dev` and `pnpm migrate` load first:
  ```ts
  import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
  setDefaultAutoSelectFamilyAttemptTimeout(5000);
  ```

## 6. Groq model not supported

- **Symptom:** the originally configured models (`llama-3.3-70b-versatile` for chat and `llama-3.1-8b-instant` for categorizing) could not be used.
- **Fix:** the user changed both constants in `server/src/services/llm.ts` to `openai/gpt-oss-120b`.
- **Not diagnosed:** the exact reason the Llama models were rejected (retired model, account access, or something else) was not investigated in this session. Check the model list at console.groq.com if you want to know, since available models change over time.

## 7. Process note: a command was blocked by the permission check

- **What happened:** a single command that swapped the database driver and also ran `pnpm migrate` was denied. The migration writes to a remote database using the credentials in `.env`, and it was run without asking first.
- **Resolution:** the code changes were made separately, and the user ran `pnpm migrate` themselves.

## 8. `column "status" does not exist` after the update

- **Symptom:** `NeonDbError: column "status" does not exist` from `GET /api/videos` and from adding a video.
- **Cause:** the code was updated to use new columns, but the schema was only applied by running `pnpm migrate` by hand. Code and database drifted apart.
- **Fix:** the server now applies `schema.sql` on every start (`server/src/db/migrations.ts`, called from `index.ts`). Every statement is `IF NOT EXISTS`, so it is safe to repeat. If the migration fails the server exits instead of serving a broken API.

## 9. The transcript was in the wrong language (found while verifying)

- **Symptom:** keyword search never matched anything, vector similarity was low, yet answers still looked fine.
- **Cause:** `youtube-transcript` takes the *first* caption track YouTube lists when no language is given. For the test video that was Arabic. The model translated on the fly, which hid the problem. The English embedding model and English text search could not work on Arabic text.
- **Fix:** always request English (accepting `en-US` / `en-GB`), and reject transcripts that are mostly non-Latin letters. The index version string in `embeddings.ts` was bumped so previously indexed videos are rebuilt when re-added.
- **Related:** the library returns milliseconds for one caption format and seconds for the other. Timestamp units are now detected from the data and unit tested. Checked against a real video: last chunk at 8:07 of a 9-minute video.

## 10. Hallucinated tools and steps

- **Symptom:** asked which tools the CI/CD section uses, the bot named GitHub Actions, Jenkins and Docker Hub with timestamps. A long tool list also contained Prometheus, Datadog, PagerDuty, pytest, JUnit and GraphQL.
- **How it was checked:** every claimed term was searched in the stored transcript (whole-word match; an early check wrongly "found" `ecr` inside the word `secret`). None of those names appear in the video.
- **Causes:** the outline prompt asked the model to "name the specific tools", so it added tools that are typical for the topic, and those summaries also fed the tags. The answer prompt did not forbid filling gaps. At low reasoning effort the model also padded process descriptions with typical steps.
- **Fixes:** both prompts now say to name only what the text names and describe only the steps it states; the outline is sent only for whole-video questions; answers use `reasoning_effort: "medium"` (background summaries stay `low`); the similarity floor was raised to 0.55.
- **Result:** the same questions now answer "The video does not name any specific CI/CD tools" and all 24 items in the rebuilt tool list were found in the transcript.

## 11. Slow answers and fragile background work

- **Symptom:** 15 to 45 seconds per answer; the background outline died with `Connection error` and never retried.
- **Causes:** each database call costs 1 to 1.5 s on this link and many ran one after another; the Groq SDK's own retries were switched off, so one network blip was fatal; a failed outline was never retried.
- **Fixes:** parallel reads in the chat route, user message stored while the answer is prepared, rewrite only for real follow-ups, no passage search for whole-video questions, smaller prompts. Retries now cover connection errors as well as rate limits. One failed section no longer loses the whole outline, outlines are finished automatically on startup, and `POST /api/videos/:id/outline` rebuilds one. Answers now take about 4 to 8 s.

## 12. Other bugs fixed

- The question was sent to the model twice (history was read after saving it).
- A failed or cancelled answer left a question with no reply; now it is removed and cancelling stops the Groq call.
- Adding a video cost one database round trip per chunk; it now inserts in batches, and two simultaneous adds of the same link return `409` instead of a 500.
- Keyword search dropped two-letter terms such as "CI" and "CD".

## 13. The summary was shallow, and the GitHub link was nowhere in the data

- **Symptom:** for "How Google engineers build AI agents in production" the stored result was a 2-sentence summary and a 10-entry outline of 2 to 3 sentences each. Asked about the GitHub repo shown in the video, the app had nothing.
- **Cause:** the app only read the spoken transcript. "github" appears 0 times in the audio. The repo link, the speakers and their roles, the creator's own 24-entry chapter list, and a "Products Mentioned" list with correct spellings are all in the **video description**, which was never fetched. Captions also garble names ("Cloud Code" for Claude Code).
- **Fix (`services/metadata.ts`, `insights.ts`, `insights-utils.ts`):**
  - Read the description from the watch page; parse chapters, labelled links and the products list; follow short links (`g.dev/ai/github-skills` resolves to `https://github.com/google/skills`).
  - Split the transcript by the creator's chapters (tiny ones merged, huge ones split), or into fixed windows when there are none, so the whole transcript is read.
  - Per chapter, extract a 3 to 5 sentence summary, key points, tools (with what the speaker says each does), people, named resources, numbers and explicit practices. The description's spelling is used to repair garbled names.
  - Everything extracted is checked against the transcript plus description; unsupported names are dropped, and numbers are kept only if their digits appear in the chapter text.
  - Assemble a markdown breakdown (overview, framework, takeaways, people, tools, resources and links with GitHub flagged, numbers, practices, chapter by chapter with clickable timestamps). Whole-video questions ("details", "links", "speakers", "everything") are answered from it; every question also sees the speakers and links.
- **Result on that video:** 24 chapters, 6 links including the GitHub repo, 5 speakers with their layers, the framework (Learn, Guard, Review, Score), and about 36,000 characters of structured breakdown, against about 5,600 before.
- **How it was checked:** all extracted numbers were traced to the transcript (150 skills, "under 30 seconds", the 80% flakiness threshold, a 200,000-line PR, 10 PRs of 20,000 lines, orders 101 and 202). This also showed the earlier outline had the flakiness threshold wrong (100%, actually 80%).
- **Known imperfections:** a few number labels are loose (for example "5 minutes" is really "code that was working fine 5 minutes ago"); cited timestamps are the start of a search chunk, so they can be up to a minute early; generic items such as "command line" can slip into the tools list.
- **Not covered:** anything that appears only on screen, and in neither the audio nor the description. That would need frame analysis (`yt-dlp`, `ffmpeg` and a vision model), which is not set up here.

## 14. The answering model invented descriptions

- **Symptom:** in a detailed breakdown the bot described Antigravity as an "internal prototyping tool", Cloud Run as a "deployment target" and called Claude Code and Codex "comparative models".
- **Cause:** the stored tool list held only names, so the model filled in purposes from its own assumptions.
- **Fix:** tools now carry a short description taken from what the speaker says (empty if not stated), and the answer prompt forbids describing a tool, product or person unless the material does.

## 15. Free-tier limits were the real bottleneck

- **Symptom:** a rebuild stalled for 12+ minutes on `429` errors, then chat answers failed too.
- **Cause:** the error text was `tokens per day (TPD): Limit 200000, Used 199109`. The free daily budget (about 200,000 tokens per model) was spent by repeated rebuilds and by the automatic background job for the 3-hour course, which restarted from scratch every time a source file was saved. My retry code could not tell a daily limit from a per-minute one and kept retrying.
- **Also found:** the Llama models are no longer on the key (the model list shows `gpt-oss-120b`, `gpt-oss-20b`, `gpt-oss-safeguard-20b`, `qwen3.8-27b`). That is why the originally suggested models were "not supported" (item 6).
- **Fixes:**
  - Bulk background work (chapter extraction, overview, categorising, follow-up rewrites) runs on `gpt-oss-20b`, falling back to `qwen3.8-27b` if its daily budget is spent. Final answers stay on `gpt-oss-120b`. Override with `BULK_MODELS` and `CHAT_MODEL`.
  - Retries wait exactly as long as `Retry-After` says; if the wait is longer than a request can reasonably hold (a daily limit), they fail at once, and the chat shows "Groq's free daily token limit for this model is used up. It frees up in about …".
  - Each finished chapter is saved to the database, so a restart or a rate limit resumes instead of paying again; a heartbeat marks live jobs and a crashed one is picked up after 6 minutes; claims are released on shutdown.
  - A failure in the final overview step no longer discards the extracted work.
- **Budget to expect:** one deep analysis of a 30-minute video costs roughly 50,000 tokens; the 3-hour course costs several times that. The free tier allows only a few such videos per day.

## 16. Background processing with a live progress bar

- **Before:** adding a video was one long request (20 to 100 s) with a spinner; the video was invisible until fully indexed; a failure silently removed it; the detailed breakdown ran in the background with no visible status; rebuilding an outdated video deleted its row and so its chats.
- **Now:** adding returns in under a second (`202`, the video appears at once). The work runs in a server-side queue and its progress is stored in the video's row, so closing the page changes nothing and reopening shows the current stage.
  - Stages: waiting, fetching transcript, reading details, categorizing, indexing (n of m chunks), saving (chat opens here), analysing chapters (n of m), writing the overview, ready.
  - UI: a progress bar and stage label in the sidebar, a "processing" screen with a step checklist, a slim bar in the chat header while the breakdown is still building, a failed state with the reason and a retry button. The page polls only while something is in progress.
  - Rate limits show as a note on the bar ("Waiting for Groq's rate limit (about 40 s)").
  - Deleting a video mid-processing cancels the job; chat on an unfinished video says so; videos are re-indexed in place so chats are kept.
- **Recovery:** each job keeps a heartbeat. A clean shutdown hands jobs over immediately on the next start; after a hard kill they are picked up when the heartbeat goes stale (about 3 minutes). Finished chapters are saved, so a restart does not pay for them again.
- **Verified:** add returns `202` in about 0.7 s; stage timeline from queued to ready with progress never decreasing; the client disconnected while it ran; clean restart mid-job resumed and finished; `kill -9` mid-job recovered about 3.5 minutes later; cancel, duplicate (`409`), chat-while-processing (`409`), failure plus retry, and in-place re-index keeping chats.
- **Bugs found by those tests and fixed:** a re-indexed video stayed on "Analysing 60%" because its breakdown was already current (now finished directly, plus a self-heal that corrects any such row); a delete during saving logged a false "processing failed" (now treated as a cancel); adding cost three database round trips (now one); stopgap overviews were not flagged, so the repair never found them (now flagged and repaired).
- **Limits:** after a hard kill the bar stays frozen for about 3 minutes before the job resumes; closing the *server* pauses jobs until it is started again (a hosted deployment would keep them running); the visual styling has not been checked in a browser.

## 17. Answers stopped when the page closed (the "Senior" chat)

- **Symptom:** the saved answer in the "What Makes a Developer 'Senior'" chat was 1,546 characters and ended mid-sentence (`**[1:58]`), yet looked finished. Closing or reloading the page mid-answer lost the rest.
- **Cause:** the answer was generated inside the HTTP request. When the browser disconnected, my code cancelled the model call and then saved the fragment as a normal message. Video processing was already a server job; chat answers were not.
- **Fix:** answers are now written by the server in the background and saved as they go (every ~1.5 s). The page only watches. Closing it changes nothing; reopening shows the text so far and then the finished answer. Only the Stop button cancels.
  - Each message has a status (`generating`, `done`, `incomplete`, `stopped`). A cut-off or failed answer is never shown as finished: it keeps its text, says why, and has a Continue button.
  - A model "length" cut-off is detected and continued automatically (up to twice), quoting the last words written so the answer resumes at the right place.
  - Server restarts: a clean shutdown hands answers over immediately; after a hard kill they are picked up when the heartbeat goes stale (about 2 to 3 minutes). Both continue from the saved text.
  - Edit replaces a message and everything after it, then asks again.
- **Also found while testing, and fixed:**
  - **Request too large:** Groq counts input tokens plus `max_tokens` against a hard per-request cap (8,000 on `gpt-oss-20b`). Answers asked for 6,000 to 8,000 output tokens on top of a big prompt and were rejected. The output budget now shrinks to fit (using the numbers in the error), and if the prompt itself is too big it is retried once in a compact form.
  - **Rate limits:** answers now wait out per-minute limits in the background (a note shows on the message) instead of failing after about a minute; Stop works during the wait. A daily limit fails at once with a readable message and the answer falls back to the next model.
  - **Model fallback for answers:** `gpt-oss-120b`, then `qwen3.8-27b`, then `gpt-oss-20b` (each has its own daily budget). Override with `CHAT_MODELS`.
  - **Startup:** one database connection timeout used to make the server exit, leaving the app down (the dev watcher does not restart a crashed app). Startup now retries connection problems until the database answers.
  - **Races:** "stopped elsewhere" was mistaken for "deleted", and a finished answer was dropped from the live list before its final save; both fixed.
  - **Edit box bug (caught by the type checker):** a message with no id yet compared `undefined === undefined` and would have opened an empty editor.
- **Chat UI:** the chat column is wider (up to 1180 px); copy on every message, edit on your messages, a paste button in the box (Ctrl+V still works), Stop and Continue; wide tables scroll inside the message. The sidebar lists recent chats (latest first, with a pulsing dot while one is being answered), and the chat names and the last open chat are cached in the browser so they appear instantly and reopen after a reload.
- **Run it in the background:** `pnpm bg:start` builds the web app and starts one detached process (own session, no terminal) that serves both the UI and the API; `bg:status`, `bg:logs`, `bg:stop`, `bg:restart`. Verified: UI and deep links served, an answer begun and the client dropped finished and was saved, the process is a session leader without a terminal, stop closes the port.
- **Verified:** answer finished after the client hung up (3,649 characters against the old 1,546); Stop then Continue (text kept, finished); clean shutdown and `kill -9` mid-answer both resumed to completion; reload mid-answer showed the text growing; second send in a busy chat refused (`409`); edit replaced the later messages and reset the title; forced length cut-off continued automatically; two chats answering at once.
- **Limits:** the free daily token budgets are small (about 200,000 per model per day) and testing used most of them, so expect "daily limit" messages for a while; I could not view the new UI in a browser; the old truncated answer is left as stored (use Edit to ask again). Test chats created while verifying this are still in the chat list and can be deleted with the × in the sidebar.

## 18. Interview prep: top 5 questions, plus your own notes and description

- **Request:** use a video like the KodeKloud Short (https://www.youtube.com/shorts/fUxLOKoAhTg) for interview preparation: take the video and the user's notes and generate the top 5 innovative, critical, high-level thinking questions, offered as a prompt next to the four starter prompts.
- **What was built:**
  - A fifth, full-width **Interview prep** starter chip on the empty chat. The server recognises interview requests by wording (the word "interview" plus "question"), so edited wording still works, and answers them from the whole-video breakdown.
  - An instruction block (`services/interview.ts`) appended after the video's material: exactly five questions on five different angles (trade-offs, failure modes and abuse, scale and cost, security and privacy, proving the fix, 10x load), each with a difficulty, why it separates strong candidates, what a strong answer covers, a follow-up probe and a "From the video" line; outside knowledge in the bullets is marked "Beyond the video:"; timestamps only when the video has more than one timed part.
  - **My notes:** `videos.user_description` and `videos.user_notes`, saved when adding a video (optional "Add your notes" area) or later in the Details panel ("My notes", with Save), through `POST /api/videos` and `PUT /api/videos/:id/notes`. They are given to the model as the user's own words (never as the video's), so they steer every answer about that video, interview questions included.
- **Problems found while testing on the real Short, and fixes:**
  - Every "From the video" timestamp read `(0:00)`: the Short has a single section. The prompt now says to give none in that case.
  - **Fabricated quotations.** My first fix asked the model to quote numbers in quotation marks. 10 of the 11 "quotes" it produced were paraphrases that were not in the video (checked against the transcript). That rule was removed; the prompt now bans quotation marks and instead gives the model a short list of the video's own number-bearing sentences to copy unchanged (`numberSentences`).
  - **A reversed scenario:** one run treated the video's 10-second login delay (the problem) as a goal. The prompt now says to keep problem, cause and fix apart.
  - Unlabelled outside knowledge (GDPR, A/B testing): the "Beyond the video:" requirement moved into the output template itself, after which it was followed (5 to 10 labels per answer).
  - **My own wrong conclusion, corrected:** I first reported that the model invented a rate ("50,000 per minute"). The transcript does say "Your login API is getting 50,000 login requests every minute", so that detail was correct. I had checked only the description and a pattern that left out "every minute". A deterministic guard I built on that premise (flag a rate phrase on a numeric line that the video text does not contain, then run one correction pass and show the corrected answer) is still in place because it is cheap and tested. In real runs it correctly did not fire; on a synthetic draft with "per second" it flagged the phrase, rewrote only that sentence and was accepted.
- **Result on the Short:** five distinct, senior-level questions per run, grounded in the video (bcrypt as the CPU bottleneck, the tiered defence, TLS fingerprinting, device trust tokens, the lock-out evasion detail that only the transcript contains), shaped by notes that asked for design trade-offs and cost/capacity reasoning.
- **Limits:** model output varies between runs; wording of the questions and the choice of angles differ each time. The guard covers rates only, not every possible invented detail. The UI (chip, notes editor) was built and type-checked but not viewed in a browser.
- **Cleanup:** the Short was already in the library, so my test notes were attached to your video and have been cleared again. A few test chats created on it during verification remain (delete them with the × in the sidebar).

## 19. Answer-type tags in the chat bar (Interview first)

- **Request:** put tags in the search bar so that choosing "Interview" gives a deep bullet-point summary first and then the top 5 innovative, critical, high-level thinking questions; other tags welcome.
- **What was built:** four tags above the chat box, picked per message and shown as a label on your message: **Interview** (a `## Summary` in bullets, then `## Top 5 interview questions`), **Deep summary** (bullets only), **Cheat sheet** (key terms, numbers, rules, commands, mistakes) and **Quiz** (8 flashcards plus 3 self-test questions). A tag can be sent with no text (its own request is stored as the message, and gives the chat its title), or with text, which is treated as a focus ("focus on security and privacy"). The old starter chip now just selects Interview and sends. Typed wording such as "give me 5 hard interview questions" still triggers Interview.
- **Design points:**
  - The tag is stored with the message (`messages.mode`) and read back whenever an answer is re-run, so **Continue, restart recovery and Edit keep the same tag**. Before, those paths re-ran from the question text alone and would have lost it.
  - All tags answer from the whole-video breakdown, with the video's own number-bearing sentences supplied for copying, and the same rules as before (no quotation marks, no added units or rates, "Beyond the video:" for outside knowledge).
  - Server: `services/modes.ts` (pure, tested); web: `modes.ts`, `ModeTags.tsx`, changes in `ChatWindow.tsx`.
- **Found while testing, and fixed:** the summary's "Numbers, tools and names" section pasted whole transcript sentences and repeated figures; the rule now asks for one short bullet per figure.
- **Verified on the KodeKloud Short:** Interview with no text gave 25 summary bullets under five headings, then exactly 5 questions with every part, no quotation marks and no meaningless timestamps; Interview plus a focus ("security and privacy") steered both parts (15 mentions); Deep summary had no questions; Cheat sheet and Quiz matched their formats; Stop then Continue kept the Interview format (finished with 5 questions); editing a message to another tag replaced the exchange and stored the new tag; a server restart mid-answer resumed as a full Interview answer; an ordinary question was unchanged; an unknown tag or an empty message with no tag is rejected with `400`. 80 server tests and 6 web tests pass.
- **Limits:** the tag row and chips were built and type-checked but not viewed in a browser. Output varies between runs. The Interview answer is long (7,000 to 10,000 characters), so it uses a lot of the free daily token budget. Test chats created while verifying are still in the chat list (delete with the × in the sidebar).

## 20. Videos with Hindi (or Hinglish) captions: "No English captions on this video (available: hi)"

- **Symptom:** adding a video failed with `Could not read the transcript. No English captions on this video (available: hi)`.
- **Cause:** the app only accepted an English caption track (an earlier fix, after an English video came back in Arabic). Two kinds of video fall outside that: genuinely Hindi videos, and very common **Hinglish** videos, where the audio is English but YouTube's auto-captions are labelled Hindi and written in Devanagari script (English words spelled phonetically, such as the Devanagari spelling of "three important"). The failing video here was the second kind.
- **Fix (`services/youtube.ts`, `translate-utils.ts`, `translate.ts`, `transcript.ts`):** the transcript now comes from the first of these that works:
  1. an English caption track (including en-US, en-GB and so on);
  2. **YouTube's own English translation** of the track that exists (requested with `tlang=en` on the caption download only, retried with growing pauses of 4, 10 and 20 seconds when YouTube answers 429 or a server error, but not when it genuinely does not offer translation);
  3. **the language model's translation** (batches of about 40 lines or 3,500 characters, translated as flowing text and spread back over the original timestamps, because models merge lines and a line-for-line match cannot be demanded). It is used only for transcripts up to 60,000 characters, so a very long non-English video does not use up the free token budget;
  4. otherwise the original-language text is kept and the video is labelled "Transcript in <language>".
  The source language and whether the text was translated are stored on the video, and the chat header shows an "Auto-translated from Hindi" label (with a note that names and technical terms can be garbled). Rebuilding a video's breakdown uses the same path.
- **How it was found and checked:** the failed video was `egv-CcolJZQ`, still in the list with its error. A direct test showed that the translation parameter returns clean English; later runs showed YouTube throttling it (HTTP 429, 5 of 6 tries, probably made worse by my repeated testing), which is why the retries and the model fallback exist. The first version of the model fallback was silently rejected because the model returns fewer lines than it is given; the log now says when a reply is unusable. After the fix the video went from failed to ready with `translated: true`, English chunks at sensible timestamps, a correct summary, and a grounded answer to a question with a citation. 95 server tests pass (new ones cover the caption-URL rewriting, retry rules, size cap, batching, reply parsing and the redistribution of translated text).
- **Limits:**
  - Machine translation of machine captions: product names and acronyms can be wrong (this video's "RAG" was heard as "drag" by YouTube's own captions, and that error is in the stored text).
  - The model fallback costs tokens (about 1,500 for a 3-minute video).
  - For a very long non-English video the original text is kept, so search is weaker.
  - Answers are given in English by default; asking in Hindi usually gets a Hindi reply, but that was not tested.
  - The first attempt for a throttled video takes about 40 seconds longer.
- **Using it:** open the failed video and press "Try again" (or add the link again); no other action is needed.

## 21. UI polish: wider sidebar, larger type, more spacing

- **Request:** make the UI better by widening the left sidebar and improving font size and spacing (shown with a screenshot at 1920x1080).
- **What the screenshot and the stylesheet showed:** a fixed 290px sidebar that cut chat and video titles off on one line ("Interview prep: a deep su"), 11 to 14px text in the sidebar and header, 15px base text, answer bullets only a few pixels apart, 22px between messages, and a default white scrollbar on a dark theme.
- **Changes (`web/src/styles.css` rewritten in sections around design tokens, every existing class kept):**
  - Sidebar: 340px by default (was 290), **draggable between 260 and 520px** (drag, arrow keys, Home/End, double-click to reset) and remembered in the browser; roomier padding and gaps; chat and video titles **wrap to two lines** instead of being clipped; larger text throughout; thin themed scrollbars.
  - Chat: base text 16px (was 15), answers 17.6px (was 16.3) with line height 1.75, more space between bullets and nested bullets, larger headings, header title and chips, message bubbles and action buttons; 30px between messages; larger composer, tag chips and starter cards; roomier Details panel and notes boxes.
  - Phones: the sidebar overlay uses up to 88% of the width, and the menu button no longer covers the title.
  - New: `components/SidebarResizer.tsx` and `sidebarWidth.ts` (clamping and remembering the width, with unit tests).
- **Verified in a real browser** (headless Chrome driven over its remote-debugging protocol) at 1920x1080 dark and light, 1280x800 and a 390px phone, before and after: no horizontal overflow at any size; and 13 scripted checks of the resizer all passed (default 340, drag, both limits, persistence across a reload, keyboard, reset) plus the Details panel opening.
- **Two defects found by looking, and fixed:** a stray third line of a long title showing through the padding of the two-line clamp in the library list (the clamp now sits on an inner element), and the phone menu button overlapping the "Video Chat" title.
- **Also found by the tests:** the width helper treated `null` as 0 and clamped it to the minimum instead of using the default.
- **Limits:** the numbers are a first pass and easy to tune. Two-line titles make rows taller, so fewer chats fit before the sidebar scrolls. The screenshot tooling was a temporary script and was not added to the repo.

## Final working setup

| Area | Choice | File |
| --- | --- | --- |
| Database access | Neon HTTP query mode over port 443 (no WebSocket, no raw Postgres port) | `server/src/db/client.ts` |
| Migration | `schema.sql` run one statement at a time | `server/src/db/migrate.ts` |
| Slow-link fix | 5 s per-address connect attempt timeout | `server/src/config.ts` |
| Native build scripts | `sharp`, `esbuild`, `protobufjs` allowed | `pnpm-workspace.yaml` |
| LLM | `openai/gpt-oss-120b` on Groq (medium reasoning for answers) | `server/src/services/llm.ts` |
| Search | bge-small embeddings + Postgres full-text, fused, English captions only | `server/src/services/rag.ts` |
| Schema | applied automatically on server start | `server/src/db/migrations.ts` |

## Lessons

- Test whether the host is reachable (DNS, TCP, TLS) before changing database drivers. Most of the time here went on driver swaps that could not fix a network problem.
- Read the full error `cause`, not the top-level message. `fetch failed` and `ErrorEvent` hid the real errors (`ETIMEDOUT`, `ENETUNREACH`).
- If `curl` works but Node does not, suspect Node's connection defaults, such as the 250 ms per-address attempt timeout.
- On a slow link, expect each database call to take a second or two. Adding a video makes one insert per transcript chunk, so batching those inserts would help if ingestion feels slow.
- Verify answers against the source, not by eye: the worst errors here (wrong-language transcript, invented tools) looked fine when read casually.
- A hidden fallback (the model translating Arabic on the fly) can mask a broken pipeline. Log what is retrieved (`DEBUG_RAG=1`).
