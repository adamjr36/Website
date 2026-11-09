/**
 * ExtendProgram.gs — one-off maintenance: add more week blocks to Push / Pull / Legs.
 * ---------------------------------------------------------------------------
 * The app has no week cap of its own: `totalWeeks` is simply the number of week
 * blocks on each day tab. To extend the program, append blocks to the sheet.
 *
 * Paste this file into the SAME Apps Script project as Code.gs (it reuses
 * resolveDayTabs_, findHeaderRow_, toNumber_, normalize_). Running it from the
 * editor does NOT require redeploying the web app.
 *
 *   1. Run `previewExtension`  -> writes nothing; logs exactly what would change.
 *   2. Run `extendProgram`     -> makes a full backup copy of the spreadsheet
 *                                 FIRST, then appends the new blocks.
 *
 * Data-safety rules:
 *   - Existing rows are never written: new blocks go strictly BELOW the last row.
 *     The only existing cells touched are (a) formulas on non-day tabs whose
 *     ranges end exactly at a day tab's old last row (e.g. PRs: Push!E5:E64 ->
 *     Push!E5:E124), so new weeks count, and (b) the Program tab's
 *     "12 weeks" subtitle text.
 *   - Idempotent: a tab already at or past TARGET_WEEKS is skipped, so running
 *     it twice never adds 24 weeks.
 *   - Aborts before writing anything if any tab's layout looks irregular.
 */

var EXTEND = {
  TARGET_WEEKS: 24
};

function previewExtension() { return runExtension_(false); }
function extendProgram()    { return runExtension_(true); }

function runExtension_(apply) {
  var ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Sheet is busy (script lock) — try again in a minute.');
  try {
    var tabs = resolveDayTabs_(ss);
    var plans = CONFIG.DAY_KEYS.map(function (key) { return planTab_(key, tabs[key]); });

    plans.forEach(function (p) { Logger.log(p.summary); });
    var work = plans.filter(function (p) { return p.addWeeks > 0; });
    if (!work.length) { Logger.log('Nothing to do — every tab already has ' + EXTEND.TARGET_WEEKS + '+ weeks.'); return; }

    var formulaEdits = planFormulaEdits_(ss, tabs, work);
    formulaEdits.forEach(function (e) {
      Logger.log('Formula ' + e.sheet + '!' + e.a1 + ':\n    ' + e.before + '\n -> ' + e.after);
    });
    var programEdit = planProgramText_(ss);
    if (programEdit) Logger.log('Program text ' + programEdit.a1 + ': "' + programEdit.before + '" -> "' + programEdit.after + '"');

    if (!apply) { Logger.log('PREVIEW ONLY — nothing was written. Run extendProgram to apply.'); return; }

    // Backup BEFORE any write.
    var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HHmm');
    var backup = ss.copy(ss.getName() + ' — backup before extension ' + stamp);
    Logger.log('Backup created: ' + backup.getName() + '  ' + backup.getUrl());

    work.forEach(function (p) { appendBlocks_(p); });
    formulaEdits.forEach(function (e) { ss.getSheetByName(e.sheet).getRange(e.a1).setFormula(e.after); });
    if (programEdit) ss.getSheetByName(programEdit.sheet).getRange(programEdit.a1).setValue(programEdit.after);
    SpreadsheetApp.flush();

    // Verify with the app's own parser: weeks must be 1..N, contiguous, old data untouched.
    work.forEach(function (p) { verifyTab_(p); });
    Logger.log('DONE. Backup: ' + backup.getUrl());
  } finally {
    lock.releaseLock();
  }
}

