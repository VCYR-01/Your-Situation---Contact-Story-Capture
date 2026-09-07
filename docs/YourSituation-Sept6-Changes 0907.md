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

---

## 9. Remaining scenario emails completed (Luxury, First Time Buyer, Moving Up)

Closes the gap noted in §6 — all eleven `scenario_detected` values now have dedicated or deliberately-shared content; nothing falls through to General Inquiry by omission anymore.

- **Luxury** — sourced from `/off-market-homes/` (private-listing/BrightMLS content), not `/your-situation/distinctive-home/` as first drafted. Distinctive-home page was tried first but off-market-homes is the stronger match: luxury sellers are the exact audience most likely to be pitched a private listing network, and the page has real independent data (100,000+ transaction BrightMLS study, 37 vs. 20 days to contract, no significant price advantage) to back the pushback. First draft's tone ran too confrontational ("you will be pitched...sold to you as prestige") — revised to a more neutral, informational register matching the other ten emails, since the goal is offering useful information, not warning the visitor about something being done to them.
- **First Time Buyer** — sourced from `/your-situation/first-time-buyer/`. Real podcast episode confirmed present on the page. Hook: pre-qualified vs. pre-approved, and the pressure-to-move-fast pattern the source page explicitly names.
- **Moving Up** — no usable current source existed. The only page found (`/move-up-buyer-in-sellers-market/`) is from **2021** and makes claims that are now factually wrong for the current market ("mortgage rates are still at historic lows") — do not reuse this page's specific claims in anything without checking currency first. Wrote fresh content instead, using only durable, non-time-sensitive mechanics (sale-contingent-offer risk, carrying two mortgages, pre-approval before searching). **Deliberately points at the Sell and Buy email's resource link** (`/sell-and-buy/market-discussion/`) rather than claiming a distinct Moving Up podcast episode exists — there's no evidence one does, and asserting "we put together a discussion" about content that isn't real would be a factual problem in an unreviewed automated email.

**Architecture finding, worth knowing**: confirmed directly in `claude.js` (grep for `scenario_detected`) that **Moving Up is a genuinely distinct enumerated value** Claude can output — not an alias for Sell and Buy. A specific regex (`need.{0,20}bigger|outgrown|trade up`, etc.) detects it as its own classification path. So building it as its own scenario was correct, even though its *content* deliberately reuses Sell and Buy's resource. Don't collapse the two in the Zap's Lookup Table thinking they're the same key — they're different keys with intentionally overlapping content.

