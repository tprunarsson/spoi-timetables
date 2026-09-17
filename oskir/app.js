/* Teacher preferences - a static page against one Apps Script endpoint.
 *
 * Deliberately a mirror of Spoi's own TeacherRequest.html: weeks are
 * toggle buttons, and a slot cycles neutral -> "hentar ekki" -> "hentar
 * vel" -> neutral. A teacher who has used one should not have to learn
 * the other. Rooms use the same cycle, which is the whole reason this
 * exists outside Google Forms: Forms cannot vary a question's options by
 * a previous answer, so it could never show a course its own rooms.
 *
 * No build step and no dependencies - GitHub Pages serves these three
 * files as they are.
 */
'use strict';

const CONFIG = {
  // Apps Script web app, deployed "Execute as: Me" / "Anyone".
  apiUrl: 'https://script.google.com/macros/s/AKfycbzgHtN6imSwNb9QPJBMKMC7IonETyfbCZ3vAyGTyfBg3DiqW5Ls5Ocm4zsRT-WN1hW9/exec',

  schools: [
    { value: 'von', label: 'VoN - Verkfræði- og náttúruvísindasvið' },
    { value: 'fvs', label: 'FVS - Félagsvísindasvið' },
    { value: 'hug', label: 'HUG - Hugvísindasvið' },
    { value: 'mvs', label: 'MVS - Menntavísindasvið' },
    { value: 'hvs', label: 'HVS - Heilbrigðisvísindasvið' }
  ],

  // ISO weeks, per semester. The selected term picks the range, and
  // ?weeks=2-16 still overrides both.
  // ISO rather than teaching weeks 1-14 on purpose: programmes start in
  // different weeks, so "week 3" means a different date per programme
  // while week 34 is the same Monday for everyone. The cost is that the
  // number is unfamiliar, which is why every button carries its date.
  weeks: { from: 34, to: 47 },
  weeksBySemester: { H: { from: 34, to: 47 }, V: { from: 2, to: 16 }, S: { from: 22, to: 30 } },
  // The year comes from the selected term where there is one, and is
  // guessed from the week range otherwise - see resolveYear.

  // Slot 0 starts 08:20 and each slot is 50 minutes - the same constants
  // Spoi uses (SLOT_ZERO_START_MINUTES / SLOT_STEP_MINUTES, Code.js), so
  // the tokens produced here ("mán-0") are the ones Spoi already speaks.
  slotZeroStartMinutes: 8 * 60 + 20,
  slotStepMinutes: 50,
  firstSlot: 0,
  lastSlot: 8,

  days: [
    { token: 'mán', label: 'Mán' },
    { token: 'þri', label: 'Þri' },
    { token: 'mið', label: 'Mið' },
    { token: 'fim', label: 'Fim' },
    { token: 'fös', label: 'Fös' }
  ],

  // A teacher may name at most this many favourites. Ranking ten rooms
  // "best" is not a ranking, so this stays capped even though a green
  // room counts as open below.
  maxPreferPicks: 3,

  // How many slots a teacher may block. Unbounded, this is the one answer
  // that can genuinely make a course unplaceable - every blocked slot is
  // one the solver may not use, and a teacher blocking half the week has
  // written a timetable rather than a preference.
  maxAvoidSlots: 5,

  // The real rule. Vetoing is unlimited as long as this many rooms are
  // left usable - green or blank both count. A course reduced to one
  // option is not a preference, it is a booking, and it leaves Besta
  // nothing to solve with. If the offered list is shorter than this, the
  // teacher has to search for more rather than being let off the floor:
  // a small list is exactly when the alternatives matter most.
  minOpenRooms: 5
};

// course_id -> its catalog rows, filled by the one GET below.
const catalog = new Map();
// room_id -> room row, every room in the school. The catalog GET already
// returns every row, so searching outside a course's own list costs no
// extra request - only a second index over data already in memory.
const allRooms = new Map();
// Rooms the teacher searched for and added, which are NOT on this
// course's own list. Kept apart so they can be shown as such: the prefill
// did not propose them, and that is worth seeing.
const extraRooms = new Set();

// Every catalog row the school returned, across all its terms, kept so
// that switching term re-filters in memory instead of re-fetching.
let catalogRows = [];

const state = {
  weeks: new Set(),
  // "mán-0" -> 'prefer' | 'avoid'
  slots: new Map(),
  // room_id -> 'prefer' | 'avoid'
  rooms: new Map(),
  // { year, semester } - which term these wishes are FOR. A school can
  // be planning two at once (VON: haust 2026 running, vor 2027 being
  // built), and a wish that does not name its term gets imported into
  // both, describing courses the other term does not teach. Null until
  // the catalog has been read, since the catalog is what says which
  // terms exist.
  term: null
};

