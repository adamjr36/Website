# PPL Workout Tracker — Apps Script backend setup

Backend for the gym logging page. One file (`Code.gs`) deployed as a Google Apps Script
**Web App** that reads and writes the `PPL-Workout-Tracker` sheet.

---

## 1. Create the script (container-bound — recommended)

1. Open the **PPL-Workout-Tracker** spreadsheet.
2. **Extensions → Apps Script**. A new project opens with an empty `Code.gs`.
3. Select everything in the editor and paste the contents of `Code.gs` from this folder.
4. Save (⌘S). Rename the project to something like `PPL Tracker API`.

Container-bound means `SpreadsheetApp.getActive()` just works. The script also falls back to
`SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)` if you ever make it standalone — the sheet id is
already filled in at the top of `Code.gs`.

## 2. Set the timezone — in **both** places

There are two separate timezone settings and they are easy to leave mismatched:

1. **Script**: Apps Script project **Settings** (gear icon in the left rail) → **Time zone** →
   **(GMT-08:00) Los Angeles**.
2. **Spreadsheet**: in the sheet itself, **File → Settings → Time zone** →
   **(GMT-08:00) Los Angeles**.

Dates are read and written in the **spreadsheet** timezone (that's the one that decides which
calendar day a stored date displays as), so a mismatch can't shift your log by a day. Set both the
same anyway — `runSetupCheck` (step 4) prints a warning if they differ, and everything else in the
sheet (formulas, `TODAY()`, filters) uses the spreadsheet's.

Dates are written anchored at **midday** in the spreadsheet timezone rather than midnight, so no
offset or DST edge can roll a session back to the previous day.

While you're in the script Settings, tick **Show "appsscript.json" manifest file** if you want to
see the manifest. Not required.

## 3. Generate and store the shared secret

Generate a long random token locally — **never** commit it, never put it in the page's repo history:

```bash
openssl rand -hex 32
```

Then in the Apps Script editor: **Settings → Script Properties → Add script property**

| Property | Value |
|---|---|
| `TOKEN` | the 64-char hex string you just generated |

Save. This is the only auth: every request must present it, everything else is rejected with
`{"ok":false,"code":"auth","error":"Unauthorized."}`.

> The token is **not** embedded in the page source or the repo. The frontend asks for it once on
> first use (per device) and keeps it in localStorage, so someone who stumbles on the page URL sees
> an empty shell. The realistic exposure is device access or the token leaking in transit history —
> acceptable for a personal single-user gym log. If that stops being acceptable, put the page
> behind real auth or a tiny server-side proxy. Rotating the token = change this Script Property,
> then re-enter it on your device.

## 4. Sanity-check the wiring (optional but fast)

In the editor, pick `runSetupCheck` from the function dropdown and hit **Run**. Authorize when
prompted (see step 5). Open **Execution log** — it prints both timezones (and warns if they
disagree), whether `TOKEN` is set, the actual tab names, the resolved Push/Pull/Legs tabs,
week-block counts, and the exercises in each day's current week.

Nothing is guessed. If a day tab can't be resolved, or a column header can't be matched, it fails
loudly with the real names rather than falling back to a position and writing to the wrong cell.

## 5. Deploy as a Web App

1. **Deploy → New deployment**.
2. Gear next to "Select type" → **Web app**.
3. Fill in:
   - **Description**: `v1`
   - **Execute as**: **Me (your@gmail)**
   - **Who has access**: **Anyone**
4. **Deploy** → **Authorize access** → pick your account → "Google hasn't verified this app" →
   **Advanced** → **Go to PPL Tracker API (unsafe)** → **Allow**. (It's your own script; the warning
   is standard for unverified personal projects.)
5. Copy the **Web app URL**. It ends in `/exec` — that's the one the frontend uses. The `/dev` URL
   requires being logged in as you and will *not* work from the public page.

## 6. Verify with curl

Replace `URL` and `TOKEN`.

**Ping:**

```bash
curl -sL "URL?token=TOKEN&action=ping"
# {"ok":true,"version":"2"}
```

**State:**

```bash
curl -sL "URL?token=TOKEN&action=state" | python3 -m json.tool
```

**Log a set** (note `-L` — Apps Script 302-redirects to `script.googleusercontent.com`):

> The `-H "Content-Type: text/plain"` below is a **curl-only** detail: curl would otherwise send
> `application/x-www-form-urlencoded` for `-d`, which the script parses differently. A **browser**
> must do the opposite and set *no* `Content-Type` at all — `fetch` then defaults to
> `text/plain;charset=UTF-8` by itself, which is what keeps the request CORS-simple. Same wire
> format either way; see §7.