**Recurring bug, now expected**: the stripped-pill issue (a Table row's `{{FIRST_NAME}}` live field pill getting corrupted to literal bracket text on copy/paste) recurred on the Luxury row exactly as it did on Relocation this morning. Same fix each time — re-insert the pill directly in Zapier's UI rather than pasting it as part of a larger text block. Worth checking every new row for this specifically before considering it done, not just once at the start.

All three tested live end-to-end via real webhook payloads (not just drafted) before being considered complete, same discipline as the original eight.

---

## 10. Test-data cleanup (Airtable)

After the day's testing, 32 records were identified and deleted from the base:
- **17 records** from **Lead Capture** — the twelve scripted PowerShell test payloads (Karen, Robert, Mary, Tom, Test Testerson, Marcee, Priya, Marcus, James, Linda, Diane, Rachel), plus Vincent's own manual click-through tests and two records initially misread as real opt-out visitors ("Charlie," "Dolly") that Vince confirmed were also his own tests.
- **15 records** from **YourSituation_Rounds** — the linked child records for the above. Airtable does not cascade-delete linked records automatically; each had to be identified and deleted separately from the parent.

**Gotcha worth remembering**: Airtable's own `createdTime` metadata can be misleading for records matched by email. One deleted record (`vcyr@thecyrteam.com`) showed a `createdTime` of April 28, 2026, but its actual content was entirely from a test run *today* — because Lead Capture's "Create or Update Record" step matches on email, and a new submission from an email that already has a row **updates that row in place** rather than creating a new one, while Airtable's `createdTime` field only ever reflects when the row was first created, not when its content was last replaced. When auditing for test data (or anything else) by date, check the actual content/submitted-at field, not `createdTime`, or genuinely recent test data can hide under an old timestamp and get missed.

**Explicitly not done**: the corresponding **FUB contacts** created during testing (same names) were not cleaned up — Airtable and FUB are separate systems, and deleting Airtable records has no effect on FUB. If those need cleaning up too, that's a separate, manual pass directly in FUB.

Both delete operations returned a Zapier/Airtable-style `actionId`, meaning either is revertible if something was removed in error — not a permanent, unrecoverable action.


---

## 11. RECOVERY APPENDIX — full canonical content (added Sept 7, after data loss)

**Why this exists**: on Sept 7, the Lookup Table's Luxury/First Time Buyer/Moving Up rows AND their corresponding reference sentences in the Send Message prompt were both found missing — despite having been built, tested, and confirmed working the previous day. The cause was never conclusively diagnosed (possibly a stale save, a Zap version issue, or something else) — but losing content from two separate objects (a Table and a prompt) at the same time means this could happen again. This appendix exists so a third occurrence means pasting from a document, not reconstructing from a chat conversation that may no longer be open.

**If content ever goes missing from the Table or the Send Message prompt again — everything needed to restore it is below.** Also worth noting: on Sept 7, real dated/factual problems were found and fixed in the **Selling** and **Buying** templates (specific market statistics that had gone stale, and a compliance-sensitive claim in Buying that was softened) — the versions below are the corrected Sept 7 versions, not the original Sept 6 ones. If restoring from an older backup or memory, use these, not the originals.

### 11.1 The eleven email templates (paste into the Table, one per `Scenario Detected` key)

**Estate**
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; font-size: 15px;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>We know this process comes with a lot of questions — especially when you're managing probate, coordinating with family, or dealing with a property that needs work.</p>
<p>We put together a discussion that walks through the entire process — court orders, preparation decisions, the "sell as-is vs. invest in updates" math, out-of-state coordination, and a real case study of a family who navigated all of it.</p>
<p style="margin: 24px 0;">
<a href="https://thecyrteam.com/estate-sale/market-discussion/" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Listen to the Estate Sale Discussion →</a>
</p>
<p>It's about 20 minutes and covers the things most families don't think about until they're already in the middle of it.</p>
<p>When you're ready to talk through your specific situation, just reply to this email or call me at <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>.</p>
<p>— Vincent</p>
<p style="font-size: 13px; color: #6b7280; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
Vincent Cyr | The Cyr Team at REAL of Pennsylvania<br>
SRES · CLHMS · 16+ years · 400+ transactions<br>
<a href="https://thecyrteam.com" style="color: #7c3aed; text-decoration: none;">thecyrteam.com</a> · <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Divorce**
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; font-size: 15px;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>We understand that selling a home during a divorce adds a layer of complexity that most agents aren't trained for — two decision-makers, attorneys involved, court timelines, and emotions running high on both sides.</p>
<p>We put together a discussion that covers the full process — court-ordered sales, buyout math, how to handle the home when one spouse is still living there, and the specific ways a divorce sale differs from a standard transaction. Jane holds the RCS-D certification specifically for this work.</p>
<p style="margin: 24px 0;">
<a href="https://thecyrteam.com/divorce-sale/market-discussion/" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Listen to the Divorce Sale Discussion →</a>
</p>
<p>It's straightforward and covers the things most people don't know to ask about until they're already in the middle of it.</p>
<p>When you're ready to talk through your specific situation, just reply to this email or call me at <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>. Everything stays confidential.</p>
<p>— Vincent</p>
<p style="font-size: 13px; color: #6b7280; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
Vincent Cyr · Jane Cyr, RCS-D | The Cyr Team at REAL of Pennsylvania<br>
SRES · CLHMS · 16+ years · 400+ transactions<br>
<a href="https://thecyrteam.com" style="color: #7c3aed; text-decoration: none;">thecyrteam.com</a> · <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Downsizing**
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; font-size: 15px;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>This is one of the most personal transitions in real estate — it's not just about square footage, it's about deciding what the next chapter looks like.</p>
<p>We put together a discussion that walks through the full process — the emotional side of letting go of a family home, the financial math of equity vs. carrying costs, when to sell vs. rent, tax implications for long-time homeowners, and how to actually make the move without it becoming overwhelming.</p>
<p style="margin: 24px 0;">
<a href="https://thecyrteam.com/downsizing/market-discussion/" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Listen to the Downsizing Discussion →</a>
</p>
<p>It's about 20 minutes and covers the things most people wish they'd known before they started.</p>
<p>When you're ready to talk through your timeline and options, just reply to this email or call me at <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>.</p>
<p>— Vincent</p>
<p style="font-size: 13px; color: #6b7280; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
Vincent Cyr | The Cyr Team at REAL of Pennsylvania<br>
SRES · CLHMS · 16+ years · 400+ transactions<br>
<a href="https://thecyrteam.com" style="color: #7c3aed; text-decoration: none;">thecyrteam.com</a> · <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Sell and Buy**
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; font-size: 15px;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>Selling and buying at the same time is the most common fear in real estate — "where do I go if my house sells before I find a new one?" and "what if I buy first and can't sell?" We hear it constantly.</p>
<p>We put together a discussion that breaks down the four strategies — sell first, buy first, simultaneous close, and contingent offers — along with the tools that bridge the gap. There's a detailed case study of a retired couple who moved from Garnet Valley to Kennett Square without a mortgage and without moving twice.</p>
<p style="margin: 24px 0;">
<a href="https://thecyrteam.com/sell-and-buy/market-discussion/" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Listen to the Sell &amp; Buy Discussion →</a>
</p>
<p>The rent-back section alone is worth the listen — it's the one tool that solves the biggest fear in this equation, and most people don't know it exists.</p>
<p>When you're ready to talk through your specific timeline and both markets, just reply to this email or call me at <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>.</p>
<p>— Vincent</p>
<p style="font-size: 13px; color: #6b7280; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
Vincent Cyr | The Cyr Team at REAL of Pennsylvania<br>
SRES · CLHMS · 16+ years · 400+ transactions<br>
<a href="https://thecyrteam.com" style="color: #7c3aed; text-decoration: none;">thecyrteam.com</a> · <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Relocation**
```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; font-size: 15px;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>Moving into southeastern PA or Northern Delaware is tricky if you don't have local knowledge — the school district boundaries don't match the mailing addresses, the tax math between PA and Delaware isn't what it looks like, and Google Maps lies about commute times.</p>
<p>We put together a discussion that covers all of it — the property tax comparison (NJ/NY vs. PA vs. DE), the school district maze, three distinct lifestyle zones, why renting first is usually a mistake, and how to buy confidently even if you can't visit in person. Jane grew up as a military child and understands the psychology of the forced move firsthand.</p>
<p style="margin: 24px 0;">
<a href="https://thecyrteam.com/relocation-services/market-discussion/" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Listen to the Relocation Discussion →</a>
</p>
<p>It's the local knowledge that normally takes five years of living here to learn — compressed into about 20 minutes.</p>
<p>When you're ready to talk through your timeline, priorities, and where you're coming from, just reply to this email or call me at <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>.</p>
<p>— Vincent</p>
<p style="font-size: 13px; color: #6b7280; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
Vincent Cyr · Jane Cyr | The Cyr Team at REAL of Pennsylvania<br>
SRES · CLHMS · 16+ years · 400+ transactions<br>
<a href="https://thecyrteam.com" style="color: #7c3aed; text-decoration: none;">thecyrteam.com</a> · <a href="tel:+14842597910" style="color: #7c3aed; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Selling (Sept 7 de-dated version — replaces the original Sept 6 draft, which cited stale statistics)**
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>A meaningful share of sellers across Chester County and Delaware County end up cutting their price after listing. Inventory is tight, which sounds like a seller's advantage — but the data behind actual sale prices tells a more complicated story.</p>
<p><strong>Here's the math that changes the conversation:</strong></p>
<p>Every month a home sits overpriced costs real carrying costs — mortgage, taxes, insurance, upkeep — that add up long before the price cut you'll eventually have to make anyway. The total cost of "testing the market" routinely exceeds what pricing correctly from day one would have cost.</p>
<p>And the buyer pool shifts with financing conditions in ways most sellers don't track in real time. A home priced for last year's buyers can be priced for buyers who simply aren't shopping anymore.</p>
<p>We cover the full mechanics in an episode of our podcast:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The early window you can't get back once it closes</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why a price drop later doesn't reset buyer perception</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Local factors that can shrink the buyer pool without a seller ever noticing</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why hiring the agent who promises the highest price is often the most expensive mistake</td></tr>
</table>
<p><a href="https://thecyrteam.com/selling-your-home/market-discussion/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Listen or Read the Full Episode</a></p>
<p>If you want to see what the current data says about your specific property — the carrying cost math, the price reduction probability in your neighborhood, and what a correctly priced listing looks like versus what the market will punish — we'll walk through it with you. No aspirational pricing. Just the numbers, current as of when we actually talk.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Buying (Sept 7 revised version — softened compliance claim, removed dated figures; replaces the original Sept 6 draft)**
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>You may have heard that buyers now have to pay their own agent out of pocket, following the NAR settlement. That's misleading. In many transactions, this cost is negotiated as part of the deal rather than paid separately — but the specifics depend on the transaction, and it's worth understanding before you assume either way.</p>
<p>But here's the part that actually matters: if you call the listing agent directly thinking you'll save on commission, you're showing your poker hand to the dealer who's stacking the deck for the other player. That agent has a legal fiduciary duty to the seller — not to you. Whatever you think you're saving can be wiped out by one inspection you misread, one contingency you miss, or one school district line you didn't check.</p>
<p>We cover the full mechanics in an episode of our podcast:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">How fees actually flow (and why sellers often cover them as a marketing cost)</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The inspection scenario where "don't worry, that's just settling" turns into a real, expensive repair</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why the same offer strategy that works in one town can insult a seller in another, 30 minutes away</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The school district trap where your mailing address doesn't match your tax bill</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">What a buyer agency agreement actually commits you to (and what it doesn't)</td></tr>
</table>
<p><a href="https://thecyrteam.com/buying-a-home/market-discussion/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Listen or Read the Full Episode</a></p>
<p>You pay for representation in the commission or you pay for it in the price and the repairs. But you will pay. Understanding how the money actually flows before you make an offer is the difference between a smart purchase and an expensive lesson.</p>
<p>If you want to talk through how fees can be structured for your specific situation and what the current data says in the districts where you're looking — we're here.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**General Inquiry (fallback — "Interview Your Agent")**
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>Whether you're buying, selling, or just starting to think about it — the first big decision isn't about the house. It's about the agent. And most people get it wrong.</p>
<p>Not because they pick a bad agent. Because they pick the wrong <em>type</em> of agent for their situation. A fast, aggressive closer is perfect for an experienced investor — but will steamroll a nervous first-time buyer. A patient educator is perfect for an emotional transition — but will frustrate someone who just wants speed.</p>
<p>We just released a new episode breaking down how to get this right:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The shark vs. sherpa framework — how to figure out what you actually need before you talk to anyone</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">AI prompts that read review language and tell you more than any star rating ever could</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The red flags — "I'll get you the highest price," "we can always come down," and the $40K-$80K math behind them</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why first-time buyers, divorce sales, estate sales, new construction, and luxury each need a fundamentally different agent</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The one-question test that tells you everything: how they react when you ask</td></tr>
</table>
<p><a href="https://thecyrteam.com/interview-your-agent/market-discussion/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Listen or Read the Full Episode</a></p>
<p>We also built a free tool with 60 interview questions across 10 buying and selling scenarios. You can send the same questions to multiple agents and compare their answers side by side. No login, no cost — <a href="https://thecyrteam.com/interview-your-agent/" style="color: #2c3e50;">try it here</a>.</p>
<p>And yes — we're happy to answer those same questions ourselves.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Luxury** (see full HTML also saved as `luxury-email-v3.html`)
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>At this price point, private and exclusive listing networks come up constantly — pitched as prestige and curated buyers. The independent data is worth seeing before you decide either way.</p>
<p>We put together a discussion that covers what the numbers actually show:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The independent BrightMLS study of 100,000+ transactions — no statistically significant price advantage for private listings, and a median 37 days to contract versus 20 on the open MLS</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why nearly 9 in 10 homes that start as private listings end up on the public market anyway</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The five questions worth asking any agent before you agree to a private listing strategy</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why the seller — not the brokerage — owns the asset, and what that means for whose interest a private-listing recommendation actually serves</td></tr>
</table>
<p><a href="https://thecyrteam.com/off-market-homes/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Read the Full Breakdown</a></p>
<p>Vincent holds the CLHMS Guild designation — documented sales performance at the luxury threshold, not just training. If you're weighing a private listing recommendation for your specific property, we're glad to walk through the BrightMLS data for your price range and district before you decide.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**First Time Buyer**
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>Most first-time buyers start by looking at homes. That's backwards — and it's usually how buyers end up overpaying, missing out, or feeling pressured into a decision they weren't ready for.</p>
<p>We put together a discussion that covers what actually matters before you look at a single home:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The difference between pre-qualified and actually ready — and why it decides whether you win or lose a home in this market</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why the inspection decision is more complicated than most agents let on</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">What dual agency actually means for a first-time buyer, and why it matters more for you than anyone else</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The questions worth asking before you ever look at a home</td></tr>
</table>
<p><a href="https://thecyrteam.com/your-situation/first-time-buyer/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Listen or Read the Full Breakdown</a></p>
<p>We don't practice dual agency, and we don't take lender referral fees — your interests are the only ones we represent. You don't need to be ready to buy right now to talk to us. Most of the most useful first-time buyer conversations happen months before anyone makes an offer.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

**Moving Up** (reuses Sell and Buy's resource link deliberately — no distinct podcast episode confirmed to exist)
```html
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; font-size: 15px; line-height: 1.6;">
<p>Hi {{FIRST_NAME}},</p>
<p>{{OPENING_LINE}}</p>
<p>Outgrowing a home is a good problem to have — but it's still a real one. Most move-up buyers get stuck on the same question: how do you buy the next home without getting stuck carrying two mortgages, or selling first and having nowhere to go.</p>
<p>We put together a discussion that covers the actual mechanics:</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin: 15px 0;">
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why sale-contingent offers put you at a disadvantage — and what to do instead</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">How your current equity actually translates into buying power for the next home</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">The sequencing strategies that let you move up without a gap or a scramble</td></tr>
<tr><td style="padding: 4px 10px 4px 0; vertical-align: top; color: #2c3e50; font-weight: bold;">→</td><td style="padding: 4px 0;">Why getting pre-approved before you search changes what sellers see in your offer</td></tr>
</table>
<p><a href="https://thecyrteam.com/sell-and-buy/market-discussion/" style="display: inline-block; background-color: #2c3e50; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Listen or Read the Full Episode</a></p>
<p>When you're ready to talk through your specific equity, timeline, and what the next home needs to look like — we're here.</p>
<p style="margin-top: 30px;">
Vincent &amp; Jane<br>
<strong>The Cyr Team</strong> | REAL of Pennsylvania<br>
<a href="tel:+14842597910" style="color: #2c3e50; text-decoration: none;">(484) 259-7910</a>
</p>
</div>
```

### 11.2 The complete Send Message (Anthropic) prompt

This is the entire prompt text that goes in the Send Message step, with all eleven reference sentences included. `{{situation}}`, `{{area}}`, `{{motivation}}`, `{{notes}}`, `{{Scenario Detected}}` are live Zapier field pills — re-insert them from Catch Hook's field picker, don't type them as literal text, or they won't resolve.

```
You are writing ONE sentence — the opening line of an email — for a real estate visitor who just submitted their situation.

Facts you may use (do not add anything not listed here):
Situation: {{situation}}
Area: {{area}}
Motivation: {{motivation}}
Notes: {{notes}}
Scenario: {{Scenario Detected}}

The sentence immediately following yours will be one of these, depending on the Scenario above — find the one matching this submission's Scenario and use ONLY that one as your reference:

Estate: "We know this process comes with a lot of questions — especially when you're managing probate, coordinating with family, or dealing with a property that needs work."
Divorce: "We understand that selling a home during a divorce adds a layer of complexity that most agents aren't trained for — two decision-makers, attorneys involved, court timelines, and emotions running high on both sides."
Downsizing: "This is one of the most personal transitions in real estate — it's not just about square footage, it's about deciding what the next chapter looks like."
Sell and Buy: "Selling and buying at the same time is the most common fear in real estate — 'where do I go if my house sells before I find a new one?' and 'what if I buy first and can't sell?' We hear it constantly."
Relocation: "Moving into southeastern PA or Northern Delaware is tricky if you don't have local knowledge — the school district boundaries don't match the mailing addresses, the tax math between PA and Delaware isn't what it looks like, and Google Maps lies about commute times."
Selling: "A meaningful share of sellers across Chester County and Delaware County end up cutting their price after listing. Inventory is tight, which sounds like a seller's advantage — but the data behind actual sale prices tells a more complicated story."
Buying: "You may have heard that buyers now have to pay their own agent out of pocket, following the NAR settlement. That's misleading."
General Inquiry: "Whether you're buying, selling, or just starting to think about it — the first big decision isn't about the house. It's about the agent."
Luxury: "At this price point, private and exclusive listing networks come up constantly — pitched as prestige and curated buyers. The independent data is worth seeing before you decide either way."
First Time Buyer: "Most first-time buyers start by looking at homes. That's backwards — and it's usually how buyers end up overpaying, missing out, or feeling pressured into a decision they weren't ready for."
Moving Up: "Outgrowing a home is a good problem to have — but it's still a real one. Most move-up buyers get stuck on the same question: how do you buy the next home without getting stuck carrying two mortgages, or selling first and having nowhere to go."

Write your opening so it flows naturally into that one matching sentence — as if one person wrote both, in one continuous train of thought. Do not repeat its content or ideas. Do not summarize it. Just make sure your sentence's tone and subject naturally lead into it.

STRUCTURE: The sentence has exactly two parts, joined by a comma or dash — nothing more:
1. A factual acknowledgment of their situation (what they told you, in your own words)
2. A brief observation about that situation (e.g., that it's a big transition, a lot to coordinate, a meaningful decision)

The sentence STOPS after part 2. Do not add a third clause. Do not mention what you, Vincent, Jane, or "the team" will do. Do not use the words "help," "assist," "here for you," "here to," "get you," "find you," or any variation of offering future action. The rest of the email already contains the offer to help — your sentence must not duplicate it.

Rules:
- Exactly one sentence. No "and" connecting a third idea.
- Reference at least one specific fact from above.
- No advice, promises, pricing, timelines, or outcomes.
- No exclamation points.
- Do not invent facts not listed above.
- Do not include "Hi [name]."

GOOD: "Relocating from Northern Michigan for your husband's new role at Southco is a big move, especially with four kids in tow."
BAD: "I appreciate you relocating to Coatesville—moving a family of six is no small undertaking, and I'm here to help you get oriented." (adds a third clause offering help — not allowed)
BAD: "I understand you're relocating, and I'd like to help your family find a home." (offers help — not allowed)

Output only the sentence. No preamble, no quotation marks, no explanation.
```

### 11.3 Note on Sept 7's Selling/Buying revisions

Both templates were revised on Sept 7 after a real, live production email (a Lincoln University seller relocating to Tennessee) was found citing the Selling template's original stats — "35-44% of sellers... cutting their prices," a specific "$78,000 in purchasing power" figure, and named local events ("Crozer Health layoffs," "storm damage") — none of which are evergreen facts; they were accurate at some point in the past and had gone stale by the time this recipient received them. The Buying template had a similar, separately-flagged issue: a flat compliance-adjacent claim about how commission fees are structured post-NAR-settlement, softened into a hedged statement rather than a universal assertion.

**Takeaway for anyone maintaining this system going forward**: any email content citing a specific statistic, dollar figure, percentage, or named local event should be treated as time-bound, not evergreen — and should either be periodically reviewed for currency, or (preferably) rewritten the way Selling and Buying were, describing the *shape* of the problem (carrying costs add up, financing conditions shift the buyer pool) without asserting specific numbers that will eventually be wrong. This applies to every template in §11.1 — Estate, Divorce, Downsizing, etc. all still contain some specific figures (e.g. Estate's implicit "$1.5M+" framing from earlier testing, General Inquiry's "$40K-$80K math") that haven't been audited the way Selling and Buying were. Worth a full pass across all eleven at some point, not just the two that happened to get caught.
