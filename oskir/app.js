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

  // ISO weeks. Autumn term by default; override with ?weeks=2-16.
  weeks: { from: 34, to: 47 },

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

  maxRoomPicks: 3
};

// course_id -> its catalog rows, filled by the one GET below.
const catalog = new Map();

const state = {
  weeks: new Set(),
  // "mán-0" -> 'prefer' | 'avoid'
  slots: new Map(),
  // room_id -> 'prefer' | 'avoid'
  rooms: new Map()
};

const el = (id) => document.getElementById(id);

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
  if (!match) return CONFIG.weeks;
  return { from: Number(match[1]), to: Number(match[2]) };
}

function setStatus(message, kind) {
  const node = el('status');
  node.textContent = message || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}

// Cycles neutral -> avoid -> prefer -> neutral, matching Spoi's own slot
// buttons. "Avoid" comes first on purpose: it is the answer people
// actually have, and the one they reach for most.
function cycle(map, key, capPrefer, capAvoid) {
  const current = map.get(key);
  if (!current) {
    if (capAvoid != null && countOf(map, 'avoid') >= capAvoid) return false;
    map.set(key, 'avoid');
  } else if (current === 'avoid') {
    if (capPrefer != null && countOf(map, 'prefer') >= capPrefer) {
      map.delete(key);
      return true;
    }
    map.set(key, 'prefer');
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
  const target = el('weekGrid');
  target.innerHTML = '';
  for (let week = range.from; week <= range.to; week++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-btn' + (state.weeks.has(week) ? ' selected' : '');
    button.textContent = week;
    button.onclick = () => {
      if (state.weeks.has(week)) state.weeks.delete(week);
      else state.weeks.add(week);
      renderWeeks();
      renderSummary();
    };
    target.appendChild(button);
  }
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
      button.onclick = () => { cycle(state.slots, token); renderSlots(); renderSummary(); };
      target.appendChild(button);
    });
  }
}

function renderRooms() {
  const target = el('roomList');
  const rows = catalog.get(el('course').value) || [];
  target.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Engar stofur skráðar fyrir þetta námskeið enn.';
    target.appendChild(empty);
    el('roomCount').textContent = '';
    return;
  }

  rows.forEach((row) => {
    const roomId = String(row.room_id || '').trim();
    if (!roomId) return;
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
      + (value === 'prefer' ? ' — hentar vel' : (value === 'avoid' ? ' — hentar ekki' : ''));

    button.append(name, meta);
    button.onclick = () => {
      const changed = cycle(state.rooms, roomId, CONFIG.maxRoomPicks, CONFIG.maxRoomPicks);
      if (!changed) {
        setStatus('Í mesta lagi ' + CONFIG.maxRoomPicks + ' stofur af hvoru.', 'err');
        return;
      }
      setStatus('');
      renderRooms();
      renderSummary();
    };
    target.appendChild(button);
  });

  el('roomCount').textContent =
    'Valdar: ' + countOf(state.rooms, 'prefer') + ' henta vel, '
    + countOf(state.rooms, 'avoid') + ' henta ekki.';
}

function showStepsForCourse() {
  const chosen = !!el('course').value;
  ['weeksCard', 'timesCard', 'roomsCard', 'noteCard', 'summaryCard', 'submitCard']
    .forEach((id) => { el(id).hidden = !chosen; });
  if (chosen) { renderRooms(); renderSummary(); }
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
  catalog.clear();
  state.rooms.clear();

  try {
    const response = await fetch(CONFIG.apiUrl + '?school=' + encodeURIComponent(school));
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');

    (body.rows || []).forEach((row) => {
      const courseId = String(row.course_id || '').trim();
      if (!courseId) return;
      if (!catalog.has(courseId)) catalog.set(courseId, []);
      catalog.get(courseId).push(row);
    });

    select.innerHTML = '<option value="">Veldu námskeið…</option>';
    Array.from(catalog.keys()).sort().forEach((courseId) => {
      const first = catalog.get(courseId)[0] || {};
      const option = document.createElement('option');
      option.value = courseId;
      option.textContent = courseId + (first.course_name ? ' — ' + first.course_name : '');
      select.appendChild(option);
    });

    el('courseHint').textContent = catalog.size
      ? catalog.size + ' námskeið í boði fyrir þetta svið.'
      : 'Engin námskeið skráð fyrir þetta svið enn.';
  } catch (error) {
    select.innerHTML = '<option value="">Tókst ekki að sækja námskeið</option>';
    el('courseHint').textContent = 'Villa: ' + error.message;
  }
  showStepsForCourse();
}

async function submit() {
  const courseId = el('course').value;
  if (!courseId) { setStatus('Veldu námskeið fyrst.', 'err'); return; }

  const payload = {
    school: el('school').value,
    course_id: courseId,
    teacher_email: el('email').value.trim(),
    teacher_ssn: el('ssn').value.trim(),
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
    setStatus('Óskir vistaðar. Takk!', 'ok');
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
renderWeeks();
renderSlots();
loadCatalog();

el('school').addEventListener('change', loadCatalog);
el('course').addEventListener('change', () => { state.rooms.clear(); showStepsForCourse(); });
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