const el = (id) => document.getElementById(id);

// "V", "v", "vor" all name one semester; the query string is typed by a
// person and the sheet is filled in by another, so neither is guaranteed
// to be the bare letter this compares on.
const semesterLetter = (value) => {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  return text ? text.charAt(0) : '';
};

/* What a term is CALLED, as a teacher would say it.
 *
 * Fall-anchored again: year 2026 semester V is "Vor 2027". Labelling it
 * "Vor 2026" would name a term that ended months ago, and a teacher
 * checking they are answering for the right one would see the wrong
 * answer at the very moment they were trying to verify it.
 */
function termLabel(term) {
  if (!term || !term.year) return '';
  const year = Number(term.year);
  const names = { H: 'Haust', V: 'Vor', S: 'Sumar' };
  const name = names[term.semester] || term.semester;
  return name + ' ' + (term.semester === 'H' ? year : year + 1);
}

const sameTerm = (a, b) =>
  !!a && !!b && String(a.year) === String(b.year) && a.semester === b.semester;

// ?year=2026&semester=V, the way ?school= already works: the link an
// administrator sends decides, so the teacher does not have to.
function termFromQuery() {
  const params = new URLSearchParams(location.search);
  const year = String(params.get('year') || '').trim();
  const semester = semesterLetter(params.get('semester'));
  return year && semester ? { year: year, semester: semester } : null;
}

// The terms the catalog holds, newest first - haust before vor WITHIN a
// year, because the year is fall-anchored.
function termsInRows(rows) {
  const rank = { H: 0, V: 1, S: 2 };
  const seen = new Map();
  rows.forEach((row) => {
    const year = String(row.year || '').trim();
    const semester = semesterLetter(row.semester);
    if (!year || !semester) return;
    const key = year + semester;
    if (!seen.has(key)) seen.set(key, { year: year, semester: semester });
  });
  return Array.from(seen.values()).sort((a, b) =>
    (Number(b.year) - Number(a.year))
    || ((rank[b.semester] ?? 9) - (rank[a.semester] ?? 9)));
}

/* ---------- helpers ---------------------------------------------- */

function slotLabel(slot) {
  const total = CONFIG.slotZeroStartMinutes + slot * CONFIG.slotStepMinutes;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return hh + ':' + mm;
}

function weekRangeFromQuery() {
  const raw = new URLSearchParams(location.search).get('weeks');
  const match = raw && raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (match) return { from: Number(match[1]), to: Number(match[2]) };
  // Otherwise the semester decides: autumn and spring do not share weeks,
  // and offering a spring course weeks 34-47 asks about dates its term
  // does not contain.
  const semester = state.term && state.term.semester;
  return (semester && CONFIG.weeksBySemester[semester]) || CONFIG.weeks;
}

/* Which year's weeks these are.
 *
 * "This year" is wrong half the time: wishes are collected months before
 * the term they describe, so spring weeks 2-16 gathered in autumn belong
 * to NEXT year, and showing this year's dates would be a year out - the
 * exact mistake the dates were added to prevent.
 *
 * So the range picks its own year: whichever one it has not finished in
 * yet. Autumn 34-47 read in September resolves to this year (week 47 is
 * still ahead); read in December it rolls to next year, because this
 * year's term is over and the only wishes anyone can still submit are for
 * the next one. Spring 2-16 read at any point after April rolls the same
 * way. Nothing to update annually, and nothing to forget.
 */
function resolveYear(range, today) {
  const now = today || new Date();
  const thisYear = now.getUTCFullYear();
  // End of the range's last week, not its Monday: a term in progress must
  // not jump forward while it is still running.
  const endOfRange = mondayOfIsoWeek(thisYear, range.to).getTime() + 7 * 86400000;
  return endOfRange < now.getTime() ? thisYear + 1 : thisYear;
}

/* The calendar year the week buttons should show dates from.
 *
 * A known term answers this outright, and answers it correctly: Spoi
 * counts academic years fall-anchored, so vor 2027 is year 2026 semester
 * V, and the calendar year its weeks fall in is one MORE than the year
 * the term is filed under. Getting that backwards would date every spring
 * button a year early - the exact error the dates were added to prevent.
 *
 * resolveYear's guess stays as the fallback, for a catalog written before
 * it carried terms at all.
 */
