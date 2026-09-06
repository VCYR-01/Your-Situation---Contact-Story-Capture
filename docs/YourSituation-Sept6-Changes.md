# YourSituation — September 6, 2026 Changes

Addendum to `YourSituation-Module-Doc-v3.md`. Covers the front-gate redesign, the WPCode redirect fix, and the new unified Zap that replaced the two legacy Zaps. Read this alongside the v3 doc, not instead of it — this doesn't restate the whole system, only what changed today.

---

## 1. Problem this addressed

Forminator collected name, phone, and email **before** a visitor could start the actual conversation with YourSituation — a cold-contact gate in front of a deliberately non-form-like, conversational flow. Diagnosed as the likely cause of tell-us's low completion rate (212 impressions, 1–2 completions over ~2 months).

Separately, discovered the FUB contact was being created **twice**, via two independent Zaps with a silent execution-order dependency:
- **"Capture Contact From Web Service Pages"** (hook `ulr06c5`) — fired on raw Forminator submission, before any story was captured.
- **"Contact Page Voice Capture"** (hook `u7vprb7`) — fired at end-of-flow, but had **no Create/Update Contact step of its own** — it depended on the Forminator Zap having already created the contact by email moments earlier.

Removing the Forminator gate would have broken this dependency. Fix required in this order: build new Zap first → verify it → then change Forminator.

---

## 2. Forminator changes (form 10959, "General Inquiry")

