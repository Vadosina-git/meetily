# Speaker Tagging («Я / Не Я») Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag each transcript line by physical audio source (microphone = «Я», system = «Не Я»), persist it, display it with an optional global toggle, and re-apply tags on retranscribe by time-matching.

**Architecture:** Split the single mixed-audio VAD pass in the pipeline into two independent passes (mic-only, system-only), each tagged with its `DeviceType`. The recording WAV stays mixed and untouched. The `source` string flows through the existing (currently hardcoded) `TranscriptUpdate.source` field → frontend state → the already-existing-but-dead `transcripts.speaker` DB column. Retranscribe loads the old speaker map (time+source) before overwriting and assigns speakers to new segments by time overlap.

**Tech Stack:** Rust (Tauri backend, `ContinuousVadProcessor`), Next.js/React/TypeScript frontend, sqlx + SQLite.

## Global Constraints

- Source values stored/emitted as exactly `"mic"` and `"system"` (lowercase). Display labels «Я» (mic) / «Не Я» (system) are frontend-only.
- Toggle: global, browser `localStorage` key `showSpeakerTags`, default **ON** (`"true"` when unset). Mirror the existing `showConfidenceIndicator` toggle exactly.
- **No new dependencies.** No frontend test framework is added (none exists). Frontend + DB-layer changes are verified by manual build-and-run, not automated tests.
- Recording WAV output stays mixed and unchanged. Only the transcription branch is split.
- **Reuse the existing `transcripts.speaker` column** (migration `20251110000001_add_speaker_field.sql`). Do NOT add a new migration.
- Whisper/VAD run on 16 kHz mono. Transcription VAD is `ContinuousVadProcessor`, which is stateful (`&mut self`) — each source needs its OWN instance.

---

### Task 1: Two-pass VAD in the pipeline (mic + system tagged separately)

**Files:**
- Modify: `frontend/src-tauri/src/audio/pipeline.rs:684` (struct field), `:729-751` (construction), `:823-866` (mix/transcription loop), `:904` (flush)

**Interfaces:**
- Consumes: `self.ring_buffer.extract_window() -> Option<(Vec<f32> /*mic*/, Vec<f32> /*system*/)>`; `ContinuousVadProcessor::new(sample_rate: u32, redemption_time_ms: u64) -> Result<Self>`; `ContinuousVadProcessor::process_audio(&mut self, &[f32]) -> Result<Vec<SpeechSegment>>`; `DeviceType::{Microphone, System}` (`audio/recording_state.rs:12`).
- Produces: transcription `AudioChunk`s whose `device_type` is `Microphone` for mic speech and `System` for system speech (instead of always `Microphone`). Same `transcription_sender` as today.

- [ ] **Step 1: Replace the single VAD field with two**

In `pipeline.rs` struct `AudioPipeline` (field at line 684), replace:
```rust
    vad_processor: ContinuousVadProcessor,
```
with:
```rust
    vad_processor_mic: ContinuousVadProcessor,
    vad_processor_system: ContinuousVadProcessor,
```

- [ ] **Step 2: Construct both VAD processors**

At the construction site (around line 729), replace the single `let vad_processor = match ContinuousVadProcessor::new(sample_rate, redemption_time) { ... }` and its use in the struct literal (line 751) with two processors built identically:
```rust
        let vad_processor_mic = match ContinuousVadProcessor::new(sample_rate, redemption_time) {
            Ok(v) => v,
            Err(e) => { error!("Failed to init mic VAD: {}", e); return; }
        };
        let vad_processor_system = match ContinuousVadProcessor::new(sample_rate, redemption_time) {
            Ok(v) => v,
            Err(e) => { error!("Failed to init system VAD: {}", e); return; }
        };
```
(Preserve the exact error-handling style already used at that site; if it returns a `Result`/`Option`, match it.) In the struct literal replace `vad_processor,` with `vad_processor_mic,\n            vad_processor_system,`.

- [ ] **Step 3: Split the transcription pass into mic + system**

In the mix loop (lines 823–866), keep the mixed recording branch (STEP 4) exactly as-is, but replace STEP 3 (the single `self.vad_processor.process_audio(&mixed_with_gain)` block) with two explicit blocks. Each block is the SAME segment-emitting logic as today, differing only in the window fed to VAD and the `device_type` on the emitted chunk:

```rust
                            // STEP 3a: microphone-only transcription → source "mic" (Я)
                            match self.vad_processor_mic.process_audio(&mic_window) {
                                Ok(speech_segments) => {
                                    for segment in speech_segments {
                                        let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;
                                        if segment.samples.len() >= 800 {
                                            let transcription_chunk = AudioChunk {
                                                data: segment.samples,
                                                sample_rate: 16000,
                                                timestamp: segment.start_timestamp_ms / 1000.0,
                                                chunk_id: self.chunk_id_counter,
                                                device_type: DeviceType::Microphone,
                                            };
                                            if let Err(e) = self.transcription_sender.send(transcription_chunk) {
                                                warn!("Failed to send mic VAD segment: {}", e);
                                            } else {
                                                self.chunk_id_counter += 1;
                                            }
                                        }
                                    }
                                }
                                Err(e) => warn!("⚠️ mic VAD error: {}", e),
                            }

                            // STEP 3b: system-only transcription → source "system" (Не Я)
                            match self.vad_processor_system.process_audio(&sys_window) {
                                Ok(speech_segments) => {
                                    for segment in speech_segments {
                                        let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;
                                        if segment.samples.len() >= 800 {
                                            let transcription_chunk = AudioChunk {
                                                data: segment.samples,
                                                sample_rate: 16000,
                                                timestamp: segment.start_timestamp_ms / 1000.0,
                                                chunk_id: self.chunk_id_counter,
                                                device_type: DeviceType::System,
                                            };
                                            if let Err(e) = self.transcription_sender.send(transcription_chunk) {
                                                warn!("Failed to send system VAD segment: {}", e);
                                            } else {
                                                self.chunk_id_counter += 1;
                                            }
                                        }
                                    }
                                }
                                Err(e) => warn!("⚠️ system VAD error: {}", e),
                            }
```
Keep `let mixed_clean = self.mixer.mix_window(&mic_window, &sys_window);` and the STEP 4 recording branch below unchanged (recording still uses mixed audio).

- [ ] **Step 4: Flush both VAD processors**

At the flush site (line 904), replace `self.vad_processor.flush()` with two flush calls that emit tagged chunks. For each of `(&mut self.vad_processor_mic, DeviceType::Microphone)` and `(&mut self.vad_processor_system, DeviceType::System)`, run the same flush→send logic that exists today, using the matching `device_type`. (Mirror whatever the current flush block does; duplicate it once per processor with the correct `device_type`.)

- [ ] **Step 5: Build**

Run: `cd frontend/src-tauri && cargo check --no-default-features --features platform-default`
Expected: compiles, no errors. Warnings about the removed `vad_processor` field must be gone.

- [ ] **Step 6: Manual verification (build feasibility only; behavior verified end-to-end in Task 3/5)**

No automated test — real-time audio can't be unit-tested here. Confirm `cargo check` passes. Behavioral verification happens after the source string is wired (Task 2) and rendered (Task 7).

- [ ] **Step 7: Commit**

```bash
git add frontend/src-tauri/src/audio/pipeline.rs
git commit -m "feat(audio): split transcription VAD into mic/system passes"
```

---

### Task 2: Map device_type → source string in the worker

**Files:**
- Modify: `frontend/src-tauri/src/audio/transcription/worker.rs:208-228` (the `TranscriptUpdate` build, `source` at line 211)

**Interfaces:**
- Consumes: the `AudioChunk.device_type` (`DeviceType::{Microphone, System}`) that Task 1 now sets correctly. Verify the chunk being transcribed in this scope exposes `device_type`; if the worker consumed the field earlier, thread it into this scope as a local `source_device: DeviceType`.
- Produces: `TranscriptUpdate.source` == `"mic"` or `"system"`.

- [ ] **Step 1: Replace the hardcoded source**

At `worker.rs:211`, replace:
```rust
                                            source: "Audio".to_string(),
```
with a value derived from the chunk's device type. If the device type is available as `chunk.device_type` in scope:
```rust
                                            source: match chunk.device_type {
                                                crate::audio::recording_state::DeviceType::Microphone => "mic".to_string(),
                                                crate::audio::recording_state::DeviceType::System => "system".to_string(),
                                            },
```
If `device_type` is not in scope at line 211, add a local at the top of the per-chunk processing block: `let source_device = chunk.device_type.clone();` and use `source_device` in the match. Use the DeviceType path that the file already imports (check the `use` block; prefer the existing short name if imported).

- [ ] **Step 2: Build**

Run: `cd frontend/src-tauri && cargo check --no-default-features --features platform-default`
Expected: compiles clean.