function calendarYearForWeeks() {
  const term = state.term;
  if (term && term.year) {
    const year = Number(term.year);
    if (year >= 2000 && year <= 2100) return term.semester === 'H' ? year : year + 1;
  }
  return resolveYear(weekRangeFromQuery());
}

// Monday of an ISO week. ISO week 1 is the one containing 4 January, so
// that date is the anchor everything else counts from.
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // getUTCDay() is 0 for Sunday; ISO counts Monday as day 1.
  const isoDay = jan4.getUTCDay() || 7;
  const mondayOfWeek1 = Date.UTC(year, 0, 4 - (isoDay - 1));
  return new Date(mondayOfWeek1 + (week - 1) * 7 * 86400000);
}

const MONTHS_IS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí',
                   'ágúst', 'september', 'október', 'nóvember', 'desember'];

function shortDate(date) {
  return date.getUTCDate() + '.' + (date.getUTCMonth() + 1) + '.';
}

function longDate(date) {
  return date.getUTCDate() + '. ' + MONTHS_IS[date.getUTCMonth()];
}

function setStatus(message, kind) {
  const node = el('status');
  node.textContent = message || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}

// Cycles neutral -> prefer -> avoid -> neutral. The positive answer comes
// first because a click is read as "I want this": landing on "hentar
// ekki" from one tap on a room you just went and searched for reverses
// what you asked for, and a teacher correcting that has to click twice
// more to escape.
//
// A refused step CLEARS the mark rather than doing nothing, and returns
// false so the caller can say why. Doing nothing would strand the button:
// a room stuck on "hentar vel" whose next step is capped would retry that
// same capped step on every further click and could never be reset. Every
// click must move, or the cycle is a trap.
function cycle(map, key, capPrefer, capAvoid) {
  const current = map.get(key);
  if (!current) {
    if (capPrefer != null && countOf(map, 'prefer') >= capPrefer) return false;
    map.set(key, 'prefer');
  } else if (current === 'prefer') {
    if (capAvoid != null && countOf(map, 'avoid') >= capAvoid) {
      map.delete(key);
      return false;
    }
    map.set(key, 'avoid');
  } else {
    map.delete(key);
  }
  return true;
}

function countOf(map, value) {
  let n = 0;
  map.forEach((v) => { if (v === value) n++; });
  return n;
}

function keysWith(map, value) {
  const out = [];
  map.forEach((v, k) => { if (v === value) out.push(k); });
  return out;
}

/* ---------- rendering -------------------------------------------- */

function renderSchools() {
  const select = el('school');
  select.innerHTML = '';
  CONFIG.schools.forEach((school) => {
    const option = document.createElement('option');
    option.value = school.value;
    option.textContent = school.label;
    select.appendChild(option);
  });
  const preset = new URLSearchParams(location.search).get('school');
  if (preset) select.value = preset;
}

function renderWeeks() {
  const range = weekRangeFromQuery();
  const year = calendarYearForWeeks();
  const target = el('weekGrid');
  target.innerHTML = '';
  for (let week = range.from; week <= range.to; week++) {
    const monday = mondayOfIsoWeek(year, week);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-btn' + (state.weeks.has(week) ? ' selected' : '');

    // Number and date together. A teacher counts teaching weeks 1-14, so
    // a bare "34" invites reading it as the 34th week of teaching; the
    // Monday underneath is what makes it unambiguous without a paragraph
    // of explanation.
    const number = document.createElement('span');
    number.className = 'week-no';
    number.textContent = week;
    const date = document.createElement('span');
    date.className = 'week-date';
    date.textContent = shortDate(monday);
    button.append(number, date);
    button.title = 'Vika ' + week + ' hefst mánudaginn ' + longDate(monday);

    button.onclick = () => {
      if (state.weeks.has(week)) state.weeks.delete(week);
      else state.weeks.add(week);
      renderWeeks();
      renderSummary();
    };
    target.appendChild(button);
  }

  el('weekAnchor').textContent =
    'Almanaksvikur (ekki kennsluvikur). Vika ' + range.from + ' hefst mánudaginn '
    + longDate(mondayOfIsoWeek(year, range.from)) + '.';
}