- **Phone and Email fields: hidden entirely** (not just made optional). Visitor now sees only First Name, Last Name, and the "Share Your Situation →" button.
- **Name field was already split** into `name-1-first-name` / `name-1-last-name` as two separate Forminator inputs — this was always true, not new today.
- Hidden fields (`scenario`, `referrer`, `source_url`) untouched.
- Added custom CSS (via Forminator's Appearance tab) to style the two name fields side-by-side with rounded corners matching the CTA button, stacking to full-width on screens under 480px. Targets Forminator's real classes (`.forminator-row.forminator-no-margin`, `.forminator-col.forminator-col-md-6`, `.forminator-input`, `.forminator-button-submit`) — don't reuse generic Forminator class-name guesses without inspecting actual DOM first; earlier attempts at this CSS failed because assumed class names didn't match Forminator's real output.
- **The old Forminator webhook (`ulr06c5`) was left in place but its Zap was turned off** — deliberately not deleted, since a dead Zap silently discarding webhook calls (accepted, 200, no task) is zero-risk and reversible; removing the webhook itself was judged unnecessary extra surface area.

---

## 3. WPCode snippet fix (`cyr_forminator_redirect`)

**Bug found:** the snippet building the redirect URL to `your-situation.netlify.app` only ever read `name-1-first-name` — it never captured `name-1-last-name` at all. This wasn't a regression from today's other changes; it's how the snippet was originally written. Whatever gave FUB two-field names in the past came entirely from the **old Forminator Zap** reading raw form fields directly (bypassing this snippet/URL path) — never from this redirect mechanism.

**Fix applied:**
- Added `var lastName = jQuery(selector + ' input[name="name-1-last-name"]').val() || '';` alongside the existing first-name capture.
- Stored in `sessionStorage` as `cyr_lastname`, alongside the existing keys.
- Added `&lastname=` to the constructed redirect URL.
- Cleaned up (`sessionStorage.removeItem('cyr_lastname')`) alongside the other keys on success.

Full corrected snippet is in the conversation this doc came from; the diff is four small additions to the existing function, no structural changes.

**Note on the redirect URL's PII exposure:** phone and email were removed from this URL entirely today (see §4) — they moved to a new end-of-flow screen instead. Only `name`, `lastname`, `scenario`, and `referrer` now travel via URL parameter. This is a meaningfully smaller exposure than before (no contact-reachable info in the URL/browser history), though not zero — worth eventually moving name to sessionStorage-only too, same pattern as phone/email, if this needs to be fully closed.

---

## 4. `index.html` changes

- **New contact-capture screen** (`card-contact`), inserted into the existing stage system (`ALL_CARDS`, `showStage()`'s `idMap`) between the probe/playback stage and final submission. Appears after "I'm good, send it" (Path A) or the probe answer (Path B) — **before** the final Claude call fires, not after.
  - Two inputs: phone, email.
  - One opt-out control: "I'd rather not share contact info right now."
  - New mutable `STATE` fields: `contactPhone`, `contactEmail`, `contactOptedOut` — replacing reliance on `confirmedPhone`/`confirmedEmail` (which are `const`, read once from URL params at page load and can no longer be assumed populated, since Forminator no longer sends them).
- **New `confirmedLastName`** constant, reading the new `?lastname=` URL parameter (mirrors `confirmedName`'s pattern exactly).
- **Payload updates** (both the main payload and the fallback payload): `name`, `lastname` sent as two separate fields (not concatenated); `phone`/`email` prefer the new `STATE.contactPhone`/`contactEmail` over the (now likely absent) URL-sourced constants; new `contact_provided: 'Yes'|'No'` field added for Zap-side branching.
- **Confirmation screen now branches on opt-out state** — if `STATE.contactOptedOut`, the "Vincent or Jane will be in touch... watch for a call from a (610) number" copy is replaced with honest messaging ("We have what you shared — no contact info needed on your end... if you change your mind, call us directly"). This was a real bug caught in live testing: the original copy promised a call to visitors who had explicitly declined to be reached.

---

## 5. New unified Zap ("YourSituation — Unified Contact + Note")

Replaces both legacy Zaps entirely. Single trigger, single execution, no cross-Zap dependency.

### Architecture
```
Catch Hook (new hook: 4heg0ok)
  → Paths: branch on "Contact Provided"
      Path A ("Yes"):
        Create/Update Contact (FUB, keyed on email)
        → Create Note (FUB)
        → Create/Update Record — Lead Capture (Airtable, keyed on email)
        → Code by Zapier (rounds_json reshape)
        → Create/Update Record — YourSituation_Rounds (keyed on Round Label)
        → SMS by Zapier
        → Lookup Table (scenario_detected → email HTML template, includes
           live field pills for name/opening-line substitution)
        → Send Message (Anthropic — generates one-sentence opening line)
        → Outbound Email
      Path B ("No" — opted out):
        Create/Update Contact (FUB, blank email — confirmed FUB accepts this)
        → Create/Update Record — Lead Capture (Airtable, SYNTHETIC email
           used here only, since Lead Capture's Email field is a required
           cross-module join key to Buyer/Listing Intake — FUB itself still
           gets a genuinely blank email, not the synthetic one)
        → Code by Zapier (rounds_json reshape)
        → Create/Update Record — YourSituation_Rounds
        (no SMS, no Outbound Email — nothing to send them to)
```

### Critical gotcha: `zapier.js` payload keys vs. Zap field names
The real payload from `index.html`/`zapier.js` uses **snake_case** (`team_briefing_full`, `scenario_detected`, `submitted_at`, etc.). The Zap's steps were all built and tested this morning against **camelCase** field names (`teamBriefingFull`, guessed before the real `index.html` payload had been read). `zapier.js` now includes a **translation layer** (`translatePayload()`) that renames incoming snake_case keys to the camelCase names the Zap expects, before forwarding to Catch Hook.

**Known incomplete:** the translation layer's `KEY_MAP` was built from memory/reconstruction, not by systematically cross-checking every field Zap step needs. At least one field (`timeline`) was missed and had to be added after a live production submission showed it blank in Airtable. **Worth a full audit**: open every step in the Zap (Create Note, both Lead Capture and Rounds Airtable writes, Send Message's prompt) and list every field it references, then diff against `KEY_MAP` in `zapier.js` — don't assume the map is complete just because recent tests passed.

### The "empty payload" mystery (unresolved root cause)
Several hours were spent debugging Catch Hook showing "all fields empty" for real submissions, despite Netlify's own function logs proving a complete, correct JSON body was sent. Confirmed NOT caused by: Zap toggle state, wrong URL, payload size, special characters, PowerShell vs. `fetch()` as client. The eventual fix (adding the camelCase translation layer) resolved it, but **the actual mechanism by which Zapier silently discarded snake_case-keyed JSON, while returning HTTP 200, was never conclusively identified**. If this resurfaces, don't assume the translation layer is the permanent fix — it's an empirically-derived workaround, not a diagnosed root cause.

### Airtable Lead Capture — Email is a required cross-module join key
Confirmed directly: Lead Capture's Email field isn't an arbitrary required setting — it's documented as the primary join key linking to Buyer Intake / Listing Intake once a lead qualifies. **Do not make it optional** to solve future opt-out-type problems; use a synthetic placeholder value instead (as done in Path B), scoped to Airtable only, never forwarded to FUB.

---

## 6. Still open (not done today)

- **Luxury, First Time Buyer, Moving Up** scenario emails — no dedicated content written. These currently fall through to the General Inquiry template ("Interview Your Agent") via the Lookup Table's default/fallback behavior.
- **Visual redesign of the contact-capture screen** — currently plain unstyled inputs. Discussed replacing the mic icon elsewhere in the flow with an orb/waveform visual; not started.
- **Retiring the old Zaps** — both are toggled off, not deleted. Fine to leave as-is; deleting is optional cleanup, not urgent.
- **Full `KEY_MAP` audit** (see §5) — do this before the next time a new field is added anywhere in the Zap.
---

## 7. Voice/visual redesign (later same day)

Separate work, done after §1–7 above and after the front-gate/Zap rebuild was confirmed live. Two parts: a visual redesign of the recording control, and adding spoken audio to the conversation.

### 7.1 Visual: mic icon → glowing orb

Original design was a plain white circle with a static mic SVG icon, bordered in the brand accent color. Replaced in two iterations:

1. **First pass** — kept the circular button, replaced the static SVG with 5 animated waveform bars (still, then pulsing while recording). Abandoned in favor of iteration 2 once Vince clarified the actual direction he wanted.
2. **Final version** — a pure CSS "ambient orb": no icon at all, a soft radial-gradient glow using the existing `--accent` brand color (not the blue in Vince's reference image — kept on-brand deliberately), gently "breathing" (subtle scale/glow pulse) at idle, brighter and faster-pulsing while recording. Matches the intended feel of "the AI has a presence," not "here's a recording button."
   - All visitor-facing copy referencing "the mic" was updated to "the orb" in the same pass (`Tap the mic and tell us...` → `Tap the orb and tell us...`, plus both hint-text strings). This was originally missed in the first deploy and caught live — always update copy in the same pass as a control's visual identity changes, not as an afterthought.

### 7.2 Voice: reading the conversation aloud

Two implementations, in order:

**v1 — Browser-native `speechSynthesis`.** Free, no server call, but voice quality/availability is fully device-dependent (decent on iOS/Mac via Apple's built-in voices, more robotic elsewhere) and there's no way to guarantee a consistent brand voice across visitors. Worked, sounded "a little robotic" per live test — judged good enough to ship at the time, but superseded same day once Vince decided to try ElevenLabs instead, since the practice already uses ElevenLabs elsewhere.

**v2 — ElevenLabs (final).** Voice: `hpp4J3VqNfWAUOO0d1Us` (a Matilda-family voice — Vince supplied this ID directly from his own account after an initial third-party-sourced ID was tried first).

Architecture:
- New Netlify function `functions/elevenlabs-tts.js` — takes `{ text }`, calls ElevenLabs server-side (API key never touches the client), returns base64 MP3. Caps input at 2000 characters defensively. Uses `eleven_turbo_v2_5` for speed/cost; `eleven_multilingual_v2` noted in-code as the swap if quality ever needs to outweigh latency.
- New `netlify.toml` redirect: `/api/tts` → `/.netlify/functions/elevenlabs-tts`.
- New required env var: `ELEVENLABS_API_KEY` (Netlify site settings). **Env vars only take effect on the next deploy** — this cost real debugging time when the key was added but the site wasn't redeployed afterward.
- `index.html`: what's spoken —
  1. Playback stage: the paragraph, then the permission-ask follow-up question.
  2. Confirmation screen: name greeting → echoed excerpt → followup line (the followup line's text is read directly from the DOM element that was already set, rather than recomputed, so opt-out vs. normal visitors each hear the message that actually matches what's on their screen).

### 7.3 Bugs found and fixed, in the order they surfaced

This was the hardest part of the day's build — a chain of real, distinct iOS Safari issues, each one looking at first like it might be the same problem as the last but each requiring its own fix. Worth reading in order if this resurfaces, since a fix that looks similar to an earlier one may not be the same root cause.

1. **Playback worked on desktop, completely silent on iPhone.** Root cause: iOS Safari requires audio playback to be triggered by a direct user gesture at least once per session — the code was calling playback asynchronously, several steps removed from any tap (after a Claude API round-trip). Fix (first attempt): an "unlock" — play a near-silent clip directly inside a real click handler once, hoping it would permit later un-gestured playback for the rest of the session.

2. **Unlock "succeeded" (per its own success callback) but real playback still failed.** Root cause, once diagnosed via an on-screen debug banner (iPhone has no easy console access without a Mac + Web Inspector): the first unlock attempt used a **zero-sample** WAV — invalid enough that iOS may not have credited it as genuine playback at all. Fixed with a real, valid 100ms silent WAV instead of an empty stub.

3. **Still failed after that fix**, with an explicit `NotAllowedError`. Second real cause: the unlock clip was played at `volume = 0`. iOS's autoplay-unlock heuristic appears to specifically require audio that played **with sound** to count as a valid unlock gesture — a technically-successful but silent (zero-volume) playback may not satisfy it. Fixed by removing the explicit `volume = 0` and relying on the WAV's own silent sample data (constant mid-value amplitude) to be inaudible without telling the browser the volume was intentionally zero.

4. **Still failed.** This was the point at which chasing more "unlock trick" variations was abandoned as the wrong approach entirely, in favor of a UX-level fix: **pre-fetch all audio for a stage up front, attempt autoplay, and if that's rejected, reveal a visible "🔊 Tap to hear this" button that plays the *already-loaded* clip synchronously on tap** — a genuinely direct, zero-async-gap gesture, which is what iOS reliably honors. This is the mechanism that actually shipped (`speakSequence()` / `playChain()` in `index.html`).

5. **First clip of a sequence played via the tap-to-listen button; the second (chained) clip in the same sequence did not.** Root cause: each clip was a separate `new Audio()` object; iOS appears to tie its "blessed" gesture permission to the *specific element instance* that was tapped, not the page/session as a whole — a second, different `Audio()` object triggered automatically from the first one's `onended` event was treated as an entirely fresh, ungestured attempt. Fixed by refactoring to use **one single shared `<audio>` element** for the unlock clip and every real playback clip, changing only its `.src` for each new piece of audio rather than constructing new elements.

6. **A specific clip in a sequence silently never played, with no visible sign anything had failed** — `playChain()`'s null-skip logic quietly moved on to the next clip if one failed to fetch. Fixed by having `speakSequence()` explicitly log (via the debug banner, at the time) which clip index failed and what text it corresponded to, so a failure is never silently invisible.

7. **Volume audibly quieter on the second clip in a chained sequence**, even after the shared-element fix. Cause: rapidly swapping `.src` on the shared element the instant the previous clip's `onended` fires can trigger a fade/duck artifact in the browser's audio pipeline. Fixed with a brief (250ms) pause before loading and playing the next clip.

8. **On the very first recording of a session, speech-to-text would stop capturing after about 1 second, requiring a retry — every attempt after the first worked fine.** Cause: the original `unlockTTS()` call was placed at the very top of the mic button's click handler, meaning the very first tap of a session did two audio-subsystem things at once — played the (real, if silent) unlock clip AND started `SpeechRecognition` capture, in the same instant. Audio playback and microphone capture competing for the same subsystem caused the brief capture interruption. Fixed by moving the `unlockTTS()` call entirely out of the mic button and onto the **Continue / Send it** buttons instead — a gesture that fires *after* recording has already stopped, so there's no competition. (This also explains why only the *first* tap was ever affected: once unlocked, every later tap skips the unlock's audio-playing step entirely.)

9. **Speech-to-text on the probe (second) recording occasionally needed two taps to hold.** Related to the same class of problem as #8: if the AI's own spoken audio (paragraph/permission-ask) was still playing or had only just finished when the visitor tapped to record their answer, overlapping speaker output and microphone input could cause the same kind of brief capture failure. Fixed by explicitly pausing the shared audio element the instant a new recording starts, in the mic button's click handler.

10. **Voice capture didn't reliably work on the orb tap at all, independent of the above.** The transcript textarea was being *shown* on recording start but never *focused*. iOS Safari's speech-input handling has historically been less consistent than desktop Chrome's Web Speech API and may depend on the target field being focused. Fixed by explicitly calling `.focus()` on the transcript box both immediately in the click handler and again once recognition's `onstart` fires. **Known tradeoff, not yet resolved**: focusing a text field on mobile will likely pop up the on-screen keyboard, which may visually clash with a voice-first interface. Worth watching in real use — if it feels wrong, the fix is to focus briefly then `.blur()` immediately after, rather than leaving focus (and the keyboard) engaged for the whole recording.

### 7.4 Two smaller, unrelated fixes made in the same session

- **Forminator's own inline "Thank you" success message was flashing on screen** for a fraction of a second before the JS redirect to YourSituation took over. Fixed by having the WPCode snippet hide every known form wrapper by ID the instant the redirect logic fires, before anything else — so Forminator's own message never gets a chance to paint.
- **Debug instrumentation removed.** A temporary on-screen black debug banner (`ttsDebug()`) was added specifically to diagnose the iOS issues above, since iPhone has no easy console access without a Mac. Once all the issues were resolved, `ttsDebug()` was turned into a no-op rather than deleting all ~16 scattered call sites individually — functionally equivalent to full removal (nothing logs, nothing renders, ever) but the inert calls still exist in the source if someone reads the code closely. Full line-by-line removal was offered and explicitly declined.

### 7.5 Known open items from this section

- **"You're all set, Jane" (the confirmation greeting) reads slightly oddly** — noted in live testing, left as-is deliberately. Likely cause: it's a very short, isolated phrase, and ElevenLabs models can read short clips with less natural pacing than longer sentences with more context. Not chased further; revisit only if it becomes a recurring complaint.
- **The mobile-keyboard-on-focus tradeoff from #10 above** is unresolved — works, but may need the focus-then-blur refinement if it feels intrusive in practice.
- Voice ID `hpp4J3VqNfWAUOO0d1Us` was supplied directly by Vince from his own ElevenLabs account — not independently verified against ElevenLabs' own documentation the way the model registry setup was. If this voice is ever deprecated or renamed on ElevenLabs' end, the fix is a one-line change to `VOICE_ID` in `functions/elevenlabs-tts.js`.

---

## 8. Git migration (happened earlier in the same day, before the voice/visual work in §7)

YourSituation moved from manual Netlify drag-and-drop deploys to a GitHub-connected auto-deploy, matching the rest of the fleet.

- Repo: `Your-Situation---Contact-Story-Capture` (VCYR-01, private).
- Local folder: `...\Documents\Research\2026\Your Situation Voice Capture\V3.3`.
- **Folder shape differs from most other tools**: functions live at `functions/` (root), not `netlify/functions/`. `netlify.toml` originally said `functions = "netlify/functions"` — a pre-existing latent bug, not introduced by the migration, that caused a real production 404 on `/api/claude` after the first deploy. Fixed by changing the toml to `functions = "functions"`.
- **GitHub Desktop's "Add Local Repository" failed silently** — created an empty sibling folder with only `.gitattributes`, disconnected from the real source. Same failure mode seen previously on the Site Index migration. Fixed via command line (`git init` / `add` / `commit` / `branch -M main` / `remote add` / `push`) run directly inside `V3.3`.