- [ ] **Step 3: Manual smoke check**

Run the app in dev, start a short recording, speak into the mic and play audio through the system output. In the terminal logs (or DevTools console listening to `transcript-update`), confirm segments now carry `source: "mic"` and `source: "system"` rather than `"Audio"`.
Run: `cd frontend && ./clean_run.sh debug`

- [ ] **Step 4: Commit**

```bash
git add frontend/src-tauri/src/audio/transcription/worker.rs
git commit -m "feat(audio): emit real mic/system source in TranscriptUpdate"
```

---

### Task 3: Carry source into the in-memory segments (live path)

**Files:**
- Modify: `frontend/src-tauri/src/audio/recording_saver.rs:16-25` (`TranscriptSegment` struct), `frontend/src-tauri/src/audio/recording_commands.rs:265-287` and `:436` (listeners that build the segment and drop `source`)

**Interfaces:**
- Consumes: `TranscriptUpdate.source: String` (from Task 2).
- Produces: `recording_saver::TranscriptSegment.speaker: Option<String>` populated with the source, so the in-memory/JSON export retains the tag.

- [ ] **Step 1: Add a speaker field to the live segment struct**

In `recording_saver.rs` `TranscriptSegment` (lines 16-25), add after `sequence_id`:
```rust
    #[serde(default)]
    pub speaker: Option<String>,
```
(`#[serde(default)]` keeps older `transcripts.json` files loadable.)

- [ ] **Step 2: Populate speaker when building the segment**

In `recording_commands.rs` at the listener block (lines 269-278) where a `recording_saver::TranscriptSegment` is constructed from the deserialized `TranscriptUpdate`, add `speaker: Some(update.source.clone()),` to the struct literal. Do the same at the second listener (~line 436) if it constructs a segment.

- [ ] **Step 3: Build**

Run: `cd frontend/src-tauri && cargo check --no-default-features --features platform-default`
Expected: compiles; any other constructors of `TranscriptSegment` in the crate must also set `speaker` (add `speaker: None` where a value is unknown — the compiler will point them out).

- [ ] **Step 4: Commit**

```bash
git add frontend/src-tauri/src/audio/recording_saver.rs frontend/src-tauri/src/audio/recording_commands.rs
git commit -m "feat(audio): retain source on in-memory transcript segments"
```

---

### Task 4: Persist speaker to the DB (wire the existing dead column)

**Files:**
- Modify: `frontend/src-tauri/src/database/models.rs:25-38` (`Transcript` struct), `frontend/src-tauri/src/api/api.rs:180-191` (save DTO `TranscriptSegment`), `frontend/src-tauri/src/database/repositories/transcript.rs:13-51` (`save_transcript` INSERT)

**Interfaces:**
- Consumes: the existing `transcripts.speaker TEXT` column.
- Produces: `Transcript.speaker: Option<String>` (read on SELECT *), and `save_transcript` binds speaker on INSERT. `api::TranscriptSegment` gains `speaker: Option<String>` so the frontend can send it back.

- [ ] **Step 1: Add speaker to the DB model struct**

In `models.rs` `Transcript` (lines 25-38), add after `duration`:
```rust
    pub speaker: Option<String>,
```
Because `get_meeting_transcripts_paginated` uses `SELECT *` into this `FromRow` struct, the column auto-populates on read.

- [ ] **Step 2: Add speaker to the save DTO**

In `api.rs` `TranscriptSegment` (lines 180-191), add:
```rust
    #[serde(default)]
    pub speaker: Option<String>,
```

- [ ] **Step 3: Bind speaker in the INSERT**

In `transcript.rs` `save_transcript` (INSERT at lines 49-51), add the `speaker` column to the SQL column list and its `?` placeholder, and bind `&segment.speaker` in the correct position. Example shape (match the existing query builder style — `sqlx::query` with `.bind(...)`):
```rust
    // columns:  ... audio_start_time, audio_end_time, duration, speaker
    // values:   ... ?,               ?,             ?,        ?
    // and add:  .bind(&segment.speaker)
```

- [ ] **Step 4: Build**

Run: `cd frontend/src-tauri && cargo check --no-default-features --features platform-default`
Expected: compiles. If `save_transcript` maps `recording_saver`/other segment types into the DTO, set `.speaker` there too.

- [ ] **Step 5: Manual verification**