function renderSlots() {
  const target = el('slotGrid');
  target.innerHTML = '';

  target.appendChild(document.createElement('div')); // empty corner
  CONFIG.days.forEach((day) => {
    const head = document.createElement('div');
    head.className = 'slot-head';
    head.textContent = day.label;
    target.appendChild(head);
  });

  for (let slot = CONFIG.firstSlot; slot <= CONFIG.lastSlot; slot++) {
    const time = document.createElement('div');
    time.className = 'slot-time';
    time.textContent = slotLabel(slot);
    target.appendChild(time);

    CONFIG.days.forEach((day) => {
      const token = day.token + '-' + slot;
      const value = state.slots.get(token);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot-btn'
        + (value === 'prefer' ? ' preferred' : '')
        + (value === 'avoid' ? ' blocked' : '');
      button.textContent = value === 'prefer' ? 'Hentar' : (value === 'avoid' ? 'Ekki' : '');
      button.title = day.label + ' ' + slotLabel(slot);
      button.onclick = () => {
        const ok = cycle(state.slots, token, null, CONFIG.maxAvoidSlots);
        setStatus(ok ? '' : 'Í mesta lagi ' + CONFIG.maxAvoidSlots
          + ' tímar mega vera merktir "hentar ekki".', ok ? '' : 'err');
        renderSlots();
        renderSummary();
      };
      target.appendChild(button);
    });
  }
}

// Folded so a teacher can type on any keyboard: "idn" finds IÐN508M and
// "arnagardur" finds Árnagarður. Matches the folding normalize_room_key
// does on the Python side - letters are folded, never dropped, or "Oddi"
// and "Óðinn" would collapse onto each other.
const FOLD = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ý: 'y',
               ð: 'd', þ: 'th', æ: 'ae', ö: 'o' };

function fold(value) {
  return String(value == null ? '' : value).toLowerCase()
    .replace(/[áéíóúýðþæö]/g, (ch) => FOLD[ch]);
}

// --- course combobox --------------------------------------------------
// A <select> of 196 courses is a scroll, not a choice. The select is
// still the value; this only makes it findable by typing.
const COURSE_RESULT_LIMIT = 12;
let courseMatches = [];
let courseCursor = -1;

function courseLabel(courseId) {
  const first = (catalog.get(courseId) || [])[0] || {};
  return courseId + (first.course_name ? ' — ' + first.course_name : '');
}

function renderCourseResults(open) {
  const box = el('courseSearch');
  const list = el('courseResults');
  const query = fold(box.value.trim());
  list.innerHTML = '';

  // A query that exactly matches the chosen course means the teacher is
  // looking at their own selection, not searching - so stay closed.
  const selected = el('course').value;
  if (open === false || (selected && box.value === courseLabel(selected))) {
    courseMatches = [];
    courseCursor = -1;
    list.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    return;
  }

  courseMatches = Array.from(catalog.keys())
    .filter((courseId) => !query || fold(courseLabel(courseId)).indexOf(query) >= 0)
    .sort()
    .slice(0, COURSE_RESULT_LIMIT);
  courseCursor = -1;

  if (courseMatches.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'combo-empty';
    empty.textContent = catalog.size
      ? 'Ekkert námskeið fannst.'
      : 'Engin námskeið skráð fyrir þetta svið enn.';
    list.appendChild(empty);
  } else {
    courseMatches.forEach((courseId, index) => {
      const item = document.createElement('li');
      item.className = 'combo-item';
      item.setAttribute('role', 'option');
      item.textContent = courseLabel(courseId);
      // mousedown, not click: blur would close the list first.
      item.onmousedown = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        pickCourse(courseId);
      };
      item.onclick = () => pickCourse(courseId);
      item.dataset.index = String(index);
      list.appendChild(item);
    });
  }
  list.hidden = false;
  box.setAttribute('aria-expanded', 'true');
}

function highlightCourse(next) {
  if (courseMatches.length === 0) return;
  const items = Array.from(el('courseResults').children);
  courseCursor = (next + courseMatches.length) % courseMatches.length;
  items.forEach((item, index) => {
    item.className = 'combo-item' + (index === courseCursor ? ' active' : '');
  });
}

function onCourseKeydown(event) {
  const key = event && event.key;
  if (key === 'ArrowDown') { highlightCourse(courseCursor + 1); event.preventDefault(); }
  else if (key === 'ArrowUp') { highlightCourse(courseCursor - 1); event.preventDefault(); }
  else if (key === 'Enter') {
    // With nothing highlighted, a single match is unambiguous - Enter
    // takes it rather than making the teacher arrow down to it first.
    const pick = courseCursor >= 0 ? courseMatches[courseCursor]
      : (courseMatches.length === 1 ? courseMatches[0] : null);
    if (pick) { pickCourse(pick); event.preventDefault(); }
  } else if (key === 'Escape') {
    renderCourseResults(false);
  }
}

