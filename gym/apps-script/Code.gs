/**
 * PPL Workout Tracker — Apps Script Web App backend
 * ---------------------------------------------------------------------------
 * Spreadsheet: "PPL-Workout-Tracker"
 *
 * Endpoints (all responses are JSON, {ok:true,...} or {ok:false,code:"..",error:".."}):
 *
 *   GET  ?token=SECRET&action=ping    -> {ok:true, version:"2"}
 *   GET  ?token=SECRET&action=state   -> full logging state for Push/Pull/Legs
 *   POST body (text/plain JSON):
 *        {token, action:"log", day, week, date, entries:[{exercise,s1w,s1r,s2w,s2r,notes}]}
 *                                     -> {ok:true, written:n, cells:n, day, week}
 *        {token, action:"ping"} and {token, action:"state"} also work over POST,
 *        for callers that would rather not put the token in a URL.
 *
 * Error contract — every {ok:false} carries a machine-readable `code`:
 *   "auth"       bad or missing token
 *   "config"     server/sheet misconfiguration (TOKEN unset, tab or header
 *                resolution failure, protected/formula column hit)
 *   "validation" bad request: unknown day/week/exercise, malformed body/values
 *   "lock"       LockService timeout — the sheet is busy, retry
 *   "internal"   anything else (unexpected exception)
 * Only "auth" means "re-enter the token"; the rest are retryable or need a fix.
 *
 * Cell-value semantics for `entries[]`:
 *   field absent or null -> leave that cell untouched
 *   field === ""         -> CLEAR that cell (writes an empty cell)
 *   field is a number    -> write it
 * The same applies to `notes`, and to `date`: an absent/null `date` leaves the
 * block's merged Date cell alone. Callers logging into a week OTHER than the
 * server's currentWeek (a correction via the client's manual week override)
 * must send date:null — restamping an older block with today makes the resume
 * rule below treat it as an in-progress session and drags currentWeek back.
 *
 * `day` is the canonical day key ("Push" / "Pull" / "Legs"), not the tab name,
 * though tab-like values ("Day 1 - Push") are matched leniently.
 *
 * Safety rules baked in:
 *   - Only tabs resolved as Push / Pull / Legs day tabs are ever written to.
 *     "Program" and "Personal Records" are explicitly protected.
 *   - Columns I (Est. 1RM) and J (vs last wk) hold formulas and are NEVER written.
 *   - Writes are wrapped in a script lock; the sheet is read *after* the lock is
 *     taken so read-modify-write is atomic across concurrent requests.
 *   - Every request must present the shared secret in Script Property `TOKEN`.
 *   - Dates are read and written in the SPREADSHEET timezone, not the script
 *     timezone, so a mismatch between the two can't shift dates by a day.
 *
 * See SETUP.md for deployment.
 */

// ===========================================================================
// CONFIG
// ===========================================================================

var CONFIG = {
  VERSION: '2',

  /** Fallback when the script is NOT container-bound to the sheet. */
  SPREADSHEET_ID: '1PX5tuZbVs3YkXSIco1Okn6gnvTQcdE9zhDIie9eHCzU',

  /** Script Property key holding the shared secret. */
  TOKEN_PROPERTY: 'TOKEN',

  /** Canonical day keys returned in the `days` object, in display order. */
  DAY_KEYS: ['Push', 'Pull', 'Legs'],

  /**
   * Tab-name matchers per day key, highest priority first. Matched against the
   * tab name normalized to lowercase alphanumerics ("Push Day" -> "pushday").
   */
  DAY_MATCHERS: {
    Push: ['push'],
    Pull: ['pull'],
    Legs: ['legs', 'leg']
  },

  /** Tabs that must never be written to, matched on normalized name. */
  PROTECTED_TABS: ['program', 'personalrecords', 'prs', 'records', 'readme', 'instructions'],

  /** Row range searched for the header row (the one whose col A reads "Week"). */
  HEADER_SEARCH_ROWS: 12,

  /** Column header labels -> logical field. Normalized before comparison. */
  HEADER_MAP: {
    week: 'week',
    date: 'date',
    exercise: 'exercise',
    target: 'target',
    s1wt: 's1w',
    s1reps: 's1r',
    s2wt: 's2w',
    s2reps: 's2r',
    est1rm: 'est1rm',
    vslastwk: 'vslast',
    notes: 'notes'
  },

  /**
   * The columns every day tab must expose, with their canonical 1-based A–K
   * positions. Positions are reference/documentation only: every field must be
   * resolved from the header row by name, and parsing fails loudly (code
   * "config") if any of them can't be. Silently falling back to these positions
   * used to turn "someone renamed a header and inserted a column" into a
   * confusing formula-guard error at write time.
   */
  DEFAULT_COLS: {
    week: 1, date: 2, exercise: 3, target: 4,
    s1w: 5, s1r: 6, s2w: 7, s2r: 8,
    est1rm: 9, vslast: 10, notes: 11
  },

  /** Columns that are formula-owned. Guarded against at write time. */
  READONLY_FIELDS: ['est1rm', 'vslast'],

  /**
   * currentWeek resolution.
   *
   * The literal "first block whose S1 wt cells are all empty" rule breaks on
   * two real cases in this sheet:
   *   (a) a skipped/blank earlier week (Legs week 1 is empty, week 2 is logged)
   *       would be reported forever as "current";
   *   (b) a deliberately-blank row (Bench BB vs Bench DB — you log one, not
   *       both) makes a finished week look permanently "partial".
   *
   * So: current = the block after the last block containing any set data,
   * UNLESS that last block's Date is today, yesterday *or tomorrow*, in which
   * case it's an in-progress session (or a session that ran past midnight, a
   * next-day correction, or a phone whose timezone is a day ahead of the
   * sheet's) and we resume it. Set RESUME_BY_DATE=false to always advance.
   *
   * When the last block with data is the LAST block, there is no block to
   * advance to: currentWeek comes back as null ("program complete") rather
   * than silently pinning every further write onto week 12. The client offers
   * a manual week override for that case.
   */
  RESUME_BY_DATE: true,

  /** How many days back a dated block still counts as "resumable". */
  RESUME_DAYS: 1,

  /** Seconds to wait for the script lock on writes. */
  LOCK_TIMEOUT_MS: 20000
};