/** Work out the last block's position/height and how many weeks to add. Throws on irregular layout. */
function planTab_(key, sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 11);
  var vals = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headerRow = findHeaderRow_(vals);

  var tops = [];  // {row, week}
  for (var r = headerRow + 1; r <= lastRow; r++) {
    var w = toNumber_(vals[r - 1][0]);
    if (w !== null) tops.push({ row: r, week: w });
  }
  if (tops.length < 2) throw new Error(key + ': need at least 2 week blocks to infer the layout; found ' + tops.length + '.');

  tops.forEach(function (t, i) {
    if (t.week !== i + 1) throw new Error(key + ': week numbers are not 1..N in order (row ' + t.row + ' has week ' + t.week + '). Fix the sheet first.');
  });

  var height = tops[1].row - tops[0].row;
  for (var i = 1; i < tops.length; i++) {
    if (tops[i].row - tops[i - 1].row !== height) throw new Error(key + ': week blocks are not all ' + height + ' rows tall (week ' + tops[i].week + ').');
  }
  var last = tops[tops.length - 1];
  if (lastRow - last.row + 1 !== height) {
    throw new Error(key + ': last block (week ' + last.week + ') spans ' + (lastRow - last.row + 1) + ' rows, expected ' + height + '. Something sits below the last week — aborting.');
  }

  // Template notes per row position = most common note at that position across all blocks
  // (the pre-filled reference notes; personal one-off notes lose the vote).
  var notesCol = findCol_(vals[headerRow - 1], 'notes', key);
  var templateNotes = [];
  for (var k = 0; k < height; k++) {
    var counts = {};
    tops.forEach(function (t) {
      var n = String(vals[t.row - 1 + k][notesCol - 1] || '').trim();
      if (n) counts[n] = (counts[n] || 0) + 1;
    });
    var best = '', bestN = 0;
    Object.keys(counts).forEach(function (n) { if (counts[n] > bestN) { best = n; bestN = counts[n]; } });
    templateNotes.push(bestN >= 2 ? best : '');
  }

  var addWeeks = Math.max(0, EXTEND.TARGET_WEEKS - last.week);
  return {
    key: key,
    sheet: sheet,
    lastCol: lastCol,
    header: vals[headerRow - 1],
    height: height,
    lastTop: last.row,
    lastWeek: last.week,
    oldLastRow: lastRow,
    newLastRow: lastRow + addWeeks * height,
    addWeeks: addWeeks,
    templateNotes: templateNotes,
    // Snapshot of every existing value, to prove nothing changed afterwards.
    beforeVals: vals,
    summary: key + ' (tab "' + sheet.getName() + '"): weeks 1-' + last.week + ', ' + height + ' rows/week, rows ' +
             tops[0].row + '-' + lastRow + (addWeeks ? ' -> add weeks ' + (last.week + 1) + '-' + (last.week + addWeeks) +
             ' (rows ' + (lastRow + 1) + '-' + (lastRow + addWeeks * height) + ')' : ' -> already at target, skip')
  };
}

function findCol_(headerRow, label, key) {
  for (var c = 0; c < headerRow.length; c++) if (normalize_(headerRow[c]) === label) return c + 1;
  throw new Error(key + ': no "' + label + '" column in header.');
}

/** Copy the last block's structure (formats, merges, validation, formulas) N times below, then blank the inputs. */
function appendBlocks_(p) {
  var sh = p.sheet, h = p.height;
  sh.insertRowsAfter(p.oldLastRow, p.addWeeks * h);

  var col = function (label) { return findCol_(p.header, label, p.key); };
  var cWeek = col('week'), cDate = col('date'), cNotes = col('notes');
  var inputCols = ['s1wt', 's1reps', 's2wt', 's2reps'].map(col);

  for (var i = 0; i < p.addWeeks; i++) {
    var srcTop = p.oldLastRow - h + 1 + i * h;   // previous block (old week N, then each new one)
    var dstTop = srcTop + h;
    // Copy from the previous block so relative formulas (vs last wk) point at the week before.
    sh.getRange(srcTop, 1, h, p.lastCol).copyTo(sh.getRange(dstTop, 1, h, p.lastCol), SpreadsheetApp.CopyPasteType.PASTE_NORMAL, false);

    var dateRange = sh.getRange(dstTop, cDate, h, 1);
    var weekRange = sh.getRange(dstTop, cWeek, h, 1);
    if (!weekRange.isPartOfMerge()) weekRange.mergeVertically();
    if (!dateRange.isPartOfMerge()) dateRange.mergeVertically();

    sh.getRange(dstTop, cWeek).setValue(p.lastWeek + i + 1);
    dateRange.clearContent();
    inputCols.forEach(function (c) { sh.getRange(dstTop, c, h, 1).clearContent(); });
    sh.getRange(dstTop, cNotes, h, 1).setValues(p.templateNotes.map(function (n) { return [n]; }));
  }
}