function pickCourse(courseId) {
  el('course').value = courseId;
  el('courseSearch').value = courseLabel(courseId);
  renderCourseResults(false);
  onCourseChange();
}

function onCourseChange() {
  state.rooms.clear();
  // Extras belong to the course they were chosen for.
  extraRooms.clear();
  el('roomSearch').value = '';
  showStepsForCourse();
}

// Every room this course may be given: the prefill's own list plus
// anything the teacher searched for and added.
function courseRoomRows() {
  const rows = (catalog.get(el('course').value) || []).slice();
  const seen = new Set(rows.map((row) => String(row.room_id || '').trim()));
  extraRooms.forEach((roomId) => {
    if (!seen.has(roomId) && allRooms.has(roomId)) rows.push(allRooms.get(roomId));
  });
  return rows;
}

function roomButton(row, isExtra) {
  const roomId = String(row.room_id || '').trim();
  const value = state.rooms.get(roomId);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'room-btn'
    + (value === 'prefer' ? ' preferred' : '')
    + (value === 'avoid' ? ' blocked' : '');

  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = row.room_name || roomId;

  const meta = document.createElement('span');
  meta.className = 'room-meta';
  const bits = [row.building, row.capacity ? row.capacity + ' sæti' : ''].filter(Boolean);
  meta.textContent = bits.join(' · ')
    + (isExtra ? ' · utan lista' : '')
    + (value === 'prefer' ? ' — hentar vel' : (value === 'avoid' ? ' — hentar ekki' : ''));

  button.append(name, meta);
  button.onclick = () => {
    // Vetoing is the second click now, so the floor bites there rather
    // than on first touch. Refused at the click rather than at submit: a
    // teacher who has to undo six vetoes at the end has been let down by
    // the form.
    const current = state.rooms.get(roomId);
    if (current === 'prefer' && openRoomCount() <= CONFIG.minOpenRooms) {
      // Cleared rather than left as-is, so the click still moves - see
      // cycle() on why a stationary click is a trap.
      state.rooms.delete(roomId);
      setStatus('Minnst ' + CONFIG.minOpenRooms + ' stofur verða að standa eftir. '
        + 'Leitaðu að fleiri stofum ef þessar henta ekki.', 'err');
      renderRooms();
      renderRoomSearch();
      renderSummary();
      return;
    }
    const changed = cycle(state.rooms, roomId, CONFIG.maxPreferPicks, null);
    if (!changed) {
      setStatus('Í mesta lagi ' + CONFIG.maxPreferPicks + ' stofur merktar "hentar vel".', 'err');
      return;
    }
    setStatus('');
    if (isExtra) extraRooms.add(roomId);
    renderRooms();
    renderRoomSearch();
    renderSummary();
  };
  return button;
}

// Rooms still usable for this course: everything on the list that the
// teacher has not vetoed. Green and blank both count - marking a room
// "hentar vel" does not remove it as an option.
function openRoomCount() {
  const rows = courseRoomRows();
  let open = 0;
  rows.forEach((row) => {
    const roomId = String(row.room_id || '').trim();
    if (roomId && state.rooms.get(roomId) !== 'avoid') open++;
  });
  return open;
}

function renderRooms() {
  const target = el('roomList');
  const rows = courseRoomRows();
  target.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Engar stofur skráðar fyrir þetta námskeið enn.';
    target.appendChild(empty);
    el('roomCount').textContent = '';
    return;
  }

  // A room the teacher searched in is marked as such, so the list never
  // implies the prefill proposed it.
  const courseRoomIds = new Set(
    (catalog.get(el('course').value) || []).map((row) => String(row.room_id || '').trim())
  );
  rows.forEach((row) => {
    const roomId = String(row.room_id || '').trim();
    if (!roomId) return;
    target.appendChild(roomButton(row, !courseRoomIds.has(roomId)));
  });

  const open = openRoomCount();
  const short = CONFIG.minOpenRooms - open;
  const node = el('roomCount');
  node.className = 'hint' + (short > 0 ? ' hint-warn' : '');
  node.textContent = short > 0
    ? 'Aðeins ' + open + ' stofur standa eftir. Leitaðu að ' + short + ' til viðbótar.'
    : open + ' stofur standa eftir ('
      + countOf(state.rooms, 'prefer') + ' henta vel, '
      + countOf(state.rooms, 'avoid') + ' henta ekki).';
}