Record a short meeting, stop (triggers save). Then inspect the DB:
Run: `sqlite3 "$HOME/Library/Application Support/com.meetily.ai/"*.db "SELECT substr(transcript,1,20), speaker FROM transcripts ORDER BY audio_start_time LIMIT 10;"`
Expected: `speaker` shows `mic`/`system`, not NULL.

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/src/database/models.rs frontend/src-tauri/src/api/api.rs frontend/src-tauri/src/database/repositories/transcript.rs
git commit -m "feat(db): persist speaker (mic/system) on transcripts"
```

---

### Task 5: Frontend — keep source in state and send it back on save

**Files:**
- Modify: `frontend/src/types/index.ts:7-19` (`Transcript` type), the TranscriptUpdate→Transcript conversion (in `src/services/transcriptService.ts` and/or `src/app/page.tsx` where `onTranscriptUpdate` builds a `Transcript`), and the save call that maps segments into the `api_save_transcript` payload.

**Interfaces:**
- Consumes: `TranscriptUpdate.source` (already in `src/types/index.ts:24`).
- Produces: `Transcript.speaker?: string` present in React state and included in the `api_save_transcript` segment payload as `speaker`.

- [ ] **Step 1: Add speaker to the frontend Transcript type**

In `src/types/index.ts` `Transcript` (lines 7-19), add:
```typescript
  speaker?: string;
```

- [ ] **Step 2: Keep source when converting the event to a Transcript**

Find every place a `TranscriptUpdate` is turned into a `Transcript` (grep `onTranscriptUpdate` and `audio_start_time` in `src/`). In each mapping, add `speaker: update.source,`.

- [ ] **Step 3: Include speaker in the save payload**

Find the `invoke('api_save_transcript', ...)` call (grep `api_save_transcript` in `src/`). Ensure each segment object in the payload includes `speaker: t.speaker ?? null`.

- [ ] **Step 4: Build**

Run: `cd frontend && pnpm run build`
Expected: type-checks and builds with no TS errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/services/transcriptService.ts frontend/src/app/page.tsx
git commit -m "feat(ui): carry speaker source through transcript state and save"
```

---

### Task 6: Frontend — global «show speaker tags» toggle

**Files:**
- Modify: `frontend/src/contexts/ConfigContext.tsx:149-157` (state init), `:376-384` (toggle writer), `:498` & `:520` (context exposure), `frontend/src/app/_components/SettingsModal.tsx:55` & `:275-291` (checkbox UI)

**Interfaces:**
- Produces: `showSpeakerTags: boolean` and `toggleSpeakerTags(checked: boolean)` on ConfigContext, backed by `localStorage['showSpeakerTags']` (default `true`), dispatching `CustomEvent('speakerTagsChanged')`. Exact mirror of `showConfidenceIndicator` / `toggleConfidenceIndicator`.

- [ ] **Step 1: Add state init (default ON)**

In `ConfigContext.tsx` near lines 149-157, mirroring `showConfidenceIndicator`:
```typescript
  const [showSpeakerTags, setShowSpeakerTags] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('showSpeakerTags');
    return stored === null ? true : stored === 'true';
  });
```

- [ ] **Step 2: Add the toggle writer**

Mirror `toggleConfidenceIndicator` (lines 376-384):
```typescript
  const toggleSpeakerTags = (checked: boolean) => {
    setShowSpeakerTags(checked);
    localStorage.setItem('showSpeakerTags', checked.toString());
    window.dispatchEvent(new CustomEvent('speakerTagsChanged', { detail: checked }));
  };
```

- [ ] **Step 3: Expose on context**

Add `showSpeakerTags` and `toggleSpeakerTags` to the context value object (around lines 498 & 520) and to the context TypeScript interface, exactly where `showConfidenceIndicator`/`toggleConfidenceIndicator` are listed.

- [ ] **Step 4: Add the checkbox to SettingsModal**

In `SettingsModal.tsx`, read the value near line 55 (`const { showSpeakerTags, toggleSpeakerTags } = useConfig();` alongside the confidence one) and add a checkbox block copied from the confidence toggle (lines 275-291), labeled «Показывать метки говорящего (Я / Не Я)», wired to `toggleSpeakerTags`.

- [ ] **Step 5: Build**

Run: `cd frontend && pnpm run build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/contexts/ConfigContext.tsx frontend/src/app/_components/SettingsModal.tsx
git commit -m "feat(ui): add global show-speaker-tags toggle (default on)"
```

---

### Task 7: Frontend — render the «Я / Не Я» badge

