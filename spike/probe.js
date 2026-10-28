// THROWAWAY spike. Prints raw values only. Never closes, moves or navigates a tab: discard only.
'use strict';

const out = document.getElementById('out');
const GIB = 1024 * 1024 * 1024;

function log(...parts) {
  // textContent only: titles/URLs are untrusted.
  out.appendChild(document.createTextNode(parts.join(' ') + '\n'));
}
const J = (v) => JSON.stringify(v);
const gib = (b) => (b / GIB).toFixed(4) + ' GiB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Call a callback-style chrome API so lastError and the callback argument are both visible.
function cb(fn, ...args) {
  return new Promise((resolve) => {
    let threw = null;
    try {
      fn(...args, (result) => {
        const le = chrome.runtime.lastError;
        resolve({ result, lastError: le ? le.message : null, threw: null });
      });
    } catch (e) {
      threw = String(e && e.stack || e);
      resolve({ result: undefined, lastError: null, threw });
    }
  });
}

async function wrap(name, fn) {
  log(`\n===== ${name} =====`);
  try {
    await fn();
  } catch (e) {
    log(`ERROR in ${name}: ${String(e && e.stack || e)}`);
    if (chrome.runtime.lastError) log(`chrome.runtime.lastError: ${chrome.runtime.lastError.message}`);
  }
}

const snap = (t) => t && ({
  id: t.id, index: t.index, windowId: t.windowId, groupId: t.groupId,
  active: t.active, discarded: t.discarded, autoDiscardable: t.autoDiscardable,
  pinned: t.pinned, audible: t.audible, status: t.status,
});

let selfTabId = null;
async function getSelf() {
  if (selfTabId === null) {
    const t = await chrome.tabs.getCurrent();
    selfTabId = t ? t.id : -999; // -999 when opened as popup (no tab)
  }
  return selfTabId;
}

async function candidates() {
  const self = await getSelf();
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id !== self && !t.active && !t.discarded && !t.pinned &&
    !t.audible && t.autoDiscardable && /^https?:/.test(t.url || ''));
}

async function ensureMemoryPermission() {
  // Must be called directly from a click handler (user gesture).
  const r = await cb((c) => chrome.permissions.request({ permissions: ['system.memory'] }, c));
  log(`permissions.request(system.memory): granted=${J(r.result)} lastError=${J(r.lastError)} threw=${J(r.threw)}`);
  return r.result === true;
}

// ---------- probes ----------

async function probe1() {
  await wrap('Probe 1: tabs.query({}) and window types', async () => {
    const tabs = await chrome.tabs.query({});
    log(`tab count: ${tabs.length}`);
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app', 'devtools'] });
    log(`window count: ${wins.length}`);
    for (const w of wins) {
      const groups = [...new Set(w.tabs.map((t) => t.groupId))];
      log(`window ${w.id}: type=${w.type} state=${w.state} incognito=${w.incognito} tabs=${w.tabs.length} distinct groupIds=${J(groups)}`);
    }
    const nonNormal = wins.filter((w) => w.type !== 'normal');
    log(`non-normal windows: ${nonNormal.length}`);
    for (const w of nonNormal) {
      for (const t of w.tabs) {
        log(`  [${w.type}] tab ${t.id} windowId=${t.windowId} groupId=${t.groupId} index=${t.index} title=${J(t.title)} url=${J(t.url)}`);
      }
    }
    log('all tabs (id, windowId, groupId, active, discarded, autoDiscardable):');
    for (const t of tabs) log(`  ${t.id}, ${t.windowId}, ${t.groupId}, ${t.active}, ${t.discarded}, ${t.autoDiscardable}`);
  });
}

async function probe2() {
  await wrap('Probe 2: discard grouped background tab', async () => {
    const c = (await candidates()).filter((t) => t.groupId !== -1);
    if (!c.length) { log('No eligible grouped background tab (need http(s), not active/pinned/audible, autoDiscardable, groupId != -1). Skipped.'); return; }
    const t = c[0];
    log(`chosen tab ${t.id} (first of ${c.length} grouped eligible): title=${J(t.title)} url=${J(t.url)}`);
    const g = await chrome.tabGroups.get(t.groupId);
    const before = { tab: snap(t), group: g };
    log('BEFORE: ' + J(before));
    const r = await cb((c2) => chrome.tabs.discard(t.id, c2));
    log(`discard callback result=${J(snap(r.result))} lastError=${J(r.lastError)} threw=${J(r.threw)}`);
    await sleep(500);
    const after = await chrome.tabs.get(t.id);
    const g2 = await chrome.tabGroups.get(after.groupId === -1 ? t.groupId : after.groupId);
    log('AFTER: ' + J({ tab: snap(after), group: g2 }));
  });
}

async function probe3() {
  await wrap('Probe 3: discard ACTIVE tab', async () => {
    const self = await getSelf();
    const actives = (await chrome.tabs.query({ active: true })).filter((t) => t.id !== self);
    let t = actives[0];
    let why = 'active tab in a different window than the probe page';
    if (!t) {
      t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      why = 'FALLBACK: only the probe page itself is active (no other window). If discard succeeds this page may reload and lose output.';
    }
    if (!t) { log('No active tab found. Skipped.'); return; }
    log(`chosen tab ${t.id} (${why}): title=${J(t.title)} url=${J(t.url)}`);
    log('BEFORE: ' + J(snap(t)));
    const r = await cb((c) => chrome.tabs.discard(t.id, c));
    log(`discard callback result=${J(snap(r.result))} lastError=${J(r.lastError)} threw=${J(r.threw)}`);
    await sleep(500);
    try { log('AFTER: ' + J(snap(await chrome.tabs.get(t.id)))); } catch (e) { log('AFTER get failed: ' + e); }
  });
}