// Rooms anywhere in the school matching the query, minus the ones this
// course already offers. Capped: a bare "V" would otherwise render every
// room in VR-I, II and III at once, and a list that long is not a search
// result, it is the catalogue again.
function renderRoomSearch() {
  const target = el('roomSearchResults');
  const query = fold(el('roomSearch').value.trim());
  target.innerHTML = '';
  if (query.length < 2) return;

  const shown = new Set(courseRoomRows().map((row) => String(row.room_id || '').trim()));
  const matches = [];
  let alreadyListed = 0;
  allRooms.forEach((row, roomId) => {
    const haystack = fold((row.room_name || '') + ' ' + (row.building || ''));
    if (haystack.indexOf(query) < 0) return;
    if (shown.has(roomId)) { alreadyListed++; return; }
    if (matches.length < 24) matches.push(row);
  });

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    // "Engin stofa fannst" would be a lie the moment a teacher searches
    // for a room that is already above - which is exactly what happens
    // right after adding one, since the query is still in the box.
    empty.textContent = alreadyListed
      ? 'Sú stofa er þegar á listanum að ofan.'
      : 'Engin stofa fannst.';
    target.appendChild(empty);
    return;
  }
  matches.forEach((row) => target.appendChild(roomButton(row, true)));
}

// The copy states both numbers; reading them from CONFIG means changing
// a cap cannot leave the page telling teachers the old one.
function renderRoomLimits() {
  const cap = el('roomCap');
  if (cap) cap.textContent = CONFIG.maxPreferPicks;
  const floor = el('roomFloor');
  if (floor) floor.textContent = CONFIG.minOpenRooms;
  const slotCap = el('slotCap');
  if (slotCap) slotCap.textContent = CONFIG.maxAvoidSlots;
}

function showStepsForCourse() {
  const chosen = !!el('course').value;
  ['weeksCard', 'timesCard', 'roomsCard', 'noteCard', 'summaryCard', 'submitCard']
    .forEach((id) => { el(id).hidden = !chosen; });
  if (chosen) { renderRooms(); renderRoomSearch(); renderSummary(); }
}

// What the page will actually send, in words, immediately above the
// button. A tri-state button says nothing about the payload, and a
// submission carrying no selections looks exactly like a good one - both
// to the teacher and afterwards in the sheet. Empty lines are marked so
// they read as "you have not answered this" rather than as blank space.
function renderSummary() {
  // "Aðrar stofur" rather than "eftirstandandi": marking a room "hentar
  // ekki" does not remove it. The backend moves it to the back of the
  // course's list and pulls it forward again if the course would
  // otherwise be left with too few rooms (MIN_PREFERRED_ROOMS,
  // room_preferences.py). Showing a "remaining" count would promise a veto
  // this is not, and the surprise would land on the one teacher who ends
  // up in the room they marked.
  const others = (catalog.get(el('course').value) || [])
    .map((row) => String(row.room_id || '').trim())
    .filter((id, index, all) => id && all.indexOf(id) === index)
    .filter((id) => !state.rooms.has(id));

  const rows = [
    ['Misseri', termLabel(state.term)],
    ['Vikur', Array.from(state.weeks).sort((a, b) => a - b).join(', ')],
    ['Tímar sem henta', keysWith(state.slots, 'prefer').join(', ')],
    ['Tímar sem henta ekki', keysWith(state.slots, 'avoid').join(', ')],
    ['Stofur sem henta', roomNames(keysWith(state.rooms, 'prefer'))],
    ['Stofur sem henta ekki', roomNames(keysWith(state.rooms, 'avoid'))],
    ['Aðrar stofur', others.length
      ? others.length + ': ' + roomNames(others)
      : '']
  ];
  const target = el('summary');
  target.innerHTML = '';
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value' + (value ? '' : ' empty');
    v.textContent = value || 'ekkert valið';
    row.append(l, v);
    target.appendChild(row);
  });
}

// Room ids are what gets submitted, but they mean nothing to a reader -
// show the names the teacher actually clicked.
function roomNames(roomIds) {
  const rows = catalog.get(el('course').value) || [];
  return roomIds
    .map((id) => {
      const row = rows.filter((r) => String(r.room_id) === String(id))[0];
      return row ? (row.room_name || id) : id;
    })
    .join(', ');
}

/* ---------- data -------------------------------------------------- */

