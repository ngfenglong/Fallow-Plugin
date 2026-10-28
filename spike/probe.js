// THROWAWAY spike. Prints raw values only (tab ids and hostnames, never titles or full URLs).
// What this spike does to the browser: it DISCARDS tabs (probes 2, 3, 7, each behind an explicit
// confirm click) and CREATES one new tab (probe 8, chrome://settings/performance). It closes,
// moves, navigates and mutates nothing else (no tab property is ever changed).
'use strict';

const out = document.getElementById('out');
const GIB = 1024 * 1024 * 1024;

function log(...parts) {
  out.appendChild(document.createTextNode(parts.join(' ') + '\n')); // textContent semantics only
}
const J = (v) => JSON.stringify(v);
const gib = (b) => (b / GIB).toFixed(4) + ' GiB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function host(url) {
  try {
    const u = new URL(url || '');
    return u.hostname || (u.protocol + '(no host)');
  } catch (e) {
    return '(unparseable)';
  }
}

// Callback-style call so lastError and the callback argument are both visible. Times out.
function cb(fn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API call timed out after ${timeoutMs} ms (callback never fired)`)), timeoutMs);
    try {
      fn((result) => {
        clearTimeout(timer);
        const le = chrome.runtime.lastError;
        resolve({ result, lastError: le ? le.message : null });
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function wrap(name, fn) {
  log(`\n===== ${name} =====`);
  try {
    await fn();
  } catch (e) {
    log(`ERROR in ${name}: ${String((e && e.stack) || e)}`);
    if (chrome.runtime.lastError) log(`chrome.runtime.lastError: ${chrome.runtime.lastError.message}`);
  }
}

const snap = (t) => t && ({
  id: t.id, index: t.index, windowId: t.windowId, groupId: t.groupId,
  active: t.active, discarded: t.discarded, autoDiscardable: t.autoDiscardable,
  pinned: t.pinned, audible: t.audible, status: t.status, host: host(t.url),
});

// ---------- gate: explicit confirm before any discard; busy lock ----------

const bar = document.getElementById('buttons');
const gateBox = document.createElement('div');
const probeButtons = [];
let busy = false;
function setBusy(b) { busy = b; for (const x of probeButtons) x.disabled = b; }

function confirmGate(message) {
  log(message);
  return new Promise((resolve) => {
    gateBox.textContent = '';
    const yes = document.createElement('button');
    yes.textContent = 'CONFIRM: discard the tabs listed above';
    const no = document.createElement('button');
    no.textContent = 'Skip';
    const done = (v) => { gateBox.textContent = ''; log(v ? '[owner confirmed]' : '[owner skipped; nothing discarded]'); resolve(v); };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    gateBox.append(yes, no);
  });
}

// ---------- eligibility ----------

let selfTabId = null;
async function getSelf() {
  if (selfTabId === null) {
    const t = await chrome.tabs.getCurrent();
    selfTabId = t ? t.id : -999;
  }
  return selfTabId;
}
const isOurs = (t) => (t.url || '').startsWith(chrome.runtime.getURL(''));

const winCache = new Map();
async function getWin(id) {
  if (!winCache.has(id)) winCache.set(id, chrome.windows.get(id));
  return winCache.get(id);
}

// Never the probe page, never pinned/audible/discarded, http(s) only, normal non-incognito windows only.
async function baseEligible(t) {
  const self = await getSelf();
  if (t.id === self || isOurs(t) || t.pinned || t.audible || t.discarded) return false;
  if (!/^https?:/.test(t.url || '')) return false;
  const w = await getWin(t.windowId);
  return w.type === 'normal' && !w.incognito;
}

async function candidates() { // background tabs
  winCache.clear();
  const tabs = await chrome.tabs.query({});
  const res = [];
  for (const t of tabs) if (!t.active && t.autoDiscardable && (await baseEligible(t))) res.push(t);
  return res;
}

async function ensureMemoryPermission() {
  const r = await cb((c) => chrome.permissions.request({ permissions: ['system.memory'] }, c), 120000);
  log(`permissions.request(system.memory): granted=${J(r.result)} lastError=${J(r.lastError)}`);
  return r.result === true;
}

// Discard and describe exactly what happened. Returns the id to re-read.
async function doDiscard(id) {
  const r = await cb((c) => chrome.tabs.discard(id, c));
  if (r.lastError) log(`  discard(${id}): rejected via lastError: ${r.lastError}`);
  else if (!r.result) log(`  discard(${id}): no-op (callback returned no tab, no lastError)`);
  else log(`  discard(${id}): callback returned ${J(snap(r.result))}`);
  const newId = r.result && r.result.id !== undefined ? r.result.id : id;
  if (newId !== id) log(`  NOTE: returned tab id ${newId} differs from requested ${id}`);
  return newId;
}

// ---------- probes ----------

async function probe1() {
  await wrap('Probe 1: tabs.query({}) and window types', async () => {
    const tabs = await chrome.tabs.query({});
    log(`tab count: ${tabs.length}`);
    // Method A: windows.getAll with explicit windowTypes
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app', 'devtools'] });
    log(`[A] windows.getAll(windowTypes incl. app): ${wins.length} windows`);
    for (const w of wins) {
      log(`  window ${w.id}: type=${w.type} state=${w.state} incognito=${w.incognito} tabs=${w.tabs.length} groupIds=${J([...new Set(w.tabs.map((t) => t.groupId))])}`);
    }
    // Method B: derive from tabs.query + windows.get (does not depend on windowTypes being honoured)
    const ids = [...new Set(tabs.map((t) => t.windowId))];
    const typeOf = {};
    log(`[B] distinct windowIds from tabs.query: ${J(ids)}`);
    for (const id of ids) {
      try {
        const w = await chrome.windows.get(id);
        typeOf[id] = w.type;
        log(`  windows.get(${id}): type=${w.type} incognito=${w.incognito} state=${w.state}`);
      } catch (e) {
        typeOf[id] = '(error)';
        log(`  windows.get(${id}) failed: ${e}`);
      }
    }
    const aIds = wins.map((w) => w.id).sort((a, b) => a - b);
    log(`[A] window ids: ${J(aIds)} vs [B] window ids: ${J(ids.slice().sort((a, b) => a - b))}`);
    const nonNormal = tabs.filter((t) => typeOf[t.windowId] !== 'normal');
    log(`tabs in non-normal windows (method B): ${nonNormal.length}`);
    for (const t of nonNormal) {
      log(`  [${typeOf[t.windowId]}] tab ${t.id} windowId=${t.windowId} groupId=${t.groupId} index=${t.index} host=${host(t.url)}`);
    }
    log('all tabs (id, windowId, groupId, active, discarded, autoDiscardable):');
    for (const t of tabs) log(`  ${t.id}, ${t.windowId}, ${t.groupId}, ${t.active}, ${t.discarded}, ${t.autoDiscardable}`);
  });
}

async function probe2() {
  await wrap('Probe 2: discard grouped background tab', async () => {
    const c = (await candidates()).filter((t) => t.groupId !== -1);
    if (!c.length) { log('No eligible grouped background tab. Skipped.'); return; }
    const t = c[0];
    log(`eligible grouped background tabs: ${c.length}; chosen tab ${t.id} (first one) host=${host(t.url)} windowId=${t.windowId} groupId=${t.groupId}`);
    const g = await chrome.tabGroups.get(t.groupId);
    if (!(await confirmGate(`About to discard 1 tab: id ${t.id}. Nothing else is touched.`))) return;
    log('BEFORE: ' + J({ tab: snap(t), group: g }));
    const newId = await doDiscard(t.id);
    await sleep(500);
    const after = await chrome.tabs.get(newId);
    const g2 = after.groupId === -1 ? null : await chrome.tabGroups.get(after.groupId);
    log('AFTER: ' + J({ tab: snap(after), group: g2, groupIdWasNowUngrouped: after.groupId === -1 }));
  });
}

async function probe3() {
  await wrap('Probe 3: discard ACTIVE tab', async () => {
    winCache.clear();
    const actives = await chrome.tabs.query({ active: true });
    const elig = [];
    for (const t of actives) {
      if (await baseEligible(t)) elig.push({ t, focused: (await getWin(t.windowId)).focused });
    }
    log(`active tabs: ${actives.length}; eligible (http(s), normal window, not pinned/audible/probe page): ${elig.length}`);
    const pick = elig.find((e) => !e.focused) || null;
    if (!pick) {
      log('SKIPPED: no eligible active tab in a NON-focused window. Open a second normal window with an ordinary http(s) tab and unfocus it by clicking back here, then re-run probe 3. The probe page and focused window are never targeted.');
      return;
    }
    const t = pick.t;
    log(`chosen active tab ${t.id} in non-focused window ${t.windowId} host=${host(t.url)}`);
    if (!(await confirmGate(`About to attempt to discard 1 ACTIVE tab: id ${t.id}. It will probably be rejected.`))) return;
    log('BEFORE: ' + J(snap(t)));
    const newId = await doDiscard(t.id);
    await sleep(500);
    try { log('AFTER: ' + J(snap(await chrome.tabs.get(newId)))); } catch (e) { log('AFTER get failed: ' + e); }
  });
}

async function probe4() {
  await wrap('Probe 4: tabs already carrying autoDiscardable === false (READ-ONLY)', async () => {
    log('No mutation is performed. No tab property is changed and nothing is discarded in this probe.');
    const tabs = await chrome.tabs.query({});
    const no = tabs.filter((t) => t.autoDiscardable === false);
    log(`tabs with autoDiscardable === false: ${no.length} of ${tabs.length}`);
    for (const t of no) log(`  tab ${t.id} windowId=${t.windowId} groupId=${t.groupId} pinned=${t.pinned} audible=${t.audible} active=${t.active} host=${host(t.url)}`);
  });
}

async function probe5() {
  await wrap('Probe 5: tabGroups.query({})', async () => {
    const groups = await chrome.tabGroups.query({});
    log(`group count: ${groups.length}`);
    for (const g of groups) log(`  ${J(g)}`);
  });
}

async function probe6() {
  await wrap('Probe 6: system.memory permission + getInfo', async () => {
    const ok = await ensureMemoryPermission();
    if (!ok) log('Permission not granted; still attempting getInfo to record the failure.');
    const info = await chrome.system.memory.getInfo();
    log(`getInfo raw: ${J(info)}`);
    log(`capacity=${info.capacity} bytes (${gib(info.capacity)}) availableCapacity=${info.availableCapacity} bytes (${gib(info.availableCapacity)})`);
  });
}

const avail = async () => (await chrome.system.memory.getInfo()).availableCapacity;

async function probe7() {
  await wrap('Probe 7: control + 3 discard rounds of availableCapacity (10 s each)', async () => {
    const c = await candidates();
    const plan = [c.slice(0, 10), c.slice(10, 20), c.slice(20, 30)];
    log(`eligible background tabs: ${c.length}`);
    plan.forEach((p, i) => log(`  round ${i + 1} planned ids (${p.length}): ${J(p.map((t) => t.id))} hosts: ${J(p.map((t) => host(t.url)))}`));
    if (plan[0].length < 10) log(`NOTE: sample smaller than 10 (round 1 has ${plan[0].length}).`);
    const total = plan.reduce((n, p) => n + p.length, 0);
    if (!total) { log('No eligible tabs. Skipped.'); return; }
    if (!(await confirmGate(`About to discard up to ${total} tabs (ids above) across 3 rounds, after a no-discard control round.`))) return;
    await ensureMemoryPermission();

    log('-- CONTROL round (nothing discarded)');
    const cb0 = await avail();
    await sleep(10000);
    const ca0 = await avail();
    log(`   CONTROL: before=${cb0} B (${gib(cb0)}) after=${ca0} B (${gib(ca0)}) delta=${ca0 - cb0} B (${((ca0 - cb0) / GIB).toFixed(4)} GiB) tabs discarded=0`);

    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const chosen = plan[i];
      log(`-- round ${i + 1}: ${chosen.length} planned tabs`);
      if (!chosen.length) { log('   no tabs; skipped'); rounds.push(null); continue; }
      const before = await avail();
      const ids = [];
      for (const t of chosen) {
        try {
          const cur = await chrome.tabs.get(t.id);
          if (cur.active || cur.discarded) { log(`  tab ${t.id} no longer eligible (active=${cur.active} discarded=${cur.discarded}); not requested`); continue; }
          ids.push(await doDiscard(t.id));
        } catch (e) { log(`  tab ${t.id}: ${e}`); }
      }
      log('   waiting 10 seconds...');
      await sleep(10000);
      const after = await avail();
      let confirmed = 0;
      for (const id of ids) { try { if ((await chrome.tabs.get(id)).discarded === true) confirmed++; } catch (e) { log(`  re-read ${id} failed: ${e}`); } }
      const delta = after - before;
      log(`   round ${i + 1}: before=${before} B (${gib(before)}) after=${after} B (${gib(after)}) delta=${delta} B (${(delta / GIB).toFixed(4)} GiB) tabs requested=${ids.length} confirmed discarded=${confirmed}`);
      rounds.push({ before, after, delta, requested: ids.length, confirmed });
    }
    log('probe 7 summary: ' + J({ control: { before: cb0, after: ca0, delta: ca0 - cb0 }, rounds }));
  });
}

async function probe8() {
  await wrap('Probe 8: tabs.create chrome://settings/performance', async () => {
    log('about to open a NEW tab at chrome://settings/performance (no existing tab touched)');
    try {
      const t = await chrome.tabs.create({ url: 'chrome://settings/performance' });
      log('create resolved: ' + J(snap(t)) + ' pendingUrl=' + J(t.pendingUrl) + ' url=' + J(t.url));
      await sleep(1500);
      const t2 = await chrome.tabs.get(t.id);
      log(`after 1.5s: url=${J(t2.url)} pendingUrl=${J(t2.pendingUrl)} status=${t2.status}`);
      log('(new tab left open; close it by hand)');
    } catch (e) {
      log('create rejected: ' + String((e && e.stack) || e));
    }
  });
}

// ---------- UI ----------

const PROBES = {
  1: ['1 tabs.query', probe1], 2: ['2 discard grouped', probe2], 3: ['3 discard active', probe3],
  4: ['4 list autoDiscardable=false (read-only)', probe4], 5: ['5 tabGroups.query', probe5],
  6: ['6 system.memory', probe6], 7: ['7 control + memory delta x3 (~40s)', probe7], 8: ['8 settings/performance', probe8],
};
async function run(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } finally { setBusy(false); }
}
for (const k of Object.keys(PROBES)) {
  const [label, fn] = PROBES[k];
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => run(fn));
  bar.appendChild(b);
  probeButtons.push(b);
}
const all = document.createElement('button');
all.textContent = 'Run all';
all.addEventListener('click', () => run(async () => {
  try { await ensureMemoryPermission(); } catch (e) { log('permission request error: ' + e); }
  for (const k of [1, 2, 4, 5, 6, 7, 8, 3]) await PROBES[k][1](); // probe 3 last
  log('\n===== run all finished =====');
}));
bar.appendChild(all);
probeButtons.push(all);
bar.appendChild(gateBox);
log(`Fallow spike ready. userAgent=${navigator.userAgent}`);