```bash
curl -sL -X POST "URL" \
  -H "Content-Type: text/plain" \
  -d '{
    "token": "TOKEN",
    "action": "log",
    "day": "Push",
    "week": 3,
    "date": "2026-08-07",
    "entries": [
      {"exercise": "Barbell OHP", "s1w": 95, "s1r": 8, "s2w": 95, "s2r": 7, "notes": "felt strong"}
    ]
  }'
# {"ok":true,"written":1,"cells":6,"day":"Push","week":3}
```

`written` counts entries that actually changed a cell; `cells` counts the individual cells written
(including the block's Date cell). An entry that asks for no changes reports `written: 0` rather
than claiming a save.

`day` is the canonical day key — `"Push"`, `"Pull"` or `"Legs"` — **not** the tab name. Tab-like
values (`"Day 1 - Push"`) are matched leniently by the same exact → prefix → substring rules used to
find the tabs, so renaming a tab doesn't break logging.

**`state` and `ping` also work over POST**, with the action in the JSON body — handy when you'd
rather not put the token in a URL:

```bash
curl -sL -X POST "URL" -H "Content-Type: text/plain" -d '{"token":"TOKEN","action":"ping"}'
# {"ok":true,"version":"2"}
curl -sL -X POST "URL" -H "Content-Type: text/plain" -d '{"token":"TOKEN","action":"state"}'
```

GET accepts `ping` and `state` only — `log` is POST-only.

### Error responses

Everything fails with HTTP 200 — check `ok`, not the status code. Every failure carries a
machine-readable `code` alongside the human-readable `error`:

| `code` | Means | What the client does |
|---|---|---|
| `auth` | Bad or missing token | Ask for the token again |
| `config` | Server/sheet misconfigured — `TOKEN` unset, tab or column headers unresolvable | Keep the save queued; needs a fix here, not a new token |
| `validation` | Bad request — unknown day/week/exercise, malformed body or values | Discard the save; retrying can never help |
| `lock` | Another write held the sheet lock | Keep the save queued, retry |
| `internal` | Unexpected exception | Keep the save queued, retry |

```json
{"ok":false,"code":"validation","error":"Unknown week 99 on tab \"Push\". Available weeks: 1, 2, ..."}
```

Classify on `code`, never by pattern-matching `error`. In particular
`Server not configured: Script Property "TOKEN" is not set.` contains the word "token" but is a
`config` problem, not an `auth` one — prompting for a new token would be useless.

## 7. Calling it from the frontend

Apps Script web apps **cannot set CORS headers**, so the client has to avoid triggering a
preflight. Two rules:

- **Do not set a `Content-Type` header** (and no custom headers of any kind). A `fetch` with a
  plain string body defaults to `text/plain;charset=UTF-8`, which is a CORS-*simple* request — no
  preflight, no OPTIONS, no CORS failure. The script parses `e.postData.contents` as JSON.
- **Follow redirects** — `fetch` does this by default. Don't set `redirect: 'manual'`.

```js
const URL = 'https://script.google.com/macros/s/.../exec';
const TOKEN = '...';

// read
const state = await fetch(`${URL}?token=${TOKEN}&action=state`).then(r => r.json());

// write (per-exercise save)
const res = await fetch(URL, {
  method: 'POST',
  body: JSON.stringify({
    token: TOKEN, action: 'log', day: 'Push', week: 3, date: '2026-08-07',
    entries: [{ exercise: 'Barbell OHP', s1w: 95, s1r: 8, s2w: 95, s2r: 7 }]
  })
}).then(r => r.json());

if (!res.ok) {
  // Classify on res.code, never on res.error's wording.
  if (res.code === 'auth') reAskForToken();
  else if (res.code === 'validation') dropThisSave(res.error);   // retrying can't help
  else keepQueuedAndRetryLater(res.error);                       // config / lock / internal
}
```

### Cell values: untouched vs. cleared

Per field (reps, weights **and** notes):

| Sent | Effect |
|---|---|
| omitted, or `null` | leave that cell exactly as it is |
| `""` (empty string) | **clear** that cell |
| a number / string | write it |

`null` and `""` are deliberately different. Only `""` erases — so a client must send `""` *only*
when the user actually emptied a field that held a value. Sending `""` for every blank input would
wipe the sheet's pre-filled reference notes on the first save.

Sending a value again overwrites it — corrections are fine, and repeat posts are harmless.

### `date`, and logging into a past week

`date` follows the same rule as the value fields: **omit it (or send `null`) to leave the block's
merged Date cell exactly as it is**; send `"YYYY-MM-DD"` to (re)write it.

This matters because the Date cell is also the input to the resume rule below. Stamping today onto
an *older* week block makes that block look like an in-progress session, which drags `currentWeek`
backwards and points the next real workout at a week you already finished.

So the frontend only ever sends a date that **dates or re-affirms** the target block, never one
that **moves** it:

- **Auto mode, logging into `currentWeek`.** If that block has **no date yet**, the save sends
  today (dating it — the first write of a session). If it is **already dated** — e.g. the resume
  rule served yesterday's block back for a next-day correction — the save **echoes that block's own
  date**, a no-op rewrite that leaves the Date cell (and the resume anchor) exactly where it was.
  It never restamps a dated `currentWeek` block to today.
- **Manual override, logging into any other week.** See the table below.

The one thing the frontend never does, in either mode, is stamp *today* onto an *already-dated*
block — that is what would drag `currentWeek` backwards. (Echoing a block's own date is safe
because it changes nothing.)

**The one exception: an undated block.** A block whose *first* write came through a week override
was never given a date, and an undated block is invisible to the resume rule: `currentWeek` skips
straight past a half-logged week, and `lastLogged.date` comes back `null`. There is no older date
to protect there, so dating it can only move `currentWeek` forward onto it — never backwards. The
shipped frontend implements exactly this:

| Override target | Date field | What the save sends |
|---|---|---|
| Block **has** a stored date | read-only, shows that block's date | `date: null` — never restamped |
| Block has **no** date | editable, blank | the date the user picks, else `date: null` |

`lastLogged` still reports the last block containing data even when that block is undated
(`{"week":4,"date":null}`) — the backend does not invent a date it was never given. Clients should
render that as "logged, date unknown", not as "never logged".

A phone whose timezone is a calendar day *ahead* of the sheet's (logging from Tokyo against an
America/Los_Angeles sheet) is fine: a block dated "tomorrow" in sheet terms still counts as
resumable, so one session isn't split across two week blocks.