async function loadCatalog() {
  const school = el('school').value;
  const select = el('course');
  select.innerHTML = '<option value="">Sæki námskeið…</option>';
  catalogRows = [];

  try {
    // Fetched WITHOUT a term filter on purpose: the reply is what tells
    // the page which terms exist, and a filtered one could not populate
    // the term selector. Switching term afterwards re-filters these rows
    // rather than asking again.
    const response = await fetch(CONFIG.apiUrl + '?school=' + encodeURIComponent(school));
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
    catalogRows = body.rows || [];
    renderTerms();
    applyTerm();
  } catch (error) {
    // Everything the previous school left behind goes too. A failed
    // fetch that kept the old course's rooms selectable would let a wish
    // be built from one school's catalogue and submitted against another.
    catalog.clear();
    allRooms.clear();
    extraRooms.clear();
    state.rooms.clear();
    state.term = null;
    select.innerHTML = '<option value="">Tókst ekki að sækja námskeið</option>';
    el('courseHint').textContent = 'Villa: ' + error.message;
    showStepsForCourse();
  }
}

/* Which term the page is collecting for.
 *
 * The link decides where it can (?year=&semester=, the way ?school=
 * already works), and otherwise the newest term in the catalog wins,
 * because wishes are gathered for the term being PLANNED rather than the
 * one running. Either way the choice is shown rather than merely applied:
 * a teacher filling in half an hour of preferences for the wrong term
 * finds out only when the answers never take effect.
 */
function renderTerms() {
  const select = el('term');
  const terms = termsInRows(catalogRows);
  const wanted = termFromQuery();
  // A term already chosen wins over the link. The link SEEDS the choice
  // - state.term is null on first render, so ?year=&semester= decides
  // then - but re-rendering must not undo a teacher who has since picked
  // the other term, which would silently snap the form back every time.
  const chosen = (state.term && terms.filter((t) => sameTerm(t, state.term))[0])
    || (wanted && terms.filter((t) => sameTerm(t, wanted))[0])
    || terms[0]
    || null;
  state.term = chosen;

  if (!select) return;
  select.innerHTML = '';
  terms.forEach((term) => {
    const option = document.createElement('option');
    option.value = term.year + '-' + term.semester;
    option.textContent = termLabel(term);
    select.appendChild(option);
  });
  if (chosen) select.value = chosen.year + '-' + chosen.semester;
  // A school with one term has no choice to make, and a dropdown of one
  // is an invitation to look for the other. Still rendered, just not
  // offered as a decision.
  select.disabled = terms.length < 2;
  const hint = el('termHint');
  if (hint) {
    hint.textContent = chosen
      ? 'Óskirnar gilda fyrir ' + termLabel(chosen) + '.'
      : 'Ekkert misseri skráð í námsframboði.';
  }
}

// Everything downstream of the term: the course list, the room index and
// the week dates all belong to one term and must be rebuilt when it
// changes. Any picks already made are dropped - they named rooms and
// weeks of the term being left behind.
function applyTerm() {
  const select = el('course');
  catalog.clear();
  allRooms.clear();
  extraRooms.clear();
  state.rooms.clear();
  state.weeks.clear();
  el('courseSearch').value = '';
  el('course').value = '';
  renderCourseResults(false);
  renderWeeks();

  const term = state.term;
  catalogRows.forEach((row) => {
    // A row with no term is kept whatever the term is: the catalog tab
    // predates these columns, and a school that has not been re-synced
    // yet would otherwise offer no courses at all.
    const rowYear = String(row.year || '').trim();
    const rowSemester = semesterLetter(row.semester);
    if (term && rowYear && rowSemester && !sameTerm({ year: rowYear, semester: rowSemester }, term)) {
      return;
    }
    const courseId = String(row.course_id || '').trim();
    if (!courseId) return;
    if (!catalog.has(courseId)) catalog.set(courseId, []);
    catalog.get(courseId).push(row);

    // The same row indexed a second way. A room appears once per course
    // that uses it, so the first sighting wins and the rest collapse
    // onto it - this index is about the room, not the course.
    const roomId = String(row.room_id || '').trim();
    if (roomId && !allRooms.has(roomId)) allRooms.set(roomId, row);
  });

  select.innerHTML = '<option value="">Veldu námskeið…</option>';
  Array.from(catalog.keys()).sort().forEach((courseId) => {
    const first = catalog.get(courseId)[0] || {};
    const option = document.createElement('option');
    option.value = courseId;
    option.textContent = courseId + (first.course_name ? ' — ' + first.course_name : '');
    select.appendChild(option);
  });

  const forTerm = state.term ? ' á ' + termLabel(state.term).toLowerCase() : '';
  el('courseHint').textContent = catalog.size
    ? catalog.size + ' námskeið í boði fyrir þetta svið' + forTerm + '.'
    : 'Engin námskeið skráð fyrir þetta svið' + forTerm + ' enn.';
  showStepsForCourse();
}