/**
 * Formulas on NON-day tabs whose range refs to a day tab end exactly at that tab's old
 * last row get their end row bumped to the new last row. Whole-column refs (Push!E:E) are
 * already fine and untouched. Day tabs' own formulas are left alone.
 */
function planFormulaEdits_(ss, tabs, work) {
  var dayNames = {};
  CONFIG.DAY_KEYS.forEach(function (k) { dayNames[tabs[k].getName()] = true; });
  var edits = [];

  ss.getSheets().forEach(function (sh) {
    if (dayNames[sh.getName()]) return;
    var lr = sh.getLastRow(), lc = sh.getLastColumn();
    if (!lr || !lc) return;
    var formulas = sh.getRange(1, 1, lr, lc).getFormulas();
    for (var r = 0; r < lr; r++) for (var c = 0; c < lc; c++) {
      var f = formulas[r][c];
      if (!f) continue;
      var g = f;
      work.forEach(function (p) {
        var name = p.sheet.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Push!E5:E64  'Push'!$E$5:$E$64  — end row must equal the old last row exactly.
        var re = new RegExp("((?:'" + name + "'|" + name + ")!\\$?[A-Z]+\\$?\\d+:\\$?[A-Z]+\\$?)" + p.oldLastRow + "(?!\\d)", 'g');
        g = g.replace(re, '$1' + p.newLastRow);
      });
      if (g !== f) edits.push({ sheet: sh.getName(), a1: sh.getRange(r + 1, c + 1).getA1Notation(), before: f, after: g });
    }
  });
  return edits;
}

function planProgramText_(ss) {
  var sh = ss.getSheets().filter(function (s) { return normalize_(s.getName()) === 'program'; })[0];
  if (!sh) return null;
  var vals = sh.getRange(1, 1, Math.min(sh.getLastRow(), 10), Math.max(sh.getLastColumn(), 1)).getValues();
  for (var r = 0; r < vals.length; r++) for (var c = 0; c < vals[r].length; c++) {
    var v = String(vals[r][c]);
    if (/^\s*12 weeks\b/.test(v)) {
      return { sheet: sh.getName(), a1: sh.getRange(r + 1, c + 1).getA1Notation(), before: v,
               after: v.replace(/^(\s*)12 weeks/, '$1' + EXTEND.TARGET_WEEKS + ' weeks') };
    }
  }
  return null;
}

/** Re-read the tab: old rows must be byte-identical, and the app's parser must see weeks 1..target. */
function verifyTab_(p) {
  var sh = p.sheet;
  var now = sh.getRange(1, 1, p.oldLastRow, p.lastCol).getValues();
  for (var r = 0; r < p.oldLastRow; r++) for (var c = 0; c < p.lastCol; c++) {
    var a = p.beforeVals[r][c], b = now[r][c];
    var same = (a instanceof Date && b instanceof Date) ? a.getTime() === b.getTime() : a === b;
    if (!same) throw new Error('VERIFY FAILED: ' + p.key + ' existing cell ' + sh.getRange(r + 1, c + 1).getA1Notation() +
                               ' changed (' + a + ' -> ' + b + '). Restore from the backup copy.');
  }
  var parsed = parseTab_(sh);
  var weeks = parsed.blocks.map(function (b) { return b.week; });
  for (var i = 0; i < weeks.length; i++) {
    if (weeks[i] !== i + 1) throw new Error('VERIFY FAILED: ' + p.key + ' weeks now read ' + weeks.join(',') + '. Restore from the backup copy.');
  }
  Logger.log('Verified ' + p.key + ': old data unchanged; app now sees ' + weeks.length + ' weeks.');
}