// ===========================================================================
// ENTRY POINTS
// ===========================================================================

function doGet(e) {
  return respond_(function () {
    var params = (e && e.parameter) || {};
    requireToken_(params.token);
    var action = String(params.action || 'state').toLowerCase();

    if (action === 'ping') return { ok: true, version: CONFIG.VERSION };
    if (action === 'state') return getState_();

    throw new UserError_('Unknown action "' + action + '". Supported GET actions: ping, state.', 'validation');
  });
}

function doPost(e) {
  return respond_(function () {
    var body = parseBody_(e);
    requireToken_(body.token || ((e && e.parameter && e.parameter.token) || ''));
    var action = String(body.action || '').toLowerCase();

    if (action === 'log') return logEntries_(body);
    if (action === 'ping') return { ok: true, version: CONFIG.VERSION };
    if (action === 'state') return getState_();

    throw new UserError_('Unknown action "' + action + '". Supported POST actions: log, state, ping.', 'validation');
  });
}

/**
 * Run this from the Apps Script editor after setup to sanity-check wiring.
 * Logs the resolved tabs, week counts and detected exercises.
 */
function runSetupCheck() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(CONFIG.TOKEN_PROPERTY);
  Logger.log('TOKEN property: %s', token ? 'set (' + token.length + ' chars)' : '!! NOT SET !!');

  var ss = getSpreadsheet_();
  Logger.log('Spreadsheet: %s', ss.getName());

  var scriptTz = Session.getScriptTimeZone();
  var ssTz = ss.getSpreadsheetTimeZone();
  Logger.log('Script timezone: %s', scriptTz);
  Logger.log('Spreadsheet timezone: %s', ssTz);
  if (ssTz !== scriptTz) {
    Logger.log('!! WARNING: spreadsheet timezone (%s) does not match the script timezone (%s).', ssTz, scriptTz);
    Logger.log('!! Dates are read and written in the SPREADSHEET timezone, so logging still works,');
    Logger.log('!! but set both the same (SETUP.md step 2) to avoid surprises elsewhere.');
  }

  Logger.log('Tabs: %s', ss.getSheets().map(function (s) { return s.getName(); }).join(' | '));

  var tabs = resolveDayTabs_(ss);
  CONFIG.DAY_KEYS.forEach(function (key) {
    var parsed = parseTab_(tabs[key]);
    var state = buildDayState_(parsed);
    Logger.log('%s -> tab "%s", %s week blocks, currentWeek %s of %s, exercises in that block: %s',
      key, parsed.tabName, parsed.blocks.length,
      state.currentWeek === null ? 'null (program complete)' : state.currentWeek,
      state.totalWeeks,
      state.exercises.map(function (x) { return x.name; }).join(', ') || '(none)');
  });
  Logger.log('Setup check OK.');
}

// ===========================================================================
// ACTIONS
// ===========================================================================