**Files:**
- Modify: `frontend/src/components/TranscriptView.tsx:263-331` (row at line 284), `frontend/src/components/VirtualizedTranscriptView.tsx` (row render ~line 90, prop threading like `showConfidence` at 27/73/94/298/354)

**Interfaces:**
- Consumes: `Transcript.speaker?: string` (Task 5) and `showSpeakerTags` (Task 6). Reads the toggle the same way each renderer reads `showConfidence` (TranscriptView reads localStorage directly at 130-132; Virtualized takes a prop).

- [ ] **Step 1: Add a small badge component (inline)**

At the top of `TranscriptView.tsx`, add a helper:
```tsx
function SpeakerBadge({ speaker }: { speaker?: string }) {
  if (speaker !== 'mic' && speaker !== 'system') return null;
  const isMe = speaker === 'mic';
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isMe ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
      {isMe ? 'Я' : 'Не Я'}
    </span>
  );
}
```

- [ ] **Step 2: Read the toggle in TranscriptView**

Near lines 130-132 (where `showConfidence` is read from localStorage), add an analogous `showSpeakerTags` read plus a `speakerTagsChanged` event listener that updates it (mirror the confidence pattern in this file).

- [ ] **Step 3: Render the badge in the row**

In the row JSX at line 284 (inside `<div className="flex items-start gap-2">`, next to the timestamp span at 287-291), add:
```tsx
{showSpeakerTags && <SpeakerBadge speaker={transcript.speaker} />}
```

- [ ] **Step 4: Repeat for the virtualized renderer**

In `VirtualizedTranscriptView.tsx`, thread a `showSpeakerTags` prop the same way `showConfidence` is threaded (27/73/94/298/354), import/duplicate `SpeakerBadge`, and render it in the row near the timestamp (line 90). At the live-recording call site `TranscriptPanel.tsx:115` (which hardcodes `showConfidence={true}`), pass `showSpeakerTags` from `useConfig()`.

- [ ] **Step 5: Build**

Run: `cd frontend && pnpm run build`
Expected: builds clean.

- [ ] **Step 6: Manual end-to-end verification**

Run: `cd frontend && ./clean_run.sh`. Record a short meeting speaking into mic while system audio plays. Confirm: «Я» appears on mic lines, «Не Я» on system lines. Toggle off in Settings → badges disappear (all meetings). Reopen a saved meeting → badges persist.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/TranscriptView.tsx frontend/src/components/VirtualizedTranscriptView.tsx frontend/src/app/_components/TranscriptPanel.tsx
git commit -m "feat(ui): render Я/Не Я speaker badge gated by toggle"
```

---

### Task 8: Retranscribe — re-apply tags by time overlap

**Files:**
- Create: nothing new (add helper + tests inside) `frontend/src-tauri/src/audio/retranscription.rs`
- Modify: `frontend/src-tauri/src/audio/retranscription.rs:422-460` (load old map before DELETE, assign speakers, bind on INSERT)
- Test: `frontend/src-tauri/src/audio/retranscription.rs` (existing `#[cfg(test)]` module, ~line 839)

**Interfaces:**
- Consumes: old rows `(audio_start_time, audio_end_time, speaker)` read before the `DELETE`; new segments from `create_transcript_segments`.
- Produces: `fn assign_speaker_by_overlap(seg_start: f64, seg_end: f64, map: &[(f64, f64, String)]) -> Option<String>` — returns the speaker whose time range overlaps the segment most; `None` if no overlap. New INSERTs bind this speaker.

- [ ] **Step 1: Write the failing test**

Add to the test module (~line 839):
```rust
    #[test]
    fn test_assign_speaker_by_overlap_picks_max_overlap() {
        let map = vec![
            (0.0, 3.0, "mic".to_string()),
            (3.0, 6.0, "system".to_string()),
        ];
        // segment 0.5–2.5 fully inside mic
        assert_eq!(assign_speaker_by_overlap(0.5, 2.5, &map), Some("mic".to_string()));
        // segment 2.5–5.0 straddles both, but more of it (2.0s) is in system vs mic (0.5s)
        assert_eq!(assign_speaker_by_overlap(2.5, 5.0, &map), Some("system".to_string()));
        // segment 10.0–11.0 overlaps nothing
        assert_eq!(assign_speaker_by_overlap(10.0, 11.0, &map), None);
    }
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd frontend/src-tauri && cargo test assign_speaker_by_overlap`
Expected: FAIL — `assign_speaker_by_overlap` not found.

