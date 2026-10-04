'use strict';

/* ------------------------------------------------------------------ helpers */

const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Minimal markdown for announcement bodies: **bold**, *italic*, `code`,
 * [label](url) links, and bare http(s) URLs auto-linked. Escapes HTML
 * first, then only ever inserts tags it built itself — so no markdown
 * span can escape into raw HTML.
 */
function renderMarkdown(raw) {
  const links = [];
  const stash = (html) => { links.push(html); return `\u0000${links.length - 1}\u0000`; };

  let text = esc(raw)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => stash(
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    ))
    .replace(/(https?:\/\/[^\s<]+)/g, (full) => {
      const trailMatch = full.match(/[).,;:!?]+$/);
      const trail = trailMatch ? trailMatch[0] : '';
      const url = trail ? full.slice(0, -trail.length) : full;
      return stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail;
    })
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);

  return text;
}

/** All iconography is the SVG sprite in index.html — deliberately no emoji. */
function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, opts = {}) {
  const t = el('toast');
  t.innerHTML = (opts.icon ? icon(opts.icon) : '') + `<span>${esc(msg)}</span>`;
  t.className = 'toast' + (opts.bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function thaiDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

/** Passport/DOB fields are entered and shown as dd/mm/yyyy, but stored (and
    compared, for the DOB identity check) as plain ISO "yyyy-mm-dd". */
function ddmmyyyyToIso(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function isoToDdmmyyyy(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

function relTime(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} วันที่แล้ว`;
  return thaiDate(iso);
}

/* -------------------------------------------------------------------- state */

let state = null;
let view = 'overview';
let filesPath = '';        // current folder in the ไฟล์เอกสาร tab ('' = root)
let filesListing = null;   // { folders, files } for filesPath, or null while (re)loading
let verifyUnlocked = null; // full lookup result (name, team, profile, …) once the DOB check passes
let verifyDob = '';        // the DOB that unlocked it — resent on files-* calls (there's no session)
let verifyError = '';      // error from the last failed DOB check, shown inline
let verifyFiles = null;    // this person's own documents, or null while (re)loading
let verifyPhotoUrl = null; // signed URL for their profile photo, or null if none/not loaded yet
let personView = null;      // { teamKey, memberIndex } — admin's full-page view of one person (view === 'person')
let personFilesList = null; // that person's documents, or null while (re)loading
let personPhotoUrl = null;  // signed URL for their profile photo, or null if none/not loaded yet
const SEEN_KEY = 'wrg2026.seen.v1';

// A shared link like "?verify=1" (or "?view=verify") opens straight into the
// self-verification tab instead of the overview — no login needed.
{
  const qp = new URLSearchParams(location.search);
  if (qp.get('verify') === '1' || qp.get('view') === 'verify') view = 'verify';
}

const TEAM_STYLE = {
  ballfighting: { icon: 'shield', color: 'var(--ball)',   tint: 'var(--ball-tint)',   chip: 'team-ball' },
  soccer4x4:    { icon: 'ball',   color: 'var(--soccer)', tint: 'var(--soccer-tint)', chip: 'team-soccer' },
  // both teams sharing one slot (e.g. the joint closing ceremony) — merged
  // into a single timeline bar instead of two identical overlapping ones.
  both:         { icon: 'trophy', color: 'var(--brand)',  tint: 'var(--brand-tint)',  chip: 'team-both' },
};
const TEAM_LABEL = { all: 'ทุกทีม', ballfighting: 'Ball Fighting', soccer4x4: 'Soccer 4x4' };
const LEVEL_ICON = { info: 'megaphone', important: 'alert', urgent: 'urgent' };
const LEVEL_PREFIX = { info: '', important: 'สำคัญ · ', urgent: 'ด่วน · ' };
const STATUS_LABEL = { scheduled: 'ตามกำหนด', live: 'กำลังแข่ง', done: 'จบแล้ว', cancelled: 'ยกเลิก', changed: 'เปลี่ยนเวลา' };
const TYPE_LABEL = { competition: 'การแข่งขัน', other: 'อื่นๆ (พิธีการ/กิจกรรม)' };
const MAIN_EVENT_LABEL = {
  '': 'ยังไม่ระบุ',
  soccer4x4: 'Soccer 4x4',
  ballfighting: 'Ball Fighting',
  both: 'Soccer 4x4 และ Ball Fighting',
  none: 'ไม่ได้แข่ง (ทีมงาน/พี่เลี้ยง)',
};

function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}
function saveSeen(seen) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* private mode */ }
}

/** Unread = never seen, or edited since the last time it was seen. */
function unreadPosts() {
  if (!state) return [];
  const seen = loadSeen();
  return state.announcements.filter((a) => seen[a.id] !== a.updatedAt);
}

function markAllSeen() {
  const seen = {};
  for (const a of state.announcements) seen[a.id] = a.updatedAt;
  saveSeen(seen);
}

/* ------------------------------------------------------------ notifications */

function notifyEnabled() {
  return 'Notification' in window && Notification.permission === 'granted'
    && localStorage.getItem('wrg2026.notify') === 'on';
}

function refreshNotifyButton() {
  el('btn-notify').classList.toggle('on', notifyEnabled());
}

async function toggleNotify() {
  if (!('Notification' in window)) return toast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน', { bad: true });
  if (notifyEnabled()) {
    localStorage.setItem('wrg2026.notify', 'off');
    refreshNotifyButton();
    return toast('ปิดการแจ้งเตือนแล้ว', { icon: 'bell' });
  }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') return toast('คุณปฏิเสธการแจ้งเตือนในเบราว์เซอร์', { bad: true });
  localStorage.setItem('wrg2026.notify', 'on');
  refreshNotifyButton();
  toast('เปิดการแจ้งเตือนแล้ว', { icon: 'bell' });
  new Notification('WRG 2026 Japan', { body: 'จะแจ้งเตือนทันทีเมื่อมีอัปเดตใหม่', tag: 'wrg-test' });
}

function pushNotifications(posts) {
  if (!notifyEnabled()) return;
  for (const p of posts.slice(0, 3)) {
    const n = new Notification((LEVEL_PREFIX[p.level] || '') + p.title, {
      body: p.body.slice(0, 160),
      tag: 'wrg-' + p.id,
    });
    n.onclick = () => { window.focus(); setView('updates'); };
  }
}

function refreshUnreadUi() {
  const n = unreadPosts().length;
  const badge = el('notify-badge');
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n === 0);
  el('tab-updates-dot').classList.toggle('hidden', n === 0);
}

/* ---------------------------------------------------------------- countdown */

function renderCountdown() {
  const box = el('countdown');
  const target = new Date(state.meta.departISO);
  if (Number.isNaN(target.getTime())) return (box.innerHTML = '');
  const diff = target - Date.now();

  if (diff <= 0) {
    box.innerHTML = `<div class="countdown-inner">${icon('plane')}
      <span><strong>อยู่ระหว่างทริป WRG2026 Japan</strong> · ${esc(state.meta.venue)}</span></div>`;
    return;
  }
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000) % 24;
  const m = Math.floor(diff / 60000) % 60;
  box.innerHTML = `<div class="countdown-inner">${icon('timer')}
    <span>เหลืออีก <strong>${d}</strong> วัน <strong>${h}</strong> ชั่วโมง <strong>${m}</strong> นาที</span>
    <span class="muted">· ${esc(state.meta.dates)}</span></div>`;
}

/* ------------------------------------------------------------------- render */

function postHtml(post, seen) {
  const isNew = seen[post.id] !== post.updatedAt;
  const teams = (post.teams || ['all']).map((t) => {
    const s = TEAM_STYLE[t];
    return `<span class="chip ${s ? s.chip : ''}">${s ? icon(s.icon) : ''}${esc(TEAM_LABEL[t] || t)}</span>`;
  }).join('');
  const edited = post.updatedAt !== post.createdAt ? ' · แก้ไขแล้ว' : '';

  return `
    <article class="post ${esc(post.level)}">
      <div class="post-head">
        <span class="post-icon">${icon(LEVEL_ICON[post.level] || 'megaphone')}</span>
        <h3>${esc(post.title)}</h3>
        ${post.pinned ? `<span class="chip">${icon('bookmark')}ปักหมุด</span>` : ''}
        ${isNew ? '<span class="chip new">ใหม่</span>' : ''}
        <span class="admin-only" style="gap:7px">
          <button class="btn outline sm" data-edit-post="${esc(post.id)}">${icon('edit')}แก้ไข</button>
          <button class="btn danger sm" data-del-post="${esc(post.id)}">${icon('trash')}ลบ</button>
        </span>
      </div>
      <div class="post-meta">${teams}<span>${esc(relTime(post.updatedAt))}${edited}</span></div>
      ${post.body ? `<div class="post-body">${renderMarkdown(post.body)}</div>` : ''}
    </article>`;
}

function matchHtml(m, teamKey, style, i) {
  const status = STATUS_LABEL[m.status] ? m.status : 'scheduled';
  return `
    <div class="match" style="--team:${style.color}">
      <div class="match-time">
        <b>${esc(m.time)}</b>
        <span class="match-date">${esc(thaiDate(m.date))}</span>
      </div>
      <div class="match-body">
        <div class="match-label">${esc(m.label)}
          <span class="status ${status}">${esc(STATUS_LABEL[status])}</span>
        </div>
        ${m.note ? `<div class="match-note">${esc(m.note)}</div>` : ''}
      </div>
      <span class="row-tools admin-only">
        <select class="btn outline sm" data-match-status="${esc(teamKey)}:${esc(m.id)}" title="เปลี่ยนสถานะ">
          ${Object.entries(STATUS_LABEL).map(([k, v]) =>
            `<option value="${k}"${k === status ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
        <button class="btn outline sm" data-rec="${esc(teamKey)}:match:${i}" title="แก้ไข">${icon('edit')}</button>
        <button class="btn danger sm" data-rec-del="${esc(teamKey)}:match:${i}" title="ลบ">${icon('trash')}</button>
      </span>
    </div>`;
}

/** Admin "+ add" row shown under each editable list. */
function addBtn(teamKey, kind, label) {
  return `<div class="add-row admin-only">
    <button class="btn outline sm" data-rec-add="${esc(teamKey)}:${kind}">${icon('plus')}${esc(label)}</button>
  </div>`;
}

function rowTools(teamKey, kind, i) {
  return `<span class="row-tools admin-only">
    <button class="btn outline sm" data-rec="${esc(teamKey)}:${kind}:${i}" title="แก้ไข">${icon('edit')}</button>
    <button class="btn danger sm" data-rec-del="${esc(teamKey)}:${kind}:${i}" title="ลบ">${icon('trash')}</button>
  </span>`;
}

/** One row in a member's personal timetable — a lighter version of matchHtml. */
function memberEventRow(rawEv, teamKey, memberIndex, i) {
  // pre-timetable data stored events as plain strings; show the old label
  // correctly until it's re-saved and the server migrates it.
  const ev = typeof rawEv === 'string' ? { label: rawEv } : rawEv;
  const status = STATUS_LABEL[ev.status] ? ev.status : 'scheduled';
  return `
    <div class="mev-row">
      <span class="mev-time">
        ${esc(ev.time || '')}${ev.date ? `<span class="mev-date">${esc(thaiDate(ev.date))}</span>` : ''}
      </span>
      <span class="mev-label">${esc(ev.label)}
        <span class="status ${status}">${esc(STATUS_LABEL[status])}</span>
        ${ev.note ? `<span class="mev-note">${esc(ev.note)}</span>` : ''}
      </span>
      <span class="row-tools admin-only">
        <button class="btn outline sm" data-rec="${esc(teamKey)}:memberEvent:${memberIndex}:${i}" title="แก้ไข">${icon('edit')}</button>
        <button class="btn danger sm" data-rec-del="${esc(teamKey)}:memberEvent:${memberIndex}:${i}" title="ลบ">${icon('trash')}</button>
      </span>
    </div>`;
}

/** Same competition name = the same competition, just at another time —
    a sub-row with no repeated label, used once a group has 2+ occurrences. */
function memberEventSubRow(rawEv, teamKey, memberIndex, i) {
  const ev = typeof rawEv === 'string' ? { label: rawEv } : rawEv;
  const status = STATUS_LABEL[ev.status] ? ev.status : 'scheduled';
  return `
    <div class="mev-subrow">
      <span class="mev-time">
        ${esc(ev.time || '')}${ev.date ? `<span class="mev-date">${esc(thaiDate(ev.date))}</span>` : ''}
      </span>
      <span class="status ${status}">${esc(STATUS_LABEL[status])}</span>
      ${ev.note ? `<span class="mev-note">${esc(ev.note)}</span>` : ''}
      <span class="row-tools admin-only">
        <button class="btn outline sm" data-rec="${esc(teamKey)}:memberEvent:${memberIndex}:${i}" title="แก้ไข">${icon('edit')}</button>
        <button class="btn danger sm" data-rec-del="${esc(teamKey)}:memberEvent:${memberIndex}:${i}" title="ลบ">${icon('trash')}</button>
      </span>
    </div>`;
}

/** Groups a member's events by exact label — occurrences of the same
    competition (e.g. a first round + a final) render under one name instead
    of as separate, duplicate-looking rows. Each occurrence keeps its own
    edit/delete, since rounds can carry different statuses independently. */
function memberEventGroupsHtml(events, teamKey, memberIndex) {
  const groups = new Map();
  events.forEach((raw, i) => {
    const ev = typeof raw === 'string' ? { label: raw } : raw;
    const key = ev.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ev, i });
  });

  return [...groups.values()].map((occurrences) => {
    if (occurrences.length === 1) {
      const { ev, i } = occurrences[0];
      return memberEventRow(ev, teamKey, memberIndex, i);
    }
    return `
      <div class="mev-group">
        <div class="mev-group-label">${esc(occurrences[0].ev.label)}
          <span class="muted">(${occurrences.length} ครั้ง)</span>
        </div>
        ${occurrences.map(({ ev, i }) => memberEventSubRow(ev, teamKey, memberIndex, i)).join('')}
      </div>`;
  }).join('');
}

const CHECK_GROUPS = [
  ['carry', 'นำขึ้นเครื่อง', 'plane'],
  ['cargo', 'โหลดใต้เครื่อง', 'luggage'],
  ['', 'ยังไม่ระบุ', 'clipboard'],
];

/** Splits a team's checklist into carry-on / checked / unspecified sections,
    while keeping each item's original array index for edit/delete/check. */
function checklistGroupsHtml(checklist, teamKey) {
  return CHECK_GROUPS.map(([tagKey, tagLabel, ic]) => {
    const rows = checklist
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => (c.tag || '') === tagKey);
    if (!rows.length) return '';
    return `
      <div class="check-group">
        <div class="check-group-head">${icon(ic)}<span>${esc(tagLabel)}</span><span class="muted">${rows.length}</span></div>
        ${rows.map(({ c, i }) => `
          <div class="check-row">
            <label class="checkbox">
              <input type="checkbox" data-check="${esc(teamKey)}:${esc(c.id)}" ${c.done ? 'checked' : ''}>
              <span>${esc(c.text)}</span>
            </label>
            ${rowTools(teamKey, 'check', i)}
          </div>`).join('')}
      </div>`;
  }).join('');
}

function teamCardHtml(team, compact) {
  const s = TEAM_STYLE[team.key] || TEAM_STYLE.soccer4x4;
  return `
    <section class="team-card" style="--team:${s.color};--team-tint:${s.tint}">
      <div class="team-card-head">
        <span class="team-badge">${icon(s.icon)}</span>
        <span>
          <span class="team-name">${esc(team.name)}</span>
          ${team.nameTh ? `<br><span class="team-name-th">${esc(team.nameTh)}</span>` : ''}
        </span>
      </div>
      <div class="team-meta">
        ${team.code ? `<span class="meta-pill code-pill">${icon('tag')}รหัสทีม <b>${esc(team.code)}</b></span>` : ''}
        ${team.gameDay ? `<span class="meta-pill">${icon('calendar')}${esc(team.gameDay)}</span>` : ''}
        ${team.arena ? `<span class="meta-pill">${icon('pin')}${esc(team.arena)}</span>` : ''}
      </div>
      ${team.summary ? `<p class="team-summary">${esc(team.summary)}</p>` : ''}
      ${compact
        ? `<div class="card-cta">
             <button class="btn link sm" data-goto="${esc(team.key)}">ดูตารางทีมนี้${icon('chevron')}</button>
           </div>`
        : `<div class="card-cta admin-only">
             <button class="btn outline sm" data-rec="${esc(team.key)}:teamInfo:0">${icon('edit')}แก้ไขข้อมูลทีม</button>
           </div>`}
    </section>`;
}

function renderOverview() {
  const seen = loadSeen();
  const m = state.meta;
  const pinned = state.announcements.filter((a) => a.pinned).slice(0, 2);
  const latest = state.announcements.filter((a) => !a.pinned).slice(0, 3);

  const facts = [
    ['building', 'สนามแข่งขัน', m.venue],
    ['trophy', 'พิธีมอบรางวัล', m.venueAwarding],
    ['bed', 'ที่พัก', m.hotel],
    ['plane', 'สายการบิน', m.airline],
    ['plane', 'เที่ยวบินขาไป', m.flightOut],
    ['plane', 'เที่ยวบินขากลับ', m.flightBack],
  ];

  return `
    <div class="section">
      <div class="grid two">
        ${teamCardHtml(state.teams.ballfighting, true)}
        ${teamCardHtml(state.teams.soccer4x4, true)}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>${icon('megaphone')}อัปเดตล่าสุด</h2>
        <div class="head-actions">
          <button class="btn primary sm admin-only" data-new-post>${icon('plus')}ประกาศใหม่</button>
        </div>
      </div>
      ${[...pinned, ...latest].map((p) => postHtml(p, seen)).join('')
        || '<div class="card muted">ยังไม่มีประกาศ</div>'}
      ${state.announcements.length > 5 ? `<div style="margin-top:12px">
        <button class="btn link sm" data-goto="updates">ดูประกาศทั้งหมด (${state.announcements.length})${icon('chevron')}</button>
      </div>` : ''}
    </div>

    <div class="section">
      <div class="section-head">
        <h2>${icon('info')}ข้อมูลทริป</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-edit-json="meta">${icon('edit')}แก้ไข</button>
        </div>
      </div>
      <div class="grid facts">
        ${facts.map(([ic, label, value]) => `
          <div class="fact">
            <div class="fact-head">${icon(ic)}<span class="fact-label">${esc(label)}</span></div>
            <div class="fact-value">${esc(value)}</div>
          </div>`).join('')}
      </div>
      <div class="card flat" style="margin-top:14px">
        <p class="muted" style="display:flex;align-items:center;gap:8px">${icon('clock')}${esc(m.timezoneNote)}</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>${icon('bookmark')}หมายเหตุสำคัญ</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-edit-json="notes">${icon('edit')}แก้ไข</button>
        </div>
      </div>
      <div class="card">
        <ul style="margin:0;padding-inline-start:20px;color:var(--ink-2);font-size:.89rem">
          ${state.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
        </ul>
      </div>
    </div>`;
}

function renderTeam(key) {
  const team = state.teams[key];
  const s = TEAM_STYLE[key] || TEAM_STYLE.soccer4x4;
  const done = team.checklist.filter((c) => c.done).length;
  const seen = loadSeen();
  const posts = state.announcements.filter(
    (a) => (a.teams || []).includes(key) || (a.teams || []).includes('all')
  );

  return `
    <div class="section">${teamCardHtml(team, false)}</div>

    <div class="section">
      <div class="section-head">
        <h2>${icon('flag')}ตารางแข่งของทีม</h2>
      </div>
      <div class="card">
        ${team.matches.map((m, i) => matchHtml(m, key, s, i)).join('') || '<p class="muted">ยังไม่มีรายการแข่ง</p>'}
        ${addBtn(key, 'match', 'เพิ่มรายการแข่ง')}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>${icon('users')}สมาชิกทีม</h2></div>
      <div class="card">
        ${team.members.length
          ? team.members.map((mb, i) => `
            <div class="match">
              <div class="match-body">
                <div class="match-label">${esc(mb.name)}
                  ${mb.code ? `<span class="code-chip">${esc(mb.code)}</span>` : ''}
                </div>
                ${mb.role || mb.mainEvent
                  ? `<div class="match-note">${[mb.role, mb.mainEvent ? MAIN_EVENT_LABEL[mb.mainEvent] : '']
                      .filter(Boolean).map(esc).join(' · ')}</div>`
                  : ''}
                ${mb.events && mb.events.length
                  ? `<div class="member-timetable">${memberEventGroupsHtml(mb.events, key, i)}</div>`
                  : ''}
                <div class="admin-only add-row-sm">
                  <button class="btn outline sm" data-rec-add="${esc(key)}:memberEvent:${i}">${icon('plus')}เพิ่มรายการแข่งอื่น</button>
                </div>
              </div>
              <span class="row-tools admin-only">
                <button class="btn outline sm" data-goto-person="${esc(key)}:${i}" title="ข้อมูลและไฟล์ของสมาชิก">${icon('edit')}ข้อมูล</button>
                <button class="btn danger sm" data-rec-del="${esc(key)}:member:${i}" title="ลบ">${icon('trash')}</button>
              </span>
            </div>`).join('')
          : '<p class="muted">ยังไม่ได้เพิ่มรายชื่อสมาชิก</p>'}
        ${addBtn(key, 'member', 'เพิ่มสมาชิก')}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>${icon('clipboard')}เช็กลิสต์ของที่ต้องเตรียม</h2>
        <span class="muted">${done} / ${team.checklist.length}</span>
      </div>
      <div class="card">
        ${team.checklist.length ? checklistGroupsHtml(team.checklist, key) : '<p class="muted">ยังไม่มีรายการ</p>'}
        ${addBtn(key, 'check', 'เพิ่มรายการ')}
        <p class="muted" style="margin-top:10px">
          รายการในเช็กลิสต์แก้ไขได้เฉพาะผู้ดูแล ส่วนการติ๊กถูกจะบันทึกแยกในเครื่องของแต่ละคน
        </p>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>${icon('megaphone')}ประกาศที่เกี่ยวกับทีมนี้</h2></div>
      ${posts.map((p) => postHtml(p, seen)).join('') || '<div class="card muted">ยังไม่มีประกาศ</div>'}
    </div>`;
}

const PROFILE_FIELD_LABELS = [
  ['school', 'โรงเรียน / สังกัด'],
  ['passportNo', 'เลขพาสปอร์ต'],
  ['passportIssue', 'วันออกพาสปอร์ต'],
  ['passportExpiry', 'วันหมดอายุพาสปอร์ต'],
  ['dob', 'วันเกิด'],
  ['city', 'จังหวัด/เมือง'],
  ['shirtSize', 'ไซส์เสื้อ'],
  ['foodNote', 'อาหาร / ข้อจำกัดด้านอาหาร'],
  ['nationalId', 'เลขบัตรประชาชน'],
];
const DDMMYYYY_PROFILE_KEYS = new Set(['dob', 'passportIssue', 'passportExpiry']);

/** Self-serve lookup: a team member types their date of birth — that alone
    identifies them, since no two *different* people share one — and sees
    their own info and documents. Read-only: no editing, no confirming.
    Someone on more than one team roster (e.g. a mentor) sees one combined
    result covering every team they're on — see verifyUnlocked.teams below.
    The sensitive half of a member's record (passport, DOB, food note, …) is
    never sent to the browser until that DOB is typed; see /api/verify (op
    "lookup"). The link is shareable as-is, or with "?verify=1" to land here
    directly. */
function renderVerify() {
  let body;
  if (!verifyUnlocked) {
    body = `
      <form id="verify-dob-form" class="card verify-detail">
        <label for="verify-dob">วันเกิดของคุณ</label>
        <input type="text" id="verify-dob" class="verify-select" placeholder="วว/ดด/ปปปป"
          pattern="\\d{1,2}/\\d{1,2}/\\d{4}" required>
        ${verifyError ? `<p class="error" style="margin-top:8px">${esc(verifyError)}</p>` : ''}
        <button type="submit" class="btn primary" style="margin-top:14px">${icon('shield')}ค้นหา</button>
      </form>`;
  } else {
    const v = verifyUnlocked;
    const p = v.profile || {};
    const profileRows = PROFILE_FIELD_LABELS
      .filter(([k]) => p[k])
      .map(([k, label]) => {
        const val = DDMMYYYY_PROFILE_KEYS.has(k) ? thaiDate(p[k]) : p[k];
        return `<div class="verify-field"><span class="muted">${esc(label)}</span><span>${esc(val)}</span></div>`;
      }).join('');

    const teamLabels = v.teams.map((t) => t.teamLabel).join(', ');
    const first = v.teams[0];

    const filesHtml = verifyFiles === null
      ? '<p class="muted" style="margin-top:10px">กำลังโหลด…</p>'
      : !verifyFiles.length
        ? '<p class="muted" style="margin-top:10px">ยังไม่มีเอกสาร</p>'
        : `<div class="files-browser">${verifyFiles.map((f) => `
            <div class="files-row">
              <span class="files-row-icon">${icon('clipboard')}</span>
              <span class="files-row-name files-row-clickable" data-verify-file-download="${esc(f.name)}">${esc(f.name)}</span>
              <span class="files-row-meta muted">${esc(fileSizeLabel(f.size))}</span>
            </div>`).join('')}</div>`;

    body = `
      <div class="card verify-detail">
        <div class="person-header">
          ${verifyPhotoUrl ? `<img class="person-photo-sm" src="${esc(verifyPhotoUrl)}" alt="">` : ''}
          <div>
            <div class="match-label">${esc(v.name)}
              ${v.code ? `<span class="code-chip">${esc(v.code)}</span>` : ''}
            </div>
            <div class="match-note">ทีม: ${esc(teamLabels)}${v.role ? ' · ' + esc(v.role) : ''}
              ${v.mainEvent ? ' · รายการที่แข่ง: ' + esc(MAIN_EVENT_LABEL[v.mainEvent]) : ''}</div>
          </div>
        </div>
        ${profileRows ? `<div class="verify-fields">${profileRows}</div>` : ''}
        <h3 class="verify-subhead">เอกสารของคุณ</h3>
        ${filesHtml}
        ${v.teams.filter((t) => t.matches && t.matches.length).map((t) => `
          <h3 class="verify-subhead">ตารางแข่งของทีม ${esc(t.teamLabel)}</h3>
          <div class="verify-matches">${t.matches.map((m, i) =>
            matchHtml(m, t.teamKey, TEAM_STYLE[t.teamKey] || TEAM_STYLE.soccer4x4, i)).join('')}</div>`).join('')}
        ${v.events && v.events.length ? `
          <h3 class="verify-subhead">รายการแข่งอื่น ๆ ของคุณ</h3>
          <div class="member-timetable">${memberEventGroupsHtml(v.events, first.teamKey, first.memberIndex)}</div>`
          : ''}
        <div style="margin-top:16px">
          <button type="button" class="btn outline" data-verify-reset>${icon('chevron')}ค้นหารายชื่ออื่น</button>
        </div>
        <p class="muted" style="margin-top:12px">
          ถ้าข้อมูลด้านบนไม่ถูกต้อง กรุณาติดต่อผู้ดูแลทีมเพื่อแก้ไข
        </p>
      </div>`;
  }

  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('shield')}ค้นหาข้อมูลของคุณ</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-copy-verify-link>${icon('check')}คัดลอกลิงก์ส่งให้ทีม</button>
        </div>
      </div>
      ${body}
    </div>`;
}

/** Every schedule row, flattened with its day's date/label — used by the
    "pick from the schedule" selector and the timeline. */
function flatSchedule() {
  return state.schedule.flatMap((day) =>
    day.rows.map((r) => ({ date: day.date, dayLabel: day.label, dayTag: day.tag, time: r.time, event: r.event, highlight: r.highlight }))
  );
}

/** Every distinct competition name in the schedule, each with every time it
    occurs (a competition with a first round + final becomes ONE entry here
    with 2 occurrences) — in the order it first appears in the schedule. */
function distinctCompetitions() {
  const byName = new Map();
  for (const row of flatSchedule()) {
    if (!byName.has(row.event)) byName.set(row.event, []);
    byName.get(row.event).push(row);
  }
  return [...byName.entries()].map(([event, occurrences]) => ({ event, occurrences }));
}

/** Members (either team) whose personal event matches a given schedule row,
    by exact label + (blank or matching) date — for the reverse lookup shown
    on the schedule tab. */
function membersForScheduleRow(date, eventText) {
  const out = [];
  for (const teamKey of ['ballfighting', 'soccer4x4']) {
    for (const m of state.teams[teamKey].members) {
      const hit = (m.events || []).some((raw) => {
        const ev = typeof raw === 'string' ? { label: raw } : raw;
        return ev.label === eventText && (!ev.date || ev.date === date);
      });
      if (hit) out.push({ name: m.name, teamKey });
    }
  }
  return out;
}

/** Leading "H:MM" in a time string, as minutes since midnight. null if none. */
function parseTimeMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A time string as a plottable span. "09:30–12:00" -> a bar; "18:30" alone
    -> a point marker; anything else (free text, blank) -> null, unplottable. */
function parseTimeRange(t) {
  const range = /^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (range) {
    const start = Number(range[1]) * 60 + Number(range[2]);
    let end = Number(range[3]) * 60 + Number(range[4]);
    if (end <= start) end = start + 30; // guard against bad/typo'd data
    return { start, end, point: false };
  }
  const point = parseTimeMinutes(t);
  return point === null ? null : { start: point, end: point, point: true };
}

/** Every team match + every member's personal event, from both teams, as one
    flat list — the source data for the Timeline tab. Identical team-level
    entries (same date+time+label on both teams — e.g. a joint closing
    ceremony) are collapsed into one shared "both teams" entry instead of two
    overlapping bars in separate lanes. */
function timelineEntries() {
  const out = [];
  for (const teamKey of ['ballfighting', 'soccer4x4']) {
    const team = state.teams[teamKey];
    for (const m of team.matches) {
      out.push({
        date: m.date, time: m.time, label: m.label, status: m.status,
        type: m.type === 'other' ? 'other' : 'competition',
        kind: 'team', teamKey, who: team.name,
      });
    }
    for (const mem of team.members) {
      for (const raw of (mem.events || [])) {
        const ev = typeof raw === 'string' ? { label: raw } : raw;
        out.push({
          date: ev.date, time: ev.time, label: ev.label, status: ev.status,
          type: ev.type === 'other' ? 'other' : 'competition',
          kind: 'member', teamKey, who: mem.name,
        });
      }
    }
  }

  const merged = [];
  const seen = new Set();
  for (let i = 0; i < out.length; i++) {
    if (seen.has(i) || out[i].kind !== 'team') { if (!seen.has(i)) merged.push(out[i]); continue; }
    const twin = out.findIndex((o, j) =>
      j > i && !seen.has(j) && o.kind === 'team' && o.teamKey !== out[i].teamKey
      && o.date === out[i].date && o.time === out[i].time && o.label === out[i].label);
    if (twin === -1) { merged.push(out[i]); continue; }
    seen.add(i); seen.add(twin);
    merged.push({ ...out[i], teamKey: 'both', who: 'ทั้ง 2 ทีม' });
  }
  return merged;
}

function timelineRowHtml(e) {
  const status = STATUS_LABEL[e.status] ? e.status : 'scheduled';
  const style = TEAM_STYLE[e.teamKey];
  const barColor = e.type === 'other' ? 'var(--other)' : style.color;
  const whoChip = `<span class="tl-who ${style.chip}">${icon(e.kind === 'team' ? style.icon : 'users')}${esc(e.who)}</span>`;
  return `
    <div class="tl-row" style="--team:${barColor}">
      <span class="tl-time">${esc(e.time || '—')}</span>
      <span class="tl-body">
        <span class="tl-label">${esc(e.label)}</span>
        ${whoChip}
        ${e.type === 'other' ? `<span class="chip other-chip">${esc(TYPE_LABEL.other)}</span>` : ''}
        <span class="status ${status}">${esc(STATUS_LABEL[status])}</span>
      </span>
    </div>`;
}

const GANTT_PX_PER_HOUR = 64;

/** One horizontal lane per team + per member-with-an-event, in a stable order:
    Ball Fighting, Soccer 4x4, then their members (grouped by team, A–Z). */
function ganttLanes(entries) {
  const laneKey = (e) => e.kind === 'team' ? `team:${e.teamKey}` : `member:${e.teamKey}:${e.who}`;
  const lanes = new Map();
  for (const e of entries) {
    const key = laneKey(e);
    if (!lanes.has(key)) lanes.set(key, { key, label: e.who, kind: e.kind, teamKey: e.teamKey, bars: [] });
    lanes.get(key).bars.push(e);
  }
  const rank = (l) => {
    if (l.kind !== 'team') return 20; // member lanes last, A–Z
    return l.teamKey === 'ballfighting' ? 0 : l.teamKey === 'soccer4x4' ? 1 : 2; // 'both' after the two teams
  };
  return [...lanes.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'th'));
}

/** Hour-rounded [lo, hi] window (minutes) covering a day's plottable entries,
    padded a bit, with a sane floor so a single short event isn't a giant bar. */
function ganttAxis(entries) {
  let lo = 8 * 60, hi = 21 * 60;
  for (const e of entries) {
    const r = parseTimeRange(e.time);
    if (!r) continue;
    lo = Math.min(lo, r.start);
    hi = Math.max(hi, r.point ? r.start + 30 : r.end);
  }
  lo = Math.floor((lo - 15) / 60) * 60;
  hi = Math.ceil((hi + 15) / 60) * 60;
  if (hi - lo < 60) hi = lo + 60;
  return { lo, hi };
}

function ganttAxisTicksHtml(axis) {
  const ticks = [];
  for (let m = axis.lo; m <= axis.hi; m += 60) {
    const left = Math.round((m - axis.lo) / 60 * GANTT_PX_PER_HOUR);
    ticks.push(`<span class="gaxis-tick" style="left:${left}px">${String(Math.floor(m / 60)).padStart(2, '0')}:00</span>`);
  }
  return ticks.join('');
}

function ganttBarHtml(e, axis) {
  const r = parseTimeRange(e.time);
  if (!r) return '';
  const style = TEAM_STYLE[e.teamKey];
  const barColor = e.type === 'other' ? 'var(--other)' : style.color;
  const status = STATUS_LABEL[e.status] ? e.status : 'scheduled';
  const left = Math.round((r.start - axis.lo) / 60 * GANTT_PX_PER_HOUR);
  const width = r.point ? 16 : Math.max(Math.round((r.end - r.start) / 60 * GANTT_PX_PER_HOUR), 20);
  const title = `${e.time} — ${e.label}${e.kind === 'member' ? ' · ' + e.who : ''}${e.type === 'other' ? ' · ' + TYPE_LABEL.other : ''}`;
  return `
    <div class="gbar ${status}${r.point ? ' point' : ''}" style="left:${left}px;width:${width}px;--team:${barColor}" title="${esc(title)}">
      ${!r.point ? `<span class="gbar-label">${esc(e.label)}</span>` : ''}
    </div>`;
}

/** One shared axis + track width across every day, so the whole trip is one
    continuous chart — days are divider rows inside it, not separate boxes,
    and scrolling stays hour-aligned across all of them. */
function renderGanttChart(byDate, days) {
  const axis = ganttAxis(days.flatMap((d) => byDate.get(d)));
  const trackWidth = Math.round((axis.hi - axis.lo) / 60 * GANTT_PX_PER_HOUR);

  let labelsHtml = '<div class="gantt-label-spacer"></div>';
  let trackHtml = `<div class="gantt-axis" style="width:${trackWidth}px">${ganttAxisTicksHtml(axis)}</div>`;
  const unplottable = [];

  for (const date of days) {
    const lanes = ganttLanes(byDate.get(date));
    labelsHtml += `<div class="gantt-day-divider">${esc(thaiDate(date))}</div>`;
    trackHtml += `<div class="gantt-day-divider-track" style="width:${trackWidth}px"></div>`;
    for (const l of lanes) {
      labelsHtml += `
        <div class="gantt-label">
          ${icon(l.kind === 'team' ? TEAM_STYLE[l.teamKey].icon : 'users')}
          <span>${esc(l.label)}</span>
        </div>`;
      trackHtml += `
        <div class="gantt-row" style="width:${trackWidth}px">
          ${l.bars.map((e) => ganttBarHtml(e, axis)).join('')}
        </div>`;
    }
    unplottable.push(...byDate.get(date).filter((e) => !parseTimeRange(e.time)));
  }

  let lastDate = null;
  const detailsRows = days.flatMap((d) => byDate.get(d))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1)
      : (parseTimeMinutes(a.time) ?? 9999) - (parseTimeMinutes(b.time) ?? 9999)))
    .map((e) => {
      const divider = e.date !== lastDate ? `<div class="tl-day">${esc(thaiDate(e.date))}</div>` : '';
      lastDate = e.date;
      return divider + timelineRowHtml(e);
    }).join('');

  return `
    <div class="gantt-wrap">
      <div class="gantt-body">
        <div class="gantt-labels">${labelsHtml}</div>
        <div class="gantt-scroll"><div class="gantt-track-area" style="width:${trackWidth}px">${trackHtml}</div></div>
      </div>
      ${unplottable.length ? `<p class="muted gantt-note">
        ไม่สามารถแสดงบนกราฟได้ (เวลาไม่ใช่รูปแบบ HH:MM): ${unplottable.map((e) => esc(e.label)).join(', ')}
      </p>` : ''}
      <details class="gantt-details">
        <summary>ดูเป็นรายการข้อความ</summary>
        <div class="gantt-details-list">${detailsRows}</div>
      </details>
    </div>`;
}

function renderTimeline() {
  const all = timelineEntries();
  const dated = all.filter((e) => e.date);
  const undated = all.filter((e) => !e.date);

  const byDate = new Map();
  for (const e of dated) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const days = [...byDate.keys()].sort();

  return `
    <div class="section">
      <div class="section-head"><h2>${icon('timeline')}ไทม์ไลน์รวมทั้งทริป</h2></div>
      <div class="legend">
        <span>แท่งสีแสดงช่วงเวลาแข่งของแต่ละทีม/สมาชิก — เลื่อนแนวนอนเพื่อดูช่วงเวลาอื่น</span>
        <span class="chip team-ball">${icon('shield')}Ball Fighting</span>
        <span class="chip team-soccer">${icon('ball')}Soccer 4x4</span>
      </div>
      ${days.length ? renderGanttChart(byDate, days) : ''}
      ${undated.length ? `
        <div class="section-head" style="margin-top:16px"><h2 style="font-size:.92rem">ยังไม่ระบุวันที่</h2></div>
        <div class="card tl-card">${undated.map(timelineRowHtml).join('')}</div>` : ''}
      ${!days.length && !undated.length ? '<div class="card muted">ยังไม่มีรายการ</div>' : ''}
    </div>`;
}

function renderSchedule() {
  const HL = {
    ballfighting: { hl: 'var(--ball)',   tint: 'var(--ball-tint)',   icon: 'shield', text: 'ทีมเรา' },
    soccer4x4:    { hl: 'var(--soccer)', tint: 'var(--soccer-tint)', icon: 'ball',   text: 'ทีมเรา' },
    both:         { hl: 'var(--brand)',  tint: 'var(--brand-tint)',  icon: 'trophy', text: 'ทั้ง 2 ทีม' },
  };

  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('calendar')}Game Schedule · Chiba Port Arena</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-edit-json="schedule">${icon('edit')}แก้ไข</button>
        </div>
      </div>
      <div class="legend">
        <span>แถวที่ไฮไลต์คือรายการของทีมเรา</span>
        <span class="chip team-ball">${icon('shield')}Ball Fighting</span>
        <span class="chip team-soccer">${icon('ball')}Soccer 4x4</span>
      </div>
      ${state.schedule.map((day) => `
        <div class="day-block">
          <div class="day-head">
            <span class="day-tag">${esc(day.tag)}</span>
            <h3>${esc(thaiDate(day.date))}</h3>
            <span class="day-venue">${icon('pin')}${esc(day.venue)}</span>
          </div>
          ${day.rows.map((r) => {
            const h = HL[r.highlight];
            const who = membersForScheduleRow(day.date, r.event);
            return `<div class="srow${h ? ' hl' : ''}"${h ? ` style="--hl:${h.hl};--hl-tint:${h.tint}"` : ''}>
              <span class="srow-time">${esc(r.time)}</span>
              <span class="srow-event">${esc(r.event)}
                ${h ? `<span class="srow-tag">${icon(h.icon)}${esc(h.text)}</span>` : ''}
                ${who.length ? `<span class="srow-who">${icon('users')}${who.map((w) =>
                  `<span class="who-name ${TEAM_STYLE[w.teamKey].chip}">${esc(w.name)}</span>`).join('')}</span>` : ''}
              </span>
            </div>`;
          }).join('')}
        </div>`).join('')}
      <p class="muted">เวลาบางช่องเป็นค่าประมาณจากตารางต้นฉบับซึ่งเป็นแบบกริด กรุณายืนยันกับตารางหน้างานอีกครั้ง</p>
    </div>`;
}

function renderItinerary() {
  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('plane')}กำหนดการเดินทาง</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-edit-json="itinerary">${icon('edit')}แก้ไข</button>
        </div>
      </div>
      <div class="itin">
        ${state.itinerary.map((day) => `
          <div class="itin-day">
            <span class="itin-label">${esc(day.label)}</span>
            <h3>${esc(day.title)}</h3>
            <div class="itin-items">
              ${day.items.map((it) => `
                <div class="itin-item">
                  <span class="itin-time">${esc(it.time)}</span>
                  <span class="itin-text">${esc(it.text)}</span>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderTravel() {
  const t = state.travel || { note: '', wanderlogUrl: '' };
  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('compass')}ท่องเที่ยวอิสระ</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-edit-json="travel">${icon('edit')}แก้ไข</button>
        </div>
      </div>
      ${t.note ? `<div class="card" style="margin-bottom:16px"><p class="muted" style="color:var(--ink-2)">${esc(t.note)}</p></div>` : ''}
      ${t.wanderlogUrl ? `
        <a class="wanderlog-card" href="${esc(t.wanderlogUrl)}" target="_blank" rel="noopener noreferrer">
          <span class="wanderlog-card-icon">${icon('compass')}</span>
          <span class="wanderlog-card-body">
            <span class="wanderlog-card-title">ดูแผนเที่ยวเต็มใน Wanderlog</span>
            <span class="wanderlog-card-sub">แผนเที่ยววันอิสระ จัดทำและอัปเดตแบบเรียลไทม์โดยทีม — เปิดในแท็บใหม่</span>
          </span>
          <span class="wanderlog-card-arrow">${icon('chevron')}</span>
        </a>`
        : '<div class="card muted">ยังไม่มีลิงก์แผนเที่ยว</div>'}
    </div>`;
}

function fileSizeLabel(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** Admin: navigate to one person's full-page profile — editable fields,
    photo, and their document folder (passport scan, Visit Japan QR code, …,
    stored in its own Supabase bucket the public side never touches). */
function goToPerson(teamKey, memberIndex) {
  const member = state.teams[teamKey]?.members[memberIndex];
  if (!member) return;
  personView = { teamKey, memberIndex };
  personFilesList = null;
  personPhotoUrl = null;
  setView('person');
  loadPersonFilesList();
  if (member.photoName) loadPersonPhoto();
}

async function loadPersonFilesList() {
  if (!personView) return;
  try {
    const res = await api('POST', '/api/verify', { op: 'admin-files-list', ...personView });
    personFilesList = res.files;
  } catch (ex) {
    toast(ex.message, { bad: true });
    personFilesList = [];
  }
  render();
}

async function loadPersonPhoto() {
  const member = state.teams[personView.teamKey]?.members[personView.memberIndex];
  if (!personView || !member?.photoName) return;
  try {
    const res = await api('POST', '/api/verify', { op: 'admin-files-download-url', ...personView, name: member.photoName });
    personPhotoUrl = res.signedUrl;
  } catch { /* photo just won't show — not fatal */ }
  render();
}

/** One form field for the person-edit form — mirrors how PROFILE_FIELD_LABELS
    fields are read back on submit (see the 'person-edit-form' handler). */
function personFieldHtml(id, label, value, opts = {}) {
  if (opts.type === 'select') {
    return `<label for="${id}">${esc(label)}</label>
      <select id="${id}" class="verify-select">${Object.entries(opts.options).map(([k, v]) =>
        `<option value="${k}"${k === value ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  }
  const dateAttrs = opts.isDate ? ' pattern="\\d{1,2}/\\d{1,2}/\\d{4}" placeholder="วว/ดด/ปปปป"' : '';
  return `<label for="${id}">${esc(label)}</label>
    <input type="text" id="${id}" class="verify-select" value="${esc(value)}"${dateAttrs}>`;
}

function renderPersonPage() {
  if (!state.admin) return '<div class="section"><p class="muted">ต้องเข้าสู่ระบบก่อน</p></div>';
  const { teamKey, memberIndex } = personView || {};
  const team = state.teams[teamKey];
  const mb = team?.members[memberIndex];
  if (!mb) return '<div class="section"><p class="muted">ไม่พบข้อมูล</p></div>';
  const p = mb.profile || {};

  const filesHtml = personFilesList === null
    ? '<p class="muted">กำลังโหลด…</p>'
    : !personFilesList.length
      ? '<p class="muted">ยังไม่มีไฟล์</p>'
      : `<div class="files-browser">${personFilesList.map((f) => `
          <div class="files-row">
            <span class="files-row-icon">${icon('clipboard')}</span>
            <span class="files-row-name files-row-clickable" data-person-file-download="${esc(f.name)}">${esc(f.name)}</span>
            <span class="files-row-meta muted">${esc(fileSizeLabel(f.size))}</span>
            <span class="files-row-tools">
              <button class="btn danger sm" data-person-file-delete="${esc(f.name)}" title="ลบ">${icon('trash')}</button>
            </span>
          </div>`).join('')}</div>`;

  return `
    <div class="section">
      <button type="button" class="btn outline sm" data-goto="${esc(teamKey)}">‹ กลับไปหน้าทีม</button>

      <div class="person-header card">
        <div class="person-photo">
          ${personPhotoUrl ? `<img src="${esc(personPhotoUrl)}" alt="">` : `<div class="person-photo-placeholder">${icon('users')}</div>`}
          <button type="button" class="btn outline sm" data-person-photo-trigger>${icon('plus')}${mb.photoName ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}</button>
          <input type="file" id="person-photo-input" accept="image/*" class="hidden">
        </div>
        <div>
          <h2 style="margin:0">${esc(mb.name)}${mb.code ? ` <span class="code-chip">${esc(mb.code)}</span>` : ''}</h2>
          <p class="muted" style="margin:4px 0 0">${esc(team.name)}${mb.role ? ' · ' + esc(mb.role) : ''}</p>
        </div>
      </div>

      <form id="person-edit-form" class="card" style="margin-top:13px">
        <h3 class="verify-subhead" style="margin-top:0; padding-top:0; border-top:0">ข้อมูลทั่วไป</h3>
        ${personFieldHtml('pf-name', 'ชื่อ–นามสกุล', mb.name)}
        ${personFieldHtml('pf-code', 'รหัสประจำตัว', mb.code)}
        ${personFieldHtml('pf-role', 'ตำแหน่ง / หน้าที่', mb.role)}
        ${personFieldHtml('pf-mainEvent', 'รายการที่แข่ง (รายการหลัก)', mb.mainEvent, { type: 'select', options: MAIN_EVENT_LABEL })}
        <h3 class="verify-subhead">เอกสารส่วนตัว</h3>
        ${PROFILE_FIELD_LABELS.map(([k, label]) => {
          const isDate = DDMMYYYY_PROFILE_KEYS.has(k);
          return personFieldHtml(`pf-${k}`, label, isDate ? isoToDdmmyyyy(p[k]) : (p[k] || ''), { isDate });
        }).join('')}
        <div style="margin-top:14px">
          <button type="submit" class="btn primary">${icon('check')}บันทึก</button>
        </div>
      </form>

      <div class="card" style="margin-top:13px">
        <div class="section-head" style="margin-bottom:10px">
          <h3 class="verify-subhead" style="margin:0; padding-top:0; border-top:0">ไฟล์เอกสาร</h3>
          <button type="button" class="btn outline sm" data-person-files-upload-trigger>${icon('plus')}เพิ่มไฟล์</button>
        </div>
        <input type="file" id="person-files-upload-input" multiple class="hidden">
        ${filesHtml}
      </div>
    </div>`;
}

function filesNavigate(newPath) {
  filesPath = newPath;
  filesListing = null;
  render();
}

async function loadFilesListing() {
  try {
    filesListing = await api('GET', `/api/files?op=list&path=${encodeURIComponent(filesPath)}`);
  } catch (ex) {
    toast(ex.message, { bad: true });
    filesListing = { folders: [], files: [] }; // stop the render loop from re-fetching forever
  }
  render();
}

function filesBreadcrumbHtml() {
  const segments = filesPath.split('/').filter(Boolean);
  let acc = '';
  const crumbs = [{ label: 'ไฟล์เอกสาร', path: '' }];
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs.map((c, i) => i === crumbs.length - 1
    ? `<span class="files-crumb current">${esc(c.label)}</span>`
    : `<button class="files-crumb" data-files-nav="${esc(c.path)}">${esc(c.label)}</button><span class="files-crumb-sep">/</span>`
  ).join('');
}

function renderFiles() {
  if (!filesListing) {
    loadFilesListing(); // fire-and-forget; re-renders itself once the listing arrives
    return `
      <div class="section">
        <div class="section-head"><h2>${icon('folder')}ไฟล์เอกสาร</h2></div>
        <div class="loading">กำลังโหลด…</div>
      </div>`;
  }

  const { folders, files } = filesListing;
  const empty = !folders.length && !files.length;

  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('folder')}ไฟล์เอกสาร</h2>
        <div class="head-actions">
          <button class="btn outline sm admin-only" data-files-mkdir>${icon('plus')}โฟลเดอร์ใหม่</button>
          <button class="btn primary sm admin-only" data-files-upload-trigger>${icon('plus')}อัปโหลดไฟล์</button>
        </div>
      </div>
      <input type="file" id="files-upload-input" class="hidden" multiple>
      <div class="files-breadcrumb">${filesBreadcrumbHtml()}</div>
      <div class="card files-browser">
        ${empty ? '<p class="muted" style="padding:6px 0">โฟลเดอร์นี้ว่างเปล่า</p>' : ''}
        ${folders.map((f) => `
          <div class="files-row">
            <span class="files-row-icon">${icon('folder')}</span>
            <span class="files-row-name files-row-clickable" data-files-nav="${esc(filesPath ? filesPath + '/' + f.name : f.name)}">${esc(f.name)}</span>
            <span class="files-row-tools admin-only">
              <button class="btn danger sm" data-files-delete="folder:${esc(f.name)}" title="ลบโฟลเดอร์">${icon('trash')}</button>
            </span>
          </div>`).join('')}
        ${files.map((f) => `
          <div class="files-row">
            <span class="files-row-icon">${icon('clipboard')}</span>
            <span class="files-row-name files-row-clickable" data-files-download="${esc(f.name)}">${esc(f.name)}</span>
            <span class="files-row-meta muted">${esc(fileSizeLabel(f.size))}</span>
            <span class="files-row-tools admin-only">
              <button class="btn danger sm" data-files-delete="file:${esc(f.name)}" title="ลบไฟล์">${icon('trash')}</button>
            </span>
          </div>`).join('')}
      </div>
      <p class="muted" style="margin-top:12px">ทุกคนดาวน์โหลดได้ — อัปโหลด/ลบ/จัดการโฟลเดอร์ได้เฉพาะผู้ดูแล</p>
    </div>`;
}

function renderUpdates() {
  const seen = loadSeen();
  return `
    <div class="section">
      <div class="section-head">
        <h2>${icon('megaphone')}ประกาศและอัปเดตทั้งหมด</h2>
        <div class="head-actions">
          <button class="btn outline sm" data-mark-read>${icon('check')}อ่านแล้วทั้งหมด</button>
          <button class="btn primary sm admin-only" data-new-post>${icon('plus')}ประกาศใหม่</button>
        </div>
      </div>
      ${state.announcements.map((p) => postHtml(p, seen)).join('')
        || '<div class="card muted">ยังไม่มีประกาศ</div>'}
    </div>`;
}

function render() {
  if (!state) return;
  document.body.classList.toggle('is-admin', !!state.admin);

  el('site-title').textContent = state.meta.title;
  el('site-subtitle').textContent = state.meta.subtitle;
  el('footer-org').textContent = state.meta.organizer;
  el('footer-rev').textContent = `เวอร์ชันข้อมูล #${state.rev}`
    + (state.updatedAt ? ` · อัปเดต ${relTime(state.updatedAt)}` : '');

  const adminBtn = el('btn-admin');
  adminBtn.innerHTML = icon(state.admin ? 'unlock' : 'lock')
    + `<span class="btn-admin-label">${state.admin ? 'ออกจากระบบ' : 'ผู้ดูแล'}</span>`;
  adminBtn.classList.toggle('on', !!state.admin);

  renderCountdown();
  refreshUnreadUi();

  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);

  const adminBar = state.admin ? `
    <div class="admin-bar">
      ${icon('unlock')}<span><strong>โหมดผู้ดูแล</strong> — คุณแก้ไขข้อมูลได้</span>
      <span class="spacer"></span>
      <button class="btn primary sm" data-new-post>${icon('plus')}ประกาศใหม่</button>
      <button class="btn outline sm" data-logout>${icon('logout')}ออกจากระบบ</button>
    </div>` : '';

  const body =
    view === 'overview'  ? renderOverview()  :
    view === 'schedule'  ? renderSchedule()  :
    view === 'timeline'  ? renderTimeline()  :
    view === 'itinerary' ? renderItinerary() :
    view === 'travel'    ? renderTravel()    :
    view === 'files'     ? renderFiles()     :
    view === 'verify'    ? renderVerify()    :
    view === 'person'    ? renderPersonPage() :
    view === 'updates'   ? renderUpdates()   :
    state.teams[view]    ? renderTeam(view)  : renderOverview();

  el('app').innerHTML = adminBar + body;
  applyLocalChecklist();
}

function setView(next) {
  if (next === 'files' && view !== 'files') { filesPath = ''; filesListing = null; }
  view = next;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (next === 'updates') {
    // Let the "ใหม่" chips register visually before clearing them.
    setTimeout(() => { markAllSeen(); refreshUnreadUi(); }, 1800);
  }
}

/* ------------------------------------------- checklist (per-device, local) */

const CHECK_KEY = 'wrg2026.checklist.v1';
function localChecks() {
  try { return JSON.parse(localStorage.getItem(CHECK_KEY)) || {}; } catch { return {}; }
}
function applyLocalChecklist() {
  const saved = localChecks();
  for (const box of document.querySelectorAll('[data-check]')) {
    if (saved[box.dataset.check] !== undefined) box.checked = saved[box.dataset.check];
    const label = box.nextElementSibling;
    if (label) label.style.cssText = box.checked
      ? 'font-size:.9rem;color:var(--muted);text-decoration:line-through'
      : 'font-size:.9rem';
  }
}

/* --------------------------------------------------------------- data sync */

async function loadState({ notify = false } = {}) {
  const prev = state ? new Map(state.announcements.map((a) => [a.id, a.updatedAt])) : null;
  const next = await api('GET', '/api/state');
  const firstLoad = !state;
  state = next;

  if (firstLoad && !localStorage.getItem(SEEN_KEY)) markAllSeen(); // don't flood a first-time visitor

  if (notify && prev) {
    const fresh = state.announcements.filter((a) => prev.get(a.id) !== a.updatedAt);
    if (fresh.length) {
      pushNotifications(fresh);
      toast(`มีอัปเดตใหม่ ${fresh.length} รายการ`, { icon: 'megaphone' });
    }
  }
  render();
}

async function poll() {
  try {
    const { rev, admin } = await api('GET', '/api/rev');
    if (state && (rev !== state.rev || admin !== state.admin)) await loadState({ notify: true });
  } catch { /* offline — retry next tick */ }
}

setInterval(poll, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
setInterval(() => { if (state) renderCountdown(); }, 30000);

/* ------------------------------------------------------------------ modals */

const openModal = (id) => el(id).classList.remove('hidden');
const closeModal = (id) => el(id).classList.add('hidden');

for (const m of document.querySelectorAll('.modal')) {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
});

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = el('login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/login', { password: el('login-password').value });
    el('login-password').value = '';
    closeModal('modal-login');
    await loadState();
    toast('เข้าสู่ระบบสำเร็จ', { icon: 'unlock' });
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

async function doLogout() {
  await api('POST', '/api/logout');
  await loadState();
  toast('ออกจากระบบแล้ว', { icon: 'lock' });
}

el('btn-admin').addEventListener('click', async () => {
  if (state?.admin) return doLogout();
  openModal('modal-login');
  setTimeout(() => el('login-password').focus(), 50);
});

el('btn-notify').addEventListener('click', toggleNotify);

/* announcement editor */
function openPostEditor(post) {
  el('post-title').textContent = post ? 'แก้ไขประกาศ' : 'ประกาศใหม่';
  el('post-id').value = post?.id || '';
  el('post-heading').value = post?.title || '';
  el('post-body').value = post?.body || '';
  el('post-level').value = post?.level || 'info';
  el('post-teams').value = (post?.teams || ['all'])[0];
  el('post-pinned').checked = !!post?.pinned;
  el('post-error').classList.add('hidden');
  openModal('modal-post');
  setTimeout(() => el('post-heading').focus(), 50);
}

el('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = el('post-error');
  err.classList.add('hidden');
  const id = el('post-id').value;
  const payload = {
    title: el('post-heading').value.trim(),
    body: el('post-body').value.trim(),
    level: el('post-level').value,
    teams: [el('post-teams').value],
    pinned: el('post-pinned').checked,
  };
  try {
    if (id) await api('PUT', '/api/announcements', { id, ...payload });
    else await api('POST', '/api/announcements', payload);
    closeModal('modal-post');
    await loadState();
    markAllSeen();          // the author has obviously seen their own post
    refreshUnreadUi();
    toast(id ? 'แก้ไขประกาศแล้ว' : 'เผยแพร่ประกาศแล้ว', { icon: 'check' });
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

/* ------------------------------------------- record editor (form, not JSON)
   Members, matches and checklist items are edited through real forms. Records
   are addressed by list index, so no client-side id generation is needed. */

const CHECK_TAG_LABEL = { '': 'ยังไม่ระบุ', carry: 'นำขึ้นเครื่อง', cargo: 'โหลดใต้เครื่อง' };

const RECORD_SPECS = {
  /* object: true edits the team record itself rather than a list inside it */
  teamInfo: {
    object: true,
    editTitle: 'แก้ไขข้อมูลทีม',
    fields: [
      { k: 'name', label: 'ชื่อทีม', type: 'text', required: true },
      { k: 'nameTh', label: 'ชื่อทีม (ภาษาไทย)', type: 'text' },
      { k: 'code', label: 'รหัสทีม', type: 'text', placeholder: 'เช่น SR-001 (ตามที่ผู้จัดกำหนด)' },
      { k: 'gameDay', label: 'วันแข่ง', type: 'text', placeholder: 'เช่น 18 พ.ย. 2569 · GAME DAY 02' },
      { k: 'arena', label: 'สนาม', type: 'text', placeholder: 'เช่น Chiba Port Arena' },
      { k: 'summary', label: 'คำอธิบายสั้น ๆ', type: 'textarea' },
    ],
  },
  member: {
    list: 'members',
    addTitle: 'เพิ่มสมาชิก', editTitle: 'แก้ไขสมาชิก',
    label: (r) => r.name,
    fields: [
      { k: 'name', label: 'ชื่อ–นามสกุล', type: 'text', required: true },
      { k: 'code', label: 'รหัสประจำตัว', type: 'text', placeholder: 'เช่น TH-0123' },
      { k: 'role', label: 'ตำแหน่ง / หน้าที่', type: 'text', placeholder: 'เช่น หัวหน้าทีม, โปรแกรมเมอร์' },
      { k: 'mainEvent', label: 'รายการที่แข่ง (รายการหลัก)', type: 'select', options: MAIN_EVENT_LABEL },
      // everything below is gated behind the member's own DOB on the public
      // "ตรวจสอบข้อมูล" tab — see PROFILE_FIELD_LABELS / /api/verify.
      { k: 'profile.school', label: 'โรงเรียน / สังกัด', type: 'text' },
      { k: 'profile.passportNo', label: 'เลขพาสปอร์ต', type: 'text' },
      { k: 'profile.passportIssue', label: 'วันออกพาสปอร์ต', type: 'ddmmyyyy', placeholder: 'วว/ดด/ปปปป' },
      { k: 'profile.passportExpiry', label: 'วันหมดอายุพาสปอร์ต', type: 'ddmmyyyy', placeholder: 'วว/ดด/ปปปป' },
      { k: 'profile.dob', label: 'วันเกิด', type: 'ddmmyyyy', placeholder: 'วว/ดด/ปปปป' },
      { k: 'profile.city', label: 'จังหวัด/เมือง', type: 'text' },
      { k: 'profile.shirtSize', label: 'ไซส์เสื้อ', type: 'text' },
      { k: 'profile.foodNote', label: 'อาหาร / ข้อจำกัดด้านอาหาร', type: 'text', placeholder: 'ไม่บังคับ' },
      { k: 'profile.nationalId', label: 'เลขบัตรประชาชน', type: 'text' },
    ],
  },
  /* a member's extra events (e.g. SumoBOT Junior) — nested one level inside
     their record, same shape as team matches, so each carries its own time. */
  memberEvent: {
    nested: true,
    list: 'events',
    addTitle: 'เพิ่มรายการแข่งอื่น', editTitle: 'แก้ไขรายการแข่งอื่น',
    label: (r) => r.label,
    fields: [
      { k: 'label', label: 'ชื่อรายการแข่ง', type: 'text', required: true, placeholder: 'เช่น SumoBOT Junior (First Round)' },
      { k: 'date', label: 'วันที่', type: 'date' },
      { k: 'time', label: 'เวลา', type: 'text', placeholder: 'เช่น 09:30–11:00' },
      { k: 'type', label: 'ประเภทรายการ', type: 'select', options: TYPE_LABEL },
      { k: 'status', label: 'สถานะ', type: 'select', options: STATUS_LABEL },
      { k: 'note', label: 'หมายเหตุ', type: 'textarea', placeholder: 'ไม่บังคับ' },
    ],
  },
  match: {
    list: 'matches',
    addTitle: 'เพิ่มรายการแข่ง', editTitle: 'แก้ไขรายการแข่ง',
    label: (r) => r.label,
    fields: [
      { k: 'label', label: 'ชื่อรายการ', type: 'text', required: true, placeholder: 'เช่น Soccer 4x4 — First round' },
      { k: 'date', label: 'วันที่', type: 'date' },
      { k: 'time', label: 'เวลา', type: 'text', placeholder: 'เช่น 09:00–12:00' },
      { k: 'type', label: 'ประเภทรายการ', type: 'select', options: TYPE_LABEL },
      { k: 'status', label: 'สถานะ', type: 'select', options: STATUS_LABEL },
      { k: 'note', label: 'หมายเหตุ', type: 'textarea', placeholder: 'ไม่บังคับ' },
    ],
  },
  check: {
    list: 'checklist',
    addTitle: 'เพิ่มรายการที่ต้องเตรียม', editTitle: 'แก้ไขรายการ',
    label: (r) => r.text,
    fields: [
      { k: 'text', label: 'สิ่งที่ต้องเตรียม', type: 'text', required: true, placeholder: 'เช่น แบตเตอรี่สำรอง' },
      { k: 'tag', label: 'นำขึ้นเครื่องหรือโหลดใต้เครื่อง', type: 'select', options: CHECK_TAG_LABEL },
    ],
  },
};

/** Field keys may be dotted ("profile.dob") so one flat form can edit a
    nested object — getPath reads it for pre-fill, unflatten rebuilds the
    nested shape before saving. */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function unflatten(flat) {
  const out = {};
  for (const [path, val] of Object.entries(flat)) {
    const parts = path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= {});
    node[parts[parts.length - 1]] = val;
  }
  return out;
}

let recordTarget = null;   // { teamKey, kind, index, memberIndex }  index < 0 === new

/** memberIndex is only meaningful for spec.nested kinds (memberEvent). */
function openRecordEditor(teamKey, kind, index, memberIndex = null) {
  const spec = RECORD_SPECS[kind];
  if (!spec) return;
  const isNew = !spec.object && index < 0;
  const owner = spec.nested ? state.teams[teamKey].members[memberIndex] : state.teams[teamKey];
  const found = spec.object ? owner : isNew ? {} : (owner[spec.list] || [])[index];
  // a legacy plain-string event must pre-fill into "label", not read as {}
  const rec = typeof found === 'string' ? { label: found } : (found || {});
  recordTarget = { teamKey, kind, index, memberIndex };

  el('record-title').textContent = isNew ? spec.addTitle : spec.editTitle;

  // Adding a memberEvent starts with a picker of competition NAMES only (not
  // one option per schedule row) — picking a name queues every occurrence of
  // that exact name in the schedule (e.g. a first round + a final both get
  // added), so the admin doesn't add each round by hand. "พิมพ์เอง" switches
  // to the plain manual form for anything not on the schedule.
  const usePicker = kind === 'memberEvent' && isNew;
  const pickerHtml = usePicker ? `
    <label for="schedule-picker">เลือกรายการแข่งขัน</label>
    <select id="schedule-picker">
      <option value="">— พิมพ์เอง (กำหนดเอง) —</option>
      ${distinctCompetitions().map((c, i) => `<option value="${i}">${esc(c.event)}</option>`).join('')}
    </select>
    <p class="muted" id="schedule-picker-hint" style="margin-top:6px">
      เลือกแล้วจะเพิ่มเวลาแข่งของรายการนั้นให้ครบทุกรอบที่มีในตารางแข่งขันโดยอัตโนมัติ
    </p>
    <div id="schedule-picker-preview"></div>` : '';

  const fieldsHtml = spec.fields.map((f) => {
    const raw = getPath(rec, f.k) ?? '';
    // tags are stored as an array; the input itself is a plain comma-separated text box
    // ddmmyyyy is stored as ISO but edited as dd/mm/yyyy text
    const val = f.type === 'tags' && Array.isArray(raw) ? raw.join(', ')
      : f.type === 'ddmmyyyy' ? isoToDdmmyyyy(raw)
      : raw;
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    const req = f.required ? ' required' : '';
    let input;
    if (f.type === 'select') {
      // fall back to the first option's key when the record has no value yet
      const selectedKey = val || Object.keys(f.options)[0];
      input = `<select data-f="${f.k}">${Object.entries(f.options).map(([k, v]) =>
        `<option value="${k}"${k === selectedKey ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea data-f="${f.k}" rows="3"${ph}>${esc(val)}</textarea>`;
    } else if (f.type === 'ddmmyyyy') {
      input = `<input type="text" data-f="${f.k}" value="${esc(val)}"${ph}${req}` +
        ' pattern="\\d{1,2}/\\d{1,2}/\\d{4}">';
    } else {
      input = `<input type="${f.type === 'tags' ? 'text' : f.type}" data-f="${f.k}" value="${esc(val)}"${ph}${req}>`;
    }
    return `<label>${esc(f.label)}</label>${input}`;
  }).join('');

  // starts visible: the picker defaults to "" (พิมพ์เอง), which IS manual mode
  el('record-fields').innerHTML = pickerHtml
    + (usePicker ? `<div id="manual-fields">${fieldsHtml}</div>` : fieldsHtml);

  if (usePicker) {
    const manual = el('manual-fields');
    const preview = el('schedule-picker-preview');
    // required fields must be un-required while hidden — a hidden-but-required
    // input makes the browser try (and fail) to focus it for validation,
    // throwing "An invalid form control is not focusable" on submit.
    const requiredEls = [...manual.querySelectorAll('[required]')];
    const setManualMode = (isManual) => {
      manual.classList.toggle('hidden', !isManual);
      requiredEls.forEach((elm) => elm.toggleAttribute('required', isManual));
    };

    el('schedule-picker').addEventListener('change', (e) => {
      if (e.target.value === '') {
        setManualMode(true);
        preview.innerHTML = '';
        return;
      }
      setManualMode(false);
      const comp = distinctCompetitions()[Number(e.target.value)];
      preview.innerHTML = `<p class="muted" style="margin-top:8px">
        จะเพิ่ม ${comp.occurrences.length} ช่วงเวลา:</p>
        <div class="picker-preview-list">${comp.occurrences.map((o) =>
          `<span class="chip">${esc(o.dayLabel)} · ${esc(o.time)}</span>`).join('')}</div>`;
    });
  }

  el('record-error').classList.add('hidden');
  openModal('modal-record');
  setTimeout(() => el('record-fields').querySelector('input,textarea,select')?.focus(), 50);
}

/** Mutate one list on a team and PUT the whole team back. */
async function saveTeamList(teamKey, mutate) {
  const team = structuredClone(state.teams[teamKey]);
  mutate(team);
  await api('PUT', '/api/team', { key: teamKey, team });
  await loadState();
}

el('record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = el('record-error');
  err.classList.add('hidden');
  const { teamKey, kind, index, memberIndex } = recordTarget;
  const spec = RECORD_SPECS[kind];

  // adding a memberEvent via the picker (not "พิมพ์เอง") queues one entry
  // per occurrence of that competition in the schedule, in a single save.
  const picker = el('schedule-picker');
  if (picker && picker.value !== '') {
    const comp = distinctCompetitions()[Number(picker.value)];
    try {
      await saveTeamList(teamKey, (team) => {
        const owner = team.members[memberIndex];
        if (!owner.events) owner.events = [];
        for (const o of comp.occurrences) {
          owner.events.push({ label: comp.event, date: o.date, time: o.time, status: 'scheduled', type: 'competition', note: '' });
        }
      });
      closeModal('modal-record');
      toast(`เพิ่ม ${comp.occurrences.length} ช่วงเวลาแล้ว`, { icon: 'check' });
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
    return;
  }

  const flat = {};
  for (const f of spec.fields) {
    const raw = el('record-fields').querySelector(`[data-f="${f.k}"]`).value.trim();
    if (f.type === 'tags') {
      flat[f.k] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (f.type === 'ddmmyyyy') {
      if (raw && !ddmmyyyyToIso(raw)) {
        err.textContent = `รูปแบบวันที่ไม่ถูกต้อง (${f.label}) — ใช้ วว/ดด/ปปปป`;
        err.classList.remove('hidden');
        return;
      }
      flat[f.k] = ddmmyyyyToIso(raw);
    } else {
      flat[f.k] = raw;
    }
  }
  const rec = unflatten(flat);
  if ((kind === 'match' || kind === 'memberEvent') && !rec.status) rec.status = 'scheduled';

  try {
    await saveTeamList(teamKey, (team) => {
      if (spec.object) { Object.assign(team, rec); return; }
      const owner = spec.nested ? team.members[memberIndex] : team;
      if (!owner[spec.list]) owner[spec.list] = [];
      const list = owner[spec.list];
      if (index < 0) list.push(rec);
      else list[index] = { ...list[index], ...rec };
    });
    closeModal('modal-record');
    toast(!spec.object && index < 0 ? 'เพิ่มแล้ว' : 'บันทึกแล้ว', { icon: 'check' });
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

async function deleteRecord(teamKey, kind, index, memberIndex = null) {
  const spec = RECORD_SPECS[kind];
  const owner = spec.nested ? state.teams[teamKey].members[memberIndex] : state.teams[teamKey];
  const rec = (owner[spec.list] || [])[index];
  if (!rec) return;
  if (!confirm(`ลบ “${spec.label(rec) || 'รายการนี้'}” หรือไม่?`)) return;
  try {
    await saveTeamList(teamKey, (team) => {
      const o = spec.nested ? team.members[memberIndex] : team;
      o[spec.list].splice(index, 1);
    });
    toast('ลบแล้ว', { icon: 'trash' });
  } catch (ex) { toast(ex.message, { bad: true }); }
}

/* raw JSON editor */
let jsonTarget = null;

function openJsonEditor(kind, key) {
  jsonTarget = { kind, key };
  const titles = {
    itinerary: 'แก้ไขกำหนดการเดินทาง', schedule: 'แก้ไขตารางแข่งขัน',
    notes: 'แก้ไขหมายเหตุ', meta: 'แก้ไขข้อมูลทริป', team: 'แก้ไขข้อมูลทีม',
    travel: 'แก้ไขแผนเที่ยววันอิสระ',
  };
  const hints = {
    team: 'แก้ไขสมาชิก (members), รายการแข่ง (matches) และเช็กลิสต์ (checklist) ได้ที่นี่',
    schedule: 'ใส่ "highlight" เป็น "ballfighting" / "soccer4x4" / "both" เพื่อไฮไลต์แถวของทีมเรา',
    itinerary: 'แต่ละวันมี label, title และ items (time + text)',
    notes: 'รายการข้อความ (array ของ string)',
    meta: 'ข้อมูลหัวเรื่อง สนาม โรงแรม เที่ยวบิน และวันออกเดินทาง (departISO)',
    travel: 'มี note (ข้อความอธิบาย) และ wanderlogUrl (ลิงก์ทริปจาก Wanderlog — ตั้งค่าการแชร์เป็น "Anyone with the link can view" ก่อนคัดลอกลิงก์มาใส่)',
  };
  el('json-title').textContent = titles[kind] || 'แก้ไขข้อมูล';
  el('json-hint').textContent = hints[kind] || '';
  el('json-text').value = JSON.stringify(kind === 'team' ? state.teams[key] : state[kind], null, 2);
  el('json-error').classList.add('hidden');
  openModal('modal-json');
}

el('json-save').addEventListener('click', async () => {
  const err = el('json-error');
  err.classList.add('hidden');
  let value;
  try {
    value = JSON.parse(el('json-text').value);
  } catch (ex) {
    err.textContent = 'รูปแบบ JSON ไม่ถูกต้อง: ' + ex.message;
    err.classList.remove('hidden');
    return;
  }
  try {
    if (jsonTarget.kind === 'team') await api('PUT', '/api/team', { key: jsonTarget.key, team: value });
    else await api('PUT', '/api/section', { section: jsonTarget.kind, value });
    closeModal('modal-json');
    await loadState();
    toast('บันทึกแล้ว', { icon: 'check' });
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

/* ------------------------------------------------------------ event routing */

document.addEventListener('click', (e) => {
  const brand = e.target.closest('.brand[data-goto]');
  if (brand) { e.preventDefault(); setView(brand.dataset.goto); return; }
  const tab = e.target.closest('.tab');
  if (tab) setView(tab.dataset.view);
});

el('app').addEventListener('click', async (e) => {
  const t = e.target.closest(
    '[data-goto],[data-new-post],[data-edit-post],[data-del-post],[data-edit-json],[data-edit-team],'
    + '[data-logout],[data-mark-read],[data-rec],[data-rec-del],[data-rec-add],'
    + '[data-files-nav],[data-files-mkdir],[data-files-upload-trigger],[data-files-download],[data-files-delete],'
    + '[data-verify-reset],[data-verify-file-download],[data-copy-verify-link],'
    + '[data-goto-person],[data-person-photo-trigger],[data-person-files-upload-trigger],'
    + '[data-person-file-download],[data-person-file-delete]'
  );
  if (!t) return;

  if (t.dataset.filesNav !== undefined) return filesNavigate(t.dataset.filesNav);

  if (t.hasAttribute('data-verify-reset')) {
    verifyUnlocked = null;
    verifyDob = '';
    verifyError = '';
    verifyFiles = null;
    verifyPhotoUrl = null;
    render();
    return;
  }

  if (t.dataset.verifyFileDownload) {
    try {
      const { signedUrl } = await api('POST', '/api/verify', { op: 'files-download-url', dob: verifyDob, name: t.dataset.verifyFileDownload });
      window.open(signedUrl, '_blank', 'noopener');
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  if (t.dataset.gotoPerson) {
    const [teamKey, memberIndex] = t.dataset.gotoPerson.split(':');
    goToPerson(teamKey, Number(memberIndex));
    return;
  }

  if (t.hasAttribute('data-person-photo-trigger')) return el('person-photo-input').click();
  if (t.hasAttribute('data-person-files-upload-trigger')) return el('person-files-upload-input').click();

  if (t.dataset.personFileDownload && personView) {
    try {
      const { signedUrl } = await api('POST', '/api/verify', { op: 'admin-files-download-url', ...personView, name: t.dataset.personFileDownload });
      window.open(signedUrl, '_blank', 'noopener');
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  if (t.dataset.personFileDelete && personView) {
    const name = t.dataset.personFileDelete;
    if (!confirm(`ลบไฟล์ "${name}" ถาวรหรือไม่?`)) return;
    try {
      await api('POST', '/api/verify', { op: 'admin-files-delete', ...personView, name });
      toast('ลบแล้ว', { icon: 'trash' });
      personFilesList = null;
      loadPersonFilesList();
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  if (t.hasAttribute('data-copy-verify-link')) {
    const link = `${location.origin}${location.pathname}?verify=1`;
    try {
      await navigator.clipboard.writeText(link);
      toast('คัดลอกลิงก์แล้ว — ส่งให้สมาชิกทีมได้เลย', { icon: 'check' });
    } catch {
      toast(link, { icon: 'check' }); // clipboard blocked — show it so it can be copied by hand
    }
    return;
  }

  if (t.hasAttribute('data-files-mkdir')) {
    const name = prompt('ตั้งชื่อโฟลเดอร์:');
    if (!name || !name.trim()) return;
    try {
      await api('POST', '/api/files', { op: 'mkdir', path: filesPath, name: name.trim() });
      filesListing = null; render();
      toast('สร้างโฟลเดอร์แล้ว', { icon: 'check' });
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  if (t.hasAttribute('data-files-upload-trigger')) return el('files-upload-input').click();

  if (t.dataset.filesDownload !== undefined) {
    try {
      const { signedUrl } = await api('GET',
        `/api/files?op=download-url&path=${encodeURIComponent(filesPath)}&name=${encodeURIComponent(t.dataset.filesDownload)}`);
      window.open(signedUrl, '_blank', 'noopener');
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  if (t.dataset.filesDelete) {
    const [kind, name] = t.dataset.filesDelete.split(':');
    const label = kind === 'folder' ? `โฟลเดอร์ "${name}" และทุกไฟล์ข้างใน` : `ไฟล์ "${name}"`;
    if (!confirm(`ลบ${label}ถาวรหรือไม่?`)) return;
    try {
      await api('POST', '/api/files', { op: 'delete', path: filesPath, name, type: kind });
      filesListing = null; render();
      toast('ลบแล้ว', { icon: 'trash' });
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  /* nested (memberEvent) attributes carry a 4th segment: memberIndex before
     the record index — teamKey:kind:memberIndex[:index] */
  if (t.dataset.recAdd) {
    const parts = t.dataset.recAdd.split(':');
    if (parts.length === 3) return openRecordEditor(parts[0], parts[1], -1, Number(parts[2]));
    return openRecordEditor(parts[0], parts[1], -1);
  }
  if (t.dataset.rec) {
    const parts = t.dataset.rec.split(':');
    if (parts.length === 4) return openRecordEditor(parts[0], parts[1], Number(parts[3]), Number(parts[2]));
    return openRecordEditor(parts[0], parts[1], Number(parts[2]));
  }
  if (t.dataset.recDel) {
    const parts = t.dataset.recDel.split(':');
    if (parts.length === 4) return deleteRecord(parts[0], parts[1], Number(parts[3]), Number(parts[2]));
    return deleteRecord(parts[0], parts[1], Number(parts[2]));
  }

  if (t.dataset.goto) return setView(t.dataset.goto);
  if (t.hasAttribute('data-new-post')) return openPostEditor(null);
  if (t.dataset.editPost) return openPostEditor(state.announcements.find((a) => a.id === t.dataset.editPost));
  if (t.dataset.editJson) return openJsonEditor(t.dataset.editJson);
  if (t.dataset.editTeam) return openJsonEditor('team', t.dataset.editTeam);

  if (t.hasAttribute('data-mark-read')) {
    markAllSeen(); refreshUnreadUi(); render();
    return toast('ทำเครื่องหมายว่าอ่านแล้วทั้งหมด', { icon: 'check' });
  }

  if (t.hasAttribute('data-logout')) return doLogout();

  if (t.dataset.delPost) {
    if (!confirm('ลบประกาศนี้ถาวรหรือไม่?')) return;
    try {
      await api('DELETE', '/api/announcements', { id: t.dataset.delPost });
      await loadState();
      toast('ลบประกาศแล้ว', { icon: 'trash' });
    } catch (ex) { toast(ex.message, { bad: true }); }
  }
});

el('app').addEventListener('change', async (e) => {
  /* person page: profile photo upload */
  if (e.target.id === 'person-photo-input' && personView) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const oldName = state.teams[personView.teamKey]?.members[personView.memberIndex]?.photoName;
    const newName = `photo-${Date.now()}-${file.name}`;
    try {
      const { signedUrl } = await api('POST', '/api/verify', { op: 'admin-files-upload-url', ...personView, name: newName });
      const putRes = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      if (!putRes.ok) throw new Error('อัปโหลดไม่สำเร็จ');

      await saveTeamList(personView.teamKey, (team) => { team.members[personView.memberIndex].photoName = newName; });
      if (oldName) {
        try { await api('POST', '/api/verify', { op: 'admin-files-delete', ...personView, name: oldName }); }
        catch { /* old photo left orphaned — harmless, not worth failing the upload over */ }
      }
      toast('อัปโหลดรูปแล้ว', { icon: 'check' });
      personPhotoUrl = null;
      loadPersonPhoto();
      loadPersonFilesList();
    } catch (ex) { toast(ex.message, { bad: true }); }
    return;
  }

  /* person page: document upload */
  if (e.target.id === 'person-files-upload-input' && personView) {
    const fileList = Array.from(e.target.files || []);
    e.target.value = '';
    if (!fileList.length) return;
    for (const file of fileList) {
      try {
        const { signedUrl } = await api('POST', '/api/verify', { op: 'admin-files-upload-url', ...personView, name: file.name });
        const putRes = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
        if (!putRes.ok) throw new Error('อัปโหลดไม่สำเร็จ');
        toast(`อัปโหลด "${file.name}" สำเร็จ`, { icon: 'check' });
      } catch (ex) { toast(`${file.name}: ${ex.message}`, { bad: true }); }
    }
    personFilesList = null;
    loadPersonFilesList();
    return;
  }

  /* file-manager upload */
  if (e.target.id === 'files-upload-input') {
    const fileList = Array.from(e.target.files || []);
    e.target.value = '';
    if (!fileList.length) return;
    for (const file of fileList) {
      try {
        const { signedUrl } = await api('POST', '/api/files', { op: 'upload-url', path: filesPath, name: file.name });
        const putRes = await fetch(signedUrl, {
          method: 'PUT',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!putRes.ok) throw new Error('อัปโหลดไม่สำเร็จ');
        toast(`อัปโหลด "${file.name}" สำเร็จ`, { icon: 'check' });
      } catch (ex) { toast(`${file.name}: ${ex.message}`, { bad: true }); }
    }
    filesListing = null; render();
    return;
  }

  /* local-only packing checklist */
  const check = e.target.dataset.check;
  if (check) {
    const saved = localChecks();
    saved[check] = e.target.checked;
    try { localStorage.setItem(CHECK_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    applyLocalChecklist();
    return;
  }

  /* admin: quick match-status change */
  const ms = e.target.dataset.matchStatus;
  if (ms) {
    const [teamKey, matchId] = ms.split(':');
    const team = structuredClone(state.teams[teamKey]);
    const match = team.matches.find((m) => m.id === matchId);
    if (!match) return;
    match.status = e.target.value;
    try {
      await api('PUT', '/api/team', { key: teamKey, team });
      await loadState();
      toast('อัปเดตสถานะแล้ว', { icon: 'check' });
    } catch (ex) { toast(ex.message, { bad: true }); }
  }
});

async function loadVerifyFiles() {
  try {
    const res = await api('POST', '/api/verify', { op: 'files-list', dob: verifyDob });
    verifyFiles = res.files;
  } catch {
    verifyFiles = []; // not fatal — the rest of the page still works without it
  }
  render();
}

async function loadVerifyPhoto() {
  if (!verifyUnlocked?.photoName) return;
  try {
    const res = await api('POST', '/api/verify', { op: 'files-download-url', dob: verifyDob, name: verifyUnlocked.photoName });
    verifyPhotoUrl = res.signedUrl;
  } catch { /* photo just won't show — not fatal */ }
  render();
}

el('app').addEventListener('submit', async (e) => {
  if (e.target.id === 'verify-dob-form') {
    e.preventDefault();
    const dob = ddmmyyyyToIso(el('verify-dob').value);
    if (!dob) {
      verifyError = 'รูปแบบวันเกิดไม่ถูกต้อง — ใช้ วว/ดด/ปปปป';
      return render();
    }
    try {
      const res = await api('POST', '/api/verify', { op: 'lookup', dob });
      verifyUnlocked = {
        teams: res.teams, // [{ teamKey, memberIndex, teamLabel, matches }, …] — 2+ if on multiple rosters
        name: res.name, code: res.code, role: res.role, mainEvent: res.mainEvent,
        photoName: res.photoName, events: res.events, profile: res.profile,
      };
      verifyDob = dob;
      verifyError = '';
      verifyFiles = null;
      verifyPhotoUrl = null;
      render();
      loadVerifyFiles();
      if (res.photoName) loadVerifyPhoto();
    } catch (ex) {
      verifyError = ex.message;
      render();
    }
    return;
  }

  if (e.target.id === 'person-edit-form' && personView) {
    e.preventDefault();
    const patch = {
      name: el('pf-name').value.trim(),
      code: el('pf-code').value.trim(),
      role: el('pf-role').value.trim(),
      mainEvent: el('pf-mainEvent').value,
      profile: {},
    };
    for (const [k] of PROFILE_FIELD_LABELS) {
      const raw = el(`pf-${k}`).value.trim();
      patch.profile[k] = DDMMYYYY_PROFILE_KEYS.has(k) ? ddmmyyyyToIso(raw) : raw;
    }
    try {
      await saveTeamList(personView.teamKey, (team) => {
        Object.assign(team.members[personView.memberIndex], patch);
      });
      toast('บันทึกข้อมูลแล้ว', { icon: 'check' });
    } catch (ex) {
      toast(ex.message, { bad: true });
    }
    return;
  }
});

/* --------------------------------------------------------------- brand mark */

/* Try logo.svg, then logo.png, then fall back to a plain "WRG" tile so the
   header never shows a broken image. Drop your file in public/ to use it. */
(() => {
  const img = el('brand-logo');
  const mark = el('brand-mark');
  const candidates = ['logo.svg', 'logo.png'];
  let i = 0;

  const tryNext = () => {
    if (i < candidates.length) { img.src = candidates[i++]; return; }
    img.remove();
    mark.classList.add('is-fallback');
    mark.textContent = 'WRG';
  };

  img.addEventListener('error', tryNext);
  tryNext();   // the tab icon is favicon.png (square crop of the gear mark)
})();

/* -------------------------------------------------------------------- boot */

refreshNotifyButton();
loadState().catch((ex) => {
  el('app').innerHTML = `<div class="card"><p class="error">โหลดข้อมูลไม่สำเร็จ: ${esc(ex.message)}</p></div>`;
});