/** GET action=state */
function getState_() {
  var ss = getSpreadsheet_();
  var tabs = resolveDayTabs_(ss);
  var days = {};

  CONFIG.DAY_KEYS.forEach(function (key) {
    days[key] = buildDayState_(parseTab_(tabs[key]));
  });

  return { ok: true, days: days };
}

/**
 * POST action=log
 *
 * Per-field semantics (see the file header): a field that is absent or null is
 * left untouched, a field that is "" clears the cell, a numeric field is
 * written. SKIP is the sentinel for "untouched" so that "" survives as a real,
 * distinct instruction all the way to setValue('').
 */
var SKIP_ = {};   // unique sentinel — never equal to any client-supplied value

function logEntries_(body) {
  var day = String(body.day || '').trim();
  if (!day) throw new UserError_('Missing "day". Expected one of: ' + CONFIG.DAY_KEYS.join(', ') + '.', 'validation');

  var week = toNumber_(body.week);
  if (week === null) throw new UserError_('Missing or non-numeric "week".', 'validation');

  var entries = body.entries;
  if (!Array.isArray(entries) || !entries.length) {
    throw new UserError_('Missing "entries" — expected a non-empty array.', 'validation');
  }

  var dateValue = null;
  if (body.date !== null && body.date !== undefined && String(body.date).trim() !== '') {
    dateValue = parseIsoDate_(String(body.date).trim());
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (err) {
    throw new UserError_('Sheet is busy (could not acquire lock). Retry in a moment.', 'lock');
  }

  try {
    // Read AFTER taking the lock so validate-then-write is atomic.
    var ss = getSpreadsheet_();
    var tabs = resolveDayTabs_(ss);

    var dayKey = matchDayKey_(day);
    if (!dayKey) {
      throw new UserError_('Unknown day "' + day + '". Expected one of: ' + CONFIG.DAY_KEYS.join(', ') + '.', 'validation');
    }
    var sheet = tabs[dayKey];
    assertWritable_(sheet);

    var parsed = parseTab_(sheet);
    var block = findBlock_(parsed, week);
    if (!block) {
      throw new UserError_(
        'Unknown week ' + week + ' on tab "' + parsed.tabName + '". Available weeks: ' +
        parsed.blocks.map(function (b) { return b.week; }).join(', ') + '.',
        'validation'
      );
    }

    // ---- validate everything before writing anything -----------------------
    var plan = entries.map(function (entry, i) {
      var label = 'entries[' + i + ']';
      if (!entry || typeof entry !== 'object') throw new UserError_(label + ' is not an object.', 'validation');

      var name = String(entry.exercise === undefined || entry.exercise === null ? '' : entry.exercise).trim();
      if (!name) throw new UserError_(label + ' is missing "exercise".', 'validation');

      var row = findExerciseRow_(block, name);
      if (!row) {
        throw new UserError_(
          'Unknown exercise "' + name + '" in week ' + week + ' of tab "' + parsed.tabName +
          '". Exercises in that block: ' + block.rows.map(function (r) { return r.exercise; }).join(', ') + '.',
          'validation'
        );
      }

      var nums = {};
      ['s1w', 's1r', 's2w', 's2r'].forEach(function (field) {
        nums[field] = cellValue_(entry, field, label);
      });

      return { row: row, values: nums, notes: noteValue_(entry), exercise: row.exercise };
    });

    // ---- write -------------------------------------------------------------
    var cells = 0;

    if (dateValue) {
      var anchor = mergeAnchor_(sheet, block.topRow, parsed.cols.date);
      sheet.getRange(anchor.row, anchor.col).setValue(dateValue);
      cells++;
    }

    var written = 0;
    plan.forEach(function (item) {
      var wroteSomething = false;

      ['s1w', 's1r', 's2w', 's2r'].forEach(function (field) {
        if (item.values[field] === SKIP_) return;
        var col = parsed.cols[field];
        guardColumn_(parsed, col);
        sheet.getRange(item.row.row, col).setValue(item.values[field]);
        wroteSomething = true;
        cells++;
      });

      if (item.notes !== SKIP_) {
        guardColumn_(parsed, parsed.cols.notes);
        sheet.getRange(item.row.row, parsed.cols.notes).setValue(item.notes);
        wroteSomething = true;
        cells++;
      }

      // `written` counts entries that actually touched a cell — a date-only
      // request no longer inflates it into a "saved" that wrote nothing.
      if (wroteSomething) written++;
    });

    SpreadsheetApp.flush();

    return { ok: true, written: written, cells: cells, day: dayKey, week: block.week };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** entry[field] -> SKIP_ (untouched) | '' (clear the cell) | Number. */
function cellValue_(entry, field, label) {
  var raw = entry[field];
  if (raw === undefined || raw === null) return SKIP_;
  if (typeof raw === 'string' && raw.trim() === '') return '';   // explicit clear
  var n = toNumber_(raw);
  if (n === null) {
    throw new UserError_(label + '.' + field + ' = "' + raw + '" is not a number.', 'validation');
  }
  return n;
}

/** entry.notes -> SKIP_ (untouched) | '' (clear the cell) | String. */
function noteValue_(entry) {
  var raw = entry.notes;
  if (raw === undefined || raw === null) return SKIP_;
  var s = String(raw);
  return s.trim() === '' ? '' : s;
}

// ===========================================================================
// STATE BUILDING
// ===========================================================================

/**
 * Turn a parsed tab into the `days[key]` payload.
 *
 * `exercises` describes the CURRENT week block only — its rows, in sheet order.
 * That way a renamed / added / removed exercise mid-program renders truthfully
 * instead of the client showing a card for an exercise that isn't in the block
 * it is about to write to. Per-exercise history (`last`) still searches every
 * earlier block by name.
 *
 * `blocks` carries every week's raw values so the client can offer a manual
 * week override (and render that block's values) without another round trip.
 * `catalog` holds the union of exercise metadata, for weeks whose exercise set
 * differs from the current one.
 */
function buildDayState_(parsed) {
  var currentIdx = resolveCurrentBlockIndex_(parsed);
  var currentBlock = currentIdx >= 0 ? (parsed.blocks[currentIdx] || null) : null;

  var lastDataIdx = lastBlockWithDataIndex_(parsed);
  var lastLogged = null;
  if (lastDataIdx >= 0) {
    lastLogged = {
      week: parsed.blocks[lastDataIdx].week,
      date: parsed.blocks[lastDataIdx].dateIso
    };
  }

  var exercises = (currentBlock ? currentBlock.rows : []).map(function (row) {
    return {
      name: row.exercise,
      target: row.target || parsed.targets[row.exercise] || null,
      note: parsed.referenceNotes[row.exercise] || null,
      current: {
        s1w: row.s1w,
        s1r: row.s1r,
        s2w: row.s2w,
        s2r: row.s2r,
        notes: sessionNote_(parsed, row)
      },
      last: findLastForExercise_(parsed, row.exercise, currentIdx)
    };
  });

  var catalog = {};
  parsed.exerciseNames.forEach(function (name) {
    catalog[name] = {
      target: parsed.targets[name] || null,
      note: parsed.referenceNotes[name] || null
    };
  });

  var blocks = parsed.blocks.map(function (b) {
    return {
      week: b.week,
      date: b.dateIso,
      rows: b.rows.map(function (row) {
        return {
          exercise: row.exercise,
          s1w: row.s1w,
          s1r: row.s1r,
          s2w: row.s2w,
          s2r: row.s2r,
          est1rm: row.est1rm,
          notes: sessionNote_(parsed, row)
        };
      })
    };
  });

  return {
    tabName: parsed.tabName,
    currentWeek: currentBlock ? currentBlock.week : null,   // null = program complete
    totalWeeks: parsed.blocks.length,
    lastLogged: lastLogged,
    exercises: exercises,
    catalog: catalog,
    blocks: blocks
  };
}

/**
 * The Notes column doubles as pre-filled reference text and the per-session
 * note; only the part that differs from the reference note is the user's.
 */
function sessionNote_(parsed, row) {
  if (!row.notes) return null;
  return row.notes === parsed.referenceNotes[row.exercise] ? null : row.notes;
}

/** Index of the last block containing any set data (E–H), or -1. */
function lastBlockWithDataIndex_(parsed) {
  for (var i = parsed.blocks.length - 1; i >= 0; i--) {
    if (parsed.blocks[i].hasData) return i;
  }
  return -1;
}

/**
 * See CONFIG.RESUME_BY_DATE for the rationale behind this rule.
 * Returns -1 when there is no block to log into (empty tab, or the program is
 * complete) — callers surface that as currentWeek: null.
 */
function resolveCurrentBlockIndex_(parsed) {
  if (!parsed.blocks.length) return -1;

  var lastIdx = lastBlockWithDataIndex_(parsed);
  if (lastIdx < 0) return 0; // nothing logged yet -> first block

  if (CONFIG.RESUME_BY_DATE) {
    // Today OR the last few days: a session that ran past midnight must not be
    // split across two week blocks, and next-day corrections have to be
    // possible from the phone.
    var iso = parsed.blocks[lastIdx].dateIso;
    if (iso && isRecentIso_(iso, CONFIG.RESUME_DAYS)) return lastIdx;
  }

  if (lastIdx + 1 < parsed.blocks.length) return lastIdx + 1;
  return -1;   // last block already has data -> program complete
}

/**
 * True when `iso` is today, up to `days` days ago, or TOMORROW — all in the
 * sheet's timezone.
 *
 * Tomorrow is not a typo. The client stamps the phone's own calendar day, and a
 * phone can legitimately be a day ahead of the sheet (logging from Tokyo with an
 * America/Los_Angeles sheet). Without it, the block that was just written reads
 * as "not recent", currentWeek advances, and the rest of that same session gets
 * split into the next week block.
 */
function isRecentIso_(iso, days) {
  for (var back = -1; back <= days; back++) {
    if (iso === isoDaysAgo_(back)) return true;
  }
  return false;
}

/** Most recent block strictly before `beforeIdx` holding data for `name`. */
function findLastForExercise_(parsed, name, beforeIdx) {
  var limit = beforeIdx < 0 ? parsed.blocks.length : beforeIdx;
  for (var i = limit - 1; i >= 0; i--) {
    var row = findExerciseRow_(parsed.blocks[i], name);
    if (row && row.hasData) {
      return {
        week: parsed.blocks[i].week,
        s1w: row.s1w,
        s1r: row.s1r,
        s2w: row.s2w,
        s2r: row.s2r,
        est1rm: row.est1rm
      };
    }
  }
  return null;
}

// ===========================================================================
// SHEET PARSING
// ===========================================================================

function getSpreadsheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (ignored) {}
  if (ss) return ss;

  if (!CONFIG.SPREADSHEET_ID) {
    throw new UserError_('Script is not bound to a spreadsheet and CONFIG.SPREADSHEET_ID is empty.', 'config');
  }
  try {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (err) {
    throw new UserError_('Could not open spreadsheet ' + CONFIG.SPREADSHEET_ID + ': ' + err.message, 'config');
  }
}

/**
 * The timezone dates are read and written in.
 *
 * This is the SPREADSHEET timezone (File -> Settings), not the script one.
 * They are configured in two different places and drift apart easily; the
 * spreadsheet's is the one that decides which calendar day a stored Date
 * renders as, so using it end-to-end makes a mismatch harmless.
 * Memoized: getSpreadsheetTimeZone() is a service call.
 */
var TZ_CACHE_ = null;
function timeZone_() {
  if (TZ_CACHE_) return TZ_CACHE_;
  try { TZ_CACHE_ = getSpreadsheet_().getSpreadsheetTimeZone(); } catch (ignored) {}
  if (!TZ_CACHE_) { TZ_CACHE_ = Session.getScriptTimeZone(); }
  return TZ_CACHE_;
}

/**
 * "YYYY-MM-DD" for N days ago in the sheet's timezone (0 = today, -1 = tomorrow).
 *
 * Counts CALENDAR days, not 86 400 000 ms. Subtracting a fixed 24 hours breaks
 * on a DST boundary: the day the clocks go back is 25 hours long, so "yesterday"
 * computed by ms subtraction from 23:30 lands back on TODAY. isRecentIso_ then
 * failed to recognise the block written earlier that same evening as recent,
 * currentWeek advanced, and the rest of that session was split into the next
 * week block. Formatting "now" in the sheet's timezone first and shifting the
 * y/m/d triple afterwards (through UTC, which has no DST) is exact.
 */
function isoDaysAgo_(days) {
  var todayIso = Utilities.formatDate(new Date(), timeZone_(), 'yyyy-MM-dd');
  if (!days) return todayIso;
  var p = todayIso.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - days));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Map canonical day key -> Sheet, failing loudly with the real tab names. */
function resolveDayTabs_(ss) {
  var sheets = ss.getSheets();
  var names = sheets.map(function (s) { return s.getName(); });
  var candidates = sheets.filter(function (s) { return !isProtectedName_(s.getName()); });

  var out = {};
  var missing = [];

  CONFIG.DAY_KEYS.forEach(function (key) {
    var matchers = CONFIG.DAY_MATCHERS[key] || [key.toLowerCase()];
    var found = null;

    // Tier 1 exact, tier 2 prefix, tier 3 substring — in matcher priority order.
    ['exact', 'prefix', 'contains'].forEach(function (tier) {
      if (found) return;
      matchers.forEach(function (m) {
        if (found) return;
        candidates.forEach(function (sheet) {
          if (found) return;
          var n = normalize_(sheet.getName());
          var hit = tier === 'exact' ? n === m
                  : tier === 'prefix' ? n.indexOf(m) === 0
                  : n.indexOf(m) !== -1;
          if (hit) found = sheet;
        });
      });
    });

    if (found) out[key] = found; else missing.push(key);
  });

  if (missing.length) {
    throw new UserError_(
      'Could not locate day tab(s): ' + missing.join(', ') +
      '. Tabs in "' + ss.getName() + '": ' + names.join(' | ') +
      '. Rename a tab so its name contains push / pull / legs, or update CONFIG.DAY_MATCHERS.',
      'config'
    );
  }
  return out;
}

/**
 * Map a client-supplied day string ("push", "Push Day", "Day 1 - Push") to a
 * canonical day key ("Push"), or null if it doesn't look like any of them.
 *
 * Uses the same exact -> prefix -> contains tiers as resolveDayTabs_. They have
 * to agree: a renamed tab that resolveDayTabs_ finds by substring must also be
 * loggable, or `state` works while every save fails. Tiers are applied across
 * all day keys before moving on, so an exact match always beats a substring
 * match on a different key.
 */
function matchDayKey_(day) {
  var n = normalize_(day);
  if (!n) return null;

  var tiers = ['exact', 'prefix', 'contains'];
  for (var t = 0; t < tiers.length; t++) {
    for (var i = 0; i < CONFIG.DAY_KEYS.length; i++) {
      var key = CONFIG.DAY_KEYS[i];
      var matchers = [normalize_(key)].concat(CONFIG.DAY_MATCHERS[key] || []);
      for (var m = 0; m < matchers.length; m++) {
        var needle = matchers[m];
        if (!needle) continue;
        var hit = tiers[t] === 'exact' ? n === needle
                : tiers[t] === 'prefix' ? n.indexOf(needle) === 0
                : n.indexOf(needle) !== -1;
        if (hit) return key;
      }
    }
  }
  return null;
}

function isProtectedName_(name) {
  return CONFIG.PROTECTED_TABS.indexOf(normalize_(name)) !== -1;
}

function assertWritable_(sheet) {
  if (isProtectedName_(sheet.getName())) {
    throw new UserError_('Refusing to write to protected tab "' + sheet.getName() + '".', 'config');
  }
}

function guardColumn_(parsed, col) {
  var bad = CONFIG.READONLY_FIELDS.some(function (f) { return parsed.cols[f] === col; });
  if (bad) throw new UserError_('Refusing to write to formula column ' + colLetter_(col) + '.', 'config');
}

/**
 * Parse a day tab into:
 *   { tabName, headerRow, cols, blocks[], exerciseNames[], targets{}, referenceNotes{} }
 *
 * A block starts at any row whose Week cell (col A) holds a number, and runs
 * until the next such row. The Week and Date cells are vertically merged, so
 * only the block's top row carries a value — every other row reads ''.
 * The "EX" example row is detected by value and skipped.
 */
function parseTab_(sheet) {
  var tabName = sheet.getName();
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 11);
  if (lastRow < 2) throw new UserError_('Tab "' + tabName + '" looks empty.', 'config');

  var vals = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headerRow = findHeaderRow_(vals);
  var cols = resolveColumns_(vals[headerRow - 1]);

  var blocks = [];
  var current = null;
  var exerciseNames = [];
  var targets = {};
  var noteCounts = {};

  for (var r = headerRow + 1; r <= lastRow; r++) {
    var row = vals[r - 1];
    var weekRaw = row[cols.week - 1];
    var weekStr = String(weekRaw === null || weekRaw === undefined ? '' : weekRaw).trim();

    if (weekStr.toUpperCase() === 'EX') { current = null; continue; }  // example row

    if (weekStr !== '') {
      var weekNum = toNumber_(weekStr);
      if (weekNum === null) { current = null; continue; }  // unrecognized marker -> end block
      current = {
        week: weekNum,
        topRow: r,
        dateValue: null,
        dateIso: null,
        rows: [],
        hasData: false
      };
      blocks.push(current);
      var dv = row[cols.date - 1];
      if (!isBlank_(dv)) { current.dateValue = dv; current.dateIso = toIsoDate_(dv); }
    }

    if (!current) continue;

    var exercise = String(row[cols.exercise - 1] || '').trim();
    if (!exercise) continue;

    var entry = {
      row: r,
      exercise: exercise,
      target: blankToNull_(row[cols.target - 1]),
      s1w: toNumber_(row[cols.s1w - 1]),
      s1r: toNumber_(row[cols.s1r - 1]),
      s2w: toNumber_(row[cols.s2w - 1]),
      s2r: toNumber_(row[cols.s2r - 1]),
      est1rm: toNumber_(row[cols.est1rm - 1]),
      notes: blankToNull_(row[cols.notes - 1])
    };
    entry.hasData = entry.s1w !== null || entry.s1r !== null || entry.s2w !== null || entry.s2r !== null;

    current.rows.push(entry);
    if (entry.hasData) current.hasData = true;

    // Date can hide below the merge anchor in odd sheets — pick up the first one.
    if (!current.dateIso && !isBlank_(row[cols.date - 1])) {
      current.dateValue = row[cols.date - 1];
      current.dateIso = toIsoDate_(row[cols.date - 1]);
    }

    if (exerciseNames.indexOf(exercise) === -1) exerciseNames.push(exercise);
    if (!targets[exercise] && entry.target) targets[exercise] = entry.target;

    if (entry.notes) {
      noteCounts[exercise] = noteCounts[exercise] || {};
      var rec = noteCounts[exercise][entry.notes] || { total: 0, blank: 0 };
      rec.total++;
      if (!entry.hasData) rec.blank++;   // a note on a never-logged row = template text
      noteCounts[exercise][entry.notes] = rec;
    }
  }

  if (!blocks.length) {
    throw new UserError_('No week blocks found on tab "' + tabName + '" (looked for numeric Week values below row ' + headerRow + ').', 'config');
  }

  return {
    tabName: tabName,
    headerRow: headerRow,
    cols: cols,
    blocks: blocks,
    exerciseNames: exerciseNames,
    targets: targets,
    referenceNotes: modalNotes_(noteCounts)
  };
}

/**
 * Column K doubles as the pre-filled reference note AND the per-session note.
 * The reference note is the one repeated across most week blocks; whatever
 * differs in a given week is treated as the user's own note.
 *
 * Two repeats is not enough evidence: writing "shoulder felt off" in two weeks
 * running would promote it to permanent reference text and then hide it from
 * both of those weeks. So a note has to appear either
 *   - in at least MIN_REFERENCE_REPEATS blocks, or
 *   - on at least MIN_REFERENCE_BLANK blocks that were never logged into,
 * which is where the template text the sheet ships with survives untouched.
 * The second rule keeps a genuine reference note from being demoted once the
 * user has overwritten it in most of the weeks they've actually trained.
 */
var MIN_REFERENCE_REPEATS = 3;
var MIN_REFERENCE_BLANK = 2;

function modalNotes_(noteCounts) {
  var out = {};
  Object.keys(noteCounts).forEach(function (exercise) {
    var best = null, bestN = 0, bestBlank = 0;
    Object.keys(noteCounts[exercise]).forEach(function (note) {
      var rec = noteCounts[exercise][note];
      // Rank by "looks like template text" first, then by raw frequency.
      var better = rec.blank > bestBlank || (rec.blank === bestBlank && rec.total > bestN);
      if (better) { bestN = rec.total; bestBlank = rec.blank; best = note; }
    });
    out[exercise] = (bestN >= MIN_REFERENCE_REPEATS || bestBlank >= MIN_REFERENCE_BLANK) ? best : null;
  });
  return out;
}

function findHeaderRow_(vals) {
  var limit = Math.min(CONFIG.HEADER_SEARCH_ROWS, vals.length);
  for (var r = 1; r <= limit; r++) {
    if (normalize_(vals[r - 1][0]) === 'week') return r;
  }
  throw new UserError_('Could not find the header row (col A = "Week") in the first ' + limit + ' rows.', 'config');
}

/**
 * Resolve every column from the header row by name. Fails loudly (code
 * "config") if any expected column is missing.
 *
 * There used to be a silent fallback to the canonical A–K positions. It made
 * the realistic failure — a renamed header plus an inserted column — shift
 * every unresolved field one column right, so writes landed in the wrong cells
 * or tripped the formula guard with an error that pointed nowhere near the
 * cause. Failing at parse time names the actual problem instead.
 */
function resolveColumns_(headerRow) {
  var cols = {};
  Object.keys(CONFIG.DEFAULT_COLS).forEach(function (f) { cols[f] = null; });

  for (var c = 0; c < headerRow.length; c++) {
    var field = CONFIG.HEADER_MAP[normalize_(headerRow[c])];
    if (field && cols[field] === null) cols[field] = c + 1;
  }

  var missing = Object.keys(CONFIG.DEFAULT_COLS).filter(function (f) { return cols[f] === null; });
  if (missing.length) {
    var seen = headerRow
      .map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); })
      .filter(function (h) { return h !== ''; });
    throw new UserError_(
      'Could not resolve column(s) ' + missing.join(', ') + ' from the header row. ' +
      'Headers found: ' + (seen.length ? seen.join(' | ') : '(none)') + '. ' +
      'Expected: Week, Date, Exercise, Target, S1 wt, S1 reps, S2 wt, S2 reps, Est. 1RM, vs last wk, Notes. ' +
      'Rename the header back, or add the new spelling to CONFIG.HEADER_MAP.',
      'config'
    );
  }
  return cols;
}