- [ ] **Step 3: Implement the helper**

Add near the top-level functions in `retranscription.rs`:
```rust
/// Given a new segment time range and a speaker map of (start, end, speaker)
/// from the original live recording, return the speaker with the largest
/// time overlap. None if no range overlaps.
pub fn assign_speaker_by_overlap(
    seg_start: f64,
    seg_end: f64,
    map: &[(f64, f64, String)],
) -> Option<String> {
    let mut best: Option<(f64, &String)> = None;
    for (start, end, speaker) in map {
        let overlap = seg_end.min(*end) - seg_start.max(*start);
        if overlap > 0.0 {
            match best {
                Some((b, _)) if overlap <= b => {}
                _ => best = Some((overlap, speaker)),
            }
        }
    }
    best.map(|(_, s)| s.clone())
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd frontend/src-tauri && cargo test assign_speaker_by_overlap`
Expected: PASS.

- [ ] **Step 5: Load the old speaker map before DELETE**

In `run_retranscription`, BEFORE the `DELETE FROM transcripts WHERE meeting_id = ?` (line 436), query the old map:
```rust
    let old_map: Vec<(f64, f64, String)> = sqlx::query_as::<_, (Option<f64>, Option<f64>, Option<String>)>(
        "SELECT audio_start_time, audio_end_time, speaker FROM transcripts WHERE meeting_id = ?"
    )
    .bind(&meeting_id)
    .fetch_all(&pool).await.unwrap_or_default()
    .into_iter()
    .filter_map(|(s, e, sp)| match (s, e, sp) { (Some(s), Some(e), Some(sp)) => Some((s, e, sp)), _ => None })
    .collect();
```

- [ ] **Step 6: Assign speaker and bind on INSERT**

At the per-segment INSERT (lines 443-456), compute `let speaker = assign_speaker_by_overlap(seg.audio_start_time, seg.audio_end_time, &old_map);` (use the segment's actual start/end field names from `create_transcript_segments`), add `speaker` to the INSERT columns/placeholders, and `.bind(&speaker)`.

- [ ] **Step 7: Build + test**

Run: `cd frontend/src-tauri && cargo test && cargo check --no-default-features --features platform-default`
Expected: all tests pass, compiles clean.

- [ ] **Step 8: Manual verification**

Open a meeting recorded WITH the feature (has speaker map), run Retranscribe. Confirm the new transcript still shows «Я / Не Я» on the right lines. Open a meeting recorded BEFORE the feature (no map) → retranscribe leaves badges absent (no crash).

- [ ] **Step 9: Commit**

```bash
git add frontend/src-tauri/src/audio/retranscription.rs
git commit -m "feat(audio): reapply speaker tags on retranscribe via time overlap"
```

---

## Self-Review

**Spec coverage:**
- Pipeline two-pass (spec §1) → Task 1. ✅
- Source tagging (spec §1, hardcoded `"Audio"`) → Task 2. ✅
- Persist source / speaker map (spec §2) → Tasks 3, 4. ✅
- Retranscribe time-matching (spec §3) → Task 8. ✅
- Badge in dialog (spec §4) → Task 7. ✅
- Global toggle, default on (spec §4) → Task 6. ✅
- Recording WAV unchanged (spec constraint) → Task 1 keeps STEP 4 intact. ✅
- Reuse existing `speaker` column (no new migration) → Task 4. ✅
- Known limitations (echo/overlap/old meetings) are behavioral, documented in spec; overlap handled by `assign_speaker_by_overlap` picking max overlap. ✅

**Placeholder scan:** No TBD/TODO. Where a step says "mirror the existing block" (Task 1 Step 4 flush, Task 6 checkbox), the reference block is cited by file:line and is a verbatim duplicate-with-one-change — acceptable because the exact source lines are named.

**Type consistency:** `speaker` used consistently as `Option<String>` (Rust) / `speaker?: string` (TS); source values `"mic"`/`"system"` consistent across worker (Task 2), DB (Task 4), badge (Task 7). `assign_speaker_by_overlap` signature identical in test (Step 1) and impl (Step 3).

**Testing reality (honest):** Only Task 8's pure helper is unit-tested (cargo). Tasks 1–7 have no automated tests — the audio pipeline is real-time (untestable in unit form), the DB layer has zero existing test scaffolding, and the frontend has no test runner. These are verified by build + manual run, called out explicitly in each task. Adding a frontend test framework is out of scope (new dependency, needs approval).