async function probe4() {
  await wrap('Probe 4: discard tab with autoDiscardable=false', async () => {
    const self = await getSelf();
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== self && !t.active && !t.discarded &&
      !t.pinned && !t.audible && t.autoDiscardable && /^https?:/.test(t.url || ''));
    if (!tabs.length) { log('No eligible background tab. Skipped.'); return; }
    // Prefer an ungrouped tab so probe 2 is not disturbed.
    const t = tabs.find((x) => x.groupId === -1) || tabs[0];
    log(`chosen tab ${t.id} (first ungrouped eligible, else first eligible): title=${J(t.title)} url=${J(t.url)}`);
    log(`about to set autoDiscardable=false on tab ${t.id} (will restore to true afterwards), then discard it`);
    const u = await cb((c) => chrome.tabs.update(t.id, { autoDiscardable: false }, c));
    log(`update result=${J(snap(u.result))} lastError=${J(u.lastError)} threw=${J(u.threw)}`);
    log('BEFORE: ' + J(snap(await chrome.tabs.get(t.id))));
    const r = await cb((c) => chrome.tabs.discard(t.id, c));
    log(`discard callback result=${J(snap(r.result))} lastError=${J(r.lastError)} threw=${J(r.threw)}`);
    await sleep(500);
    try {
      log('AFTER: ' + J(snap(await chrome.tabs.get(t.id))));
      const rs = await cb((c) => chrome.tabs.update(t.id, { autoDiscardable: true }, c));
      log(`restore autoDiscardable=true: result=${J(snap(rs.result))} lastError=${J(rs.lastError)}`);
    } catch (e) { log('AFTER get/restore failed: ' + e); }
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

async function probe7() {
  await wrap('Probe 7: availableCapacity before/after discarding 10 background tabs x3', async () => {
    await ensureMemoryPermission(); // first await: still inside the gesture
    const rounds = [];
    for (let i = 1; i <= 3; i++) {
      const c = await candidates();
      const chosen = c.slice(0, 10);
      log(`-- round ${i}: found ${c.length} eligible background tabs; using ${chosen.length}`);
      if (chosen.length < 10) log(`   NOTE: sample smaller than 10 (${chosen.length}).`);
      if (!chosen.length) { log('   no tabs; round skipped'); rounds.push(null); continue; }
      log(`   chosen tab ids: ${J(chosen.map((t) => t.id))} (first N eligible http(s), non-active, non-pinned, non-audible, autoDiscardable)`);
      for (const t of chosen) log(`     ${t.id} title=${J(t.title)} url=${J(t.url)}`);
      const before = (await chrome.system.memory.getInfo()).availableCapacity;
      const results = [];
      for (const t of chosen) {
        const r = await cb((c2) => chrome.tabs.discard(t.id, c2));
        results.push({ id: t.id, discardedReturned: r.result ? r.result.discarded : null, lastError: r.lastError, threw: r.threw });
      }
      log('   discard results: ' + J(results));
      log('   waiting 10 seconds...');
      await sleep(10000);
      const after = (await chrome.system.memory.getInfo()).availableCapacity;
      const delta = after - before;
      log(`   round ${i}: before=${before} B (${gib(before)}) after=${after} B (${gib(after)}) delta=${delta} B (${(delta / GIB).toFixed(4)} GiB) tabs=${chosen.length}`);
      rounds.push({ before, after, delta, tabs: chosen.length });
    }
    log('probe 7 summary: ' + J(rounds));
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
      log(`after 1.5s: url=${J(t2.url)} pendingUrl=${J(t2.pendingUrl)} title=${J(t2.title)} status=${t2.status}`);
      log('(new tab left open; close it by hand)');
    } catch (e) {
      log('create rejected: ' + String(e && e.stack || e));
    }
  });
}

// ---------- UI ----------

const PROBES = [
  ['1 tabs.query', probe1], ['2 discard grouped', probe2], ['3 discard active', probe3],
  ['4 discard autoDiscardable=false', probe4], ['5 tabGroups.query', probe5],
  ['6 system.memory', probe6], ['7 memory delta x3 (~30s)', probe7], ['8 settings/performance', probe8],
];
const bar = document.getElementById('buttons');
for (const [label, fn] of PROBES) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => { fn(); });
  bar.appendChild(b);
}
const all = document.createElement('button');
all.textContent = 'Run all';
all.addEventListener('click', async () => {
  // Request permission first, inside the gesture, so probes 6 and 7 do not depend on a later gesture.
  try { await ensureMemoryPermission(); } catch (e) { log('permission request error: ' + e); }
  for (const [, fn] of PROBES) await fn();
  log('\n===== run all finished =====');
});
bar.appendChild(all);
log(`Fallow spike ready. userAgent=${navigator.userAgent}`);