function findBlock_(parsed, week) {
  for (var i = 0; i < parsed.blocks.length; i++) {
    if (parsed.blocks[i].week === week) return parsed.blocks[i];
  }
  return null;
}

/** Exact match after trim (case-sensitive first, then a forgiving fallback). */
function findExerciseRow_(block, name) {
  var target = String(name).trim();
  for (var i = 0; i < block.rows.length; i++) {
    if (block.rows[i].exercise === target) return block.rows[i];
  }
  var loose = normalize_(target);
  for (var j = 0; j < block.rows.length; j++) {
    if (normalize_(block.rows[j].exercise) === loose) return block.rows[j];
  }
  return null;
}

function mergeAnchor_(sheet, row, col) {
  var cell = sheet.getRange(row, col);
  if (!cell.isPartOfMerge()) return { row: row, col: col };
  var merged = cell.getMergedRanges();
  if (!merged.length) return { row: row, col: col };
  return { row: merged[0].getRow(), col: merged[0].getColumn() };
}

// ===========================================================================
// REQUEST PLUMBING
// ===========================================================================

/**
 * Every failure comes back as {ok:false, code, error}. `code` is the contract
 * the client classifies on (see the file header); the message is for humans and
 * must never be pattern-matched. Anything that isn't a deliberate UserError_ is
 * an unexpected exception -> "internal".
 */