### Reading state

`GET action=state` returns, per day:

| Field | Meaning |
|---|---|
| `currentWeek` | The week to log into — **`null` when the program is complete** (every block has data and none is resumable). Clients must handle `null` and offer a manual week choice. |
| `totalWeeks` | How many week blocks the tab has |
| `exercises` | The rows of the **current** block only, with history (`last`) searched across all blocks. Not a union — an exercise that isn't in the current block gets no entry, because writing to it would fail. |
| `blocks` | Every week's raw values, so a client can show and edit any week without another round trip |
| `catalog` | Target/reference-note per exercise, union across all blocks |

The current week resumes the last dated block if it was logged **today, yesterday or tomorrow** (so
a session running past midnight isn't split across two weeks, next-day corrections are possible, and
a phone a calendar day ahead of the sheet's timezone still resumes its own session); otherwise it
advances to the next block. All three are evaluated in the **spreadsheet** timezone, and by
**calendar** day, not by 24-hour arithmetic — the day the clocks go back is 25 hours long, and a
23:30 session on that night would otherwise be split across two week blocks.

If two blocks carry the **same** week number (a copy-pasted block whose Week cell was never
edited), `state` reports both and every write resolves to the **first** one. The shipped frontend
renders the first as well, so what you see is what gets written; fix the duplicate in the sheet.

### Offline behaviour (frontend)

The frontend caches the last successful `state` response in `localStorage`. If a cold start can't
reach the endpoint (**network** error only — an `auth` or `config` error still shows the gate or an
error screen), it renders that cached state behind a visible "showing saved data as of …" strip,
with the cards, the week override and the save queue all live. A save made in that mode is **never
POSTed straight from the stale render** — it is routed through the same queue and drain as an
offline save, so it gets the identical re-read-and-check discipline below (a cached render is not a
verified server view, and a blind POST would write into whatever week the cache happened to
advertise). It drains on the next successful POST. The backend needs no involvement in any of this;
it just means an offline device can still POST a full session the moment it gets signal.

Draining is **not** a blind replay. Before it POSTs anything the frontend re-reads `state` (unless
the model on screen already came from a live read), and checks every queued write against that
fresh view **cell by cell**: a target cell that is empty, or that already holds the same value, or
that still holds what this device last read from it, is written without ceremony. A cell holding
something this device has never seen — someone logged that session in Sheets meanwhile — is a
conflict, and the write is held, never merged or overwritten. If the re-read fails the whole drain
defers rather than guessing. The conflict test covers the block's **Date** cell as well as the five
value cells, so a *Write anyway* that was approved against one state is automatically re-held if the
sheet's date has moved since — the decision is only honoured while the facts it was made about still
hold. Held writes appear in a **"Needs review"** strip above the cards naming both sides, with the
only two ways out: *Write anyway* or *Discard*. Their cards show a "Needs review" badge that jumps
to the strip, and the card's own **Save button is disabled while it is in review** — so a conflict
can only ever be resolved through those two buttons, never silently overwritten by a direct save. So
a `state` GET immediately before a batch of `log` POSTs is normal traffic, not a bug.

Each queued save is also stamped with the **connection (URL + token) it was made under**, and the
drain refuses to POST any item whose stamp no longer matches the device's current connection. So if
the device is re-pointed at a different sheet while saves are still queued — a URL/token change in
Settings, or a *Forget this device* + reconnect in another tab — those saves are **parked, never
cross-posted into the new account and never silently dropped**; a toast says they belong to a
different connection. They drain normally again if the device is reconnected to their own account,
or go away with *Forget this device*. A plain reload on the **same** account is unaffected — its
stamp still matches, so genuine offline saves still drain.

## 8. Redeploying after edits

Saving the file does **not** update the live `/exec` URL. After any change to `Code.gs`:

**Deploy → Manage deployments** → pick the deployment → ✏️ **Edit** (pencil) →
**Version: New version** → add a description → **Deploy**.

The `/exec` URL stays the same, so nothing on the frontend changes. If you instead do
*New deployment*, you get a **different URL** and have to update the page — avoid that.

---

## What the script will and won't touch

| | |
|---|---|
| Writes | `S1 wt`, `S1 reps`, `S2 wt`, `S2 reps` (cols E–H), `Notes` (col K), and — only when a `date` is sent — the merged `Date` cell (col B) of the target week block |
| Never writes | `Est. 1RM` (col I) and `vs last wk` (col J) — formula columns, guarded in code |
| Never writes | the `Program` and `Personal Records` tabs — explicitly protected by name |
| Never writes | the `EX` example row — detected by the literal `EX` value in col A, not by row number, so it's safe to delete that row |

Tabs are located by case-insensitive name match on `push` / `pull` / `legs` (exact, then prefix,
then substring), and week blocks and exercise lists are discovered by scanning the sheet — nothing
about the layout is hardcoded beyond the column *header names*.

Those headers must all resolve. There is deliberately **no** fallback to the A–K positions: a
renamed header combined with an inserted column would otherwise shift the unresolved fields one
column across and write to the wrong cells. Rename a header and the script fails immediately with a
`config` error naming the column, instead of quietly corrupting the log.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Server not configured: Script Property "TOKEN" is not set.` (`config`) | Step 3 not done, or done on a different script project. This is **not** a token mismatch — don't go re-entering the token on your phone |
| `Unauthorized.` (`auth`) | Token mismatch — check for a trailing newline in the value you pasted |
| `Could not locate day tab(s): ...` (`config`) | A tab got renamed beyond recognition. The error lists the real tab names; rename it back or edit `CONFIG.DAY_MATCHERS` |
| `Could not resolve column(s) ...` (`config`) | A column header was renamed. The error names the missing field and lists the headers it did find — rename it back or add the new spelling to `CONFIG.HEADER_MAP` |
| `Sheet is busy ...` (`lock`) | Two writes collided. Harmless — the client keeps the save queued and retries |
| `Unknown exercise "X" in week N` (`validation`) | That exercise isn't in that week's block. Check the block, or the client is showing a stale card — reload it |
| HTML instead of JSON | You hit the `/dev` URL, or "Who has access" isn't **Anyone** |
| CORS error in the browser | Something is setting a `Content-Type` or custom header on the POST — remove it |
| Changes to `Code.gs` have no effect | You didn't redeploy a **new version** (step 8) |
| Dates land one day off | Spreadsheet timezone (File → Settings) isn't `America/Los_Angeles` (step 2). Run `runSetupCheck` — it warns when the two timezones disagree |
| Clearing a value doesn't stick | The client must send `""` for that field; `null` means "leave it alone" |