function onTermChange() {
  const raw = String(el('term').value || '');
  const parts = raw.split('-');
  state.term = parts.length === 2 && parts[0]
    ? { year: parts[0], semester: semesterLetter(parts[1]) }
    : null;
  renderTerms();
  applyTerm();
}

async function submit() {
  const courseId = el('course').value;
  if (!courseId) { setStatus('Veldu námskeið fyrst.', 'err'); return; }

  // Ten digits, no separators. Spoi joins a wish to a teacher through the
  // kennitala embedded in teachers.username - without it the submission
  // reaches the sheet and then has nothing to attach to, which looks like
  // a successful answer that quietly never arrives.
  // The floor is checked again here: the click guard stops a teacher
  // vetoing past it, but a course whose own list is shorter than the floor
  // starts below it with nothing vetoed at all, and only searching for
  // more rooms fixes that.
  const open = openRoomCount();
  if (open < CONFIG.minOpenRooms) {
    setStatus('Minnst ' + CONFIG.minOpenRooms + ' stofur verða að standa eftir - '
      + 'nú eru þær ' + open + '. Notaðu "Finna aðra stofu" til að bæta við.', 'err');
    return;
  }

  const ssn = el('ssn').value.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(ssn)) {
    setStatus('Sláðu inn kennitölu (10 tölustafir) - án hennar ratar óskin ekki á rétt námskeið.', 'err');
    el('ssn').focus();
    return;
  }

  if (!state.term) { setStatus('Ekkert misseri valið.', 'err'); return; }

  const payload = {
    school: el('school').value,
    // Sent with every wish, not inferred on arrival: the same course_id
    // can be taught in both terms, so nothing downstream can work out
    // which one an answer meant once it has been stored without it.
    year: state.term.year,
    semester: state.term.semester,
    course_id: courseId,
    teacher_email: el('email').value.trim(),
    teacher_ssn: ssn,
    prefer_rooms: keysWith(state.rooms, 'prefer'),
    avoid_rooms: keysWith(state.rooms, 'avoid'),
    prefer_times: keysWith(state.slots, 'prefer'),
    avoid_times: keysWith(state.slots, 'avoid'),
    weeks: Array.from(state.weeks).sort((a, b) => a - b),
    note: el('note').value.trim()
  };

  el('submitBtn').disabled = true;
  setStatus('Sendi…');
  try {
    // text/plain keeps this a "simple request", so the browser skips the
    // CORS preflight - Apps Script cannot answer an OPTIONS call. The body
    // is still JSON and doPost parses it as such.
    const response = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
    setStatus('Óskir vistaðar fyrir ' + termLabel(state.term) + '. Takk!', 'ok');
  } catch (error) {
    // The write may well have landed even when the reply cannot be read -
    // say so rather than implying the answer was lost.
    setStatus(
      'Ekki tókst að staðfesta sendingu (' + error.message + '). '
        + 'Athugaðu hvort óskin skilaði sér áður en þú sendir aftur.',
      'err'
    );
  }
  el('submitBtn').disabled = false;
}

/* ---------- wiring ------------------------------------------------ */

renderSchools();
renderRoomLimits();
renderWeeks();
renderSlots();
loadCatalog();

el('school').addEventListener('change', loadCatalog);
el('term').addEventListener('change', onTermChange);
el('course').addEventListener('change', onCourseChange);
el('roomSearch').addEventListener('input', renderRoomSearch);
el('courseSearch').addEventListener('input', () => renderCourseResults());
el('courseSearch').addEventListener('focus', () => renderCourseResults());
el('courseSearch').addEventListener('keydown', onCourseKeydown);
// Half-typed text left in the box would claim a course that was never
// selected, so leaving the field snaps it back to what is actually set.
el('courseSearch').addEventListener('blur', () => {
  const selected = el('course').value;
  el('courseSearch').value = selected ? courseLabel(selected) : '';
  renderCourseResults(false);
});
el('submitBtn').addEventListener('click', submit);

document.querySelectorAll('[data-weeks]').forEach((button) => {
  button.addEventListener('click', () => {
    const range = weekRangeFromQuery();
    state.weeks.clear();
    if (button.dataset.weeks === 'all') {
      for (let week = range.from; week <= range.to; week++) state.weeks.add(week);
    }
    renderWeeks();
    renderSummary();
  });
});