function respond_(fn) {
  var payload;
  try {
    payload = fn();
  } catch (err) {
    payload = {
      ok: false,
      code: (err && err.name === 'UserError' && err.code) ? err.code : 'internal',
      error: (err && err.message) ? err.message : String(err)
    };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) {
    // Fallback for form-encoded posts.
    if (e && e.parameter && (e.parameter.action || e.parameter.token)) return e.parameter;
    throw new UserError_('Empty request body — POST a JSON object as the raw body.', 'validation');
  }
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new UserError_('Request body is not valid JSON.', 'validation');
  }
}

function requireToken_(supplied) {
  var expected = PropertiesService.getScriptProperties().getProperty(CONFIG.TOKEN_PROPERTY);
  if (!expected) {
    // "config", NOT "auth": the server is unconfigured, the device's token is
    // fine. Sending "auth" here would make the client throw up its token gate
    // and have the user re-enter a token that was never the problem.
    throw new UserError_(
      'Server not configured: Script Property "' + CONFIG.TOKEN_PROPERTY + '" is not set.', 'config');
  }
  if (!constantTimeEquals_(String(supplied || ''), String(expected))) {
    throw new UserError_('Unauthorized.', 'auth');
  }
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The error codes the client is allowed to see. */
var ERROR_CODES = ['auth', 'config', 'validation', 'lock', 'internal'];

/**
 * Errors whose message is safe to hand back to the client.
 * `code` must be one of ERROR_CODES; it defaults to "validation" (a bad
 * request) because that is the common case and the safest default — the client
 * only ever discards a queued write on "validation", never on the others.
 */
function UserError_(message, code) {
  var err = new Error(message);
  err.name = 'UserError';
  err.code = ERROR_CODES.indexOf(code) !== -1 ? code : 'validation';
  return err;
}

// ===========================================================================
// SMALL HELPERS
// ===========================================================================

function isBlank_(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function blankToNull_(v) {
  return isBlank_(v) ? null : String(v).trim();
}

/** Numbers, numeric strings ("95", " 12.5 ", "1,000") -> Number. Else null. */
function toNumber_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  var s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function normalize_(v) {
  return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Sheet value (Date or string) -> "YYYY-MM-DD" in the sheet's timezone, or null. */
function toIsoDate_(v) {
  if (isBlank_(v)) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, timeZone_(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, timeZone_(), 'yyyy-MM-dd');
  return null;
}

/**
 * "YYYY-MM-DD" -> a real Date that renders as that calendar day in the sheet.
 *
 * Anchored at midday in the SPREADSHEET timezone, deliberately:
 *   - the spreadsheet timezone is the one that decides which day the stored
 *     instant displays as, so building the instant there is exact;
 *   - midday rather than midnight means even a leftover offset (a DST edge, or
 *     a viewer in another timezone) can't roll the date to the previous day.
 */
function parseIsoDate_(s) {
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new UserError_('Invalid "date" — expected YYYY-MM-DD, got "' + s + '".', 'validation');
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  var probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    throw new UserError_('Invalid calendar date "' + s + '".', 'validation');
  }
  return Utilities.parseDate(m[1] + '-' + m[2] + '-' + m[3] + ' 12:00:00', timeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

function colLetter_(col) {
  var s = '';
  while (col > 0) {
    var r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}
