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
- **Walther's missing Airtable record** — unrelated pre-existing gap, discovered while cross-referencing arrivals data; still unresolved, tracked separately in `[[aeo-lead-conversion]]`.

---

## 7. Git migration (side effect of today's work)

YourSituation moved from manual Netlify drag-and-drop deploys to a GitHub-connected auto-deploy, matching the rest of the fleet.

- Repo: `Your-Situation---Contact-Story-Capture` (VCYR-01, private).
- Local folder: `...\Documents\Research\2026\Your Situation Voice Capture\V3.3`.
- **Folder shape differs from most other tools**: functions live at `functions/` (root), not `netlify/functions/`. `netlify.toml` originally said `functions = "netlify/functions"` — a pre-existing latent bug, not introduced by the migration, that caused a real production 404 on `/api/claude` after the first deploy. Fixed by changing the toml to `functions = "functions"`.
- **GitHub Desktop's "Add Local Repository" failed silently** — created an empty sibling folder with only `.gitattributes`, disconnected from the real source. Same failure mode seen previously on the Site Index migration. Fixed via command line (`git init` / `add` / `commit` / `branch -M main` / `remote add` / `push`) run directly inside `V3.3`.
