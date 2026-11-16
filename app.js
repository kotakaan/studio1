/* Studio 1: the Valenti studio app, shared by Sasha, Carl, Brandon and Cai.
   Data lives in Supabase (see supabase.sql) when config.js has a URL and key, otherwise in this browser (test mode). */
(function () {
  var CFG = window.VALENTI_CONFIG || {};
  /* ?local opens a private test copy in this browser only (used for checking changes without touching shared data) */
  var CLOUD = !!(CFG.supabaseUrl && CFG.supabaseAnonKey) && !/[?&]local\b/.test(location.search);
  var SUPA_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  var PEOPLE = CFG.people && CFG.people.length ? CFG.people : ['Sasha', 'Carl', 'Brandon', 'Cai'];

  var VAL = { rent: 3500, partners: 4, kam: 0.2, dryRate: 60 };
  var TABLE = { dryhire: 'dryhire', sessions: 'sessions', paid: 'kam_paid', owed: 'owed', rent: 'rent_paid', bills: 'bills', billpaid: 'bill_paid' };
  /* tables added after launch: if one isn't in the database yet, the app carries on without it */
  var LATER = { rent: 1, bills: 1, billpaid: 1 };
  function missingTable(e) { return !!e && (e.code === 'PGRST205' || e.code === '42P01'); }
  var KEYS = Object.keys(TABLE);

  var nf = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
  function money(n) { return nf.format(Math.round(n * 100) / 100); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = String(s).slice(0, 10).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function monday(s) { var d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }
  function fmtDay(s) { return parse(s).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); }
  function fmtLong(s) { return parse(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function monthName(ym, withYear) { return parse(ym + '-01').toLocaleDateString('en-AU', withYear ? { month: 'long', year: 'numeric' } : { month: 'long' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function errMsg(e) { return (e && (e.message || e.error_description)) || String(e || 'unknown error'); }
  function report(msg) { try { if (window.skyErrBar) window.skyErrBar(msg); } catch (e) {} }

  var today = iso(new Date());
  var state = { dryhire: [], sessions: [], paid: [], owed: [], rent: [], bills: [], billpaid: [] };
  var billsMissing = false;      /* true until the bills tables exist */
  var people = PEOPLE.slice();   /* member names, from the members table once signed in */
  var rentMissing = false;       /* true until the rent_paid table exists */
  var me = null;            /* { name, id } once signed in */
  var sb = null;            /* Supabase client */
  var loadErr = '';

  /* ---------- toast ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }
  window.addEventListener('error', function (ev) { try { toast('Something went wrong: ' + (ev.message || 'unknown error') + '.'); } catch (e) {} });
  window.addEventListener('unhandledrejection', function (ev) { try { toast('Something went wrong: ' + errMsg(ev.reason) + '.'); } catch (e) {} });

  /* ---------- LED meter ---------- */
  function makeMeter(el, total) {
    var h = '';
    for (var i = 0; i < total; i++) { var p = (i + 1) / total; h += '<i class="seg ' + (p <= 0.62 ? 'g' : p <= 0.87 ? 'a' : 'r') + '" style="--i:' + i + '"></i>'; }
    el.innerHTML = h;
  }
  function setMeter(el, ratio) {
    var k = el.children.length, lit = ratio <= 0 ? 0 : Math.max(1, Math.round(Math.min(ratio, 1) * k));
    for (var i = 0; i < k; i++) el.children[i].classList.toggle('on', i < lit);
  }
  makeMeter($('rmMeter'), 40);
  $('dDate').value = today; $('sDate').value = today; $('oDue').value = addDays(today, 7);
  $('weekLabel').textContent = 'Week of ' + fmtLong(monday(today));

  /* ---------- storage: rows in and out ---------- */
  function fromRow(r) {
    return { id: String(r.id), date: r.date ? String(r.date).slice(0, 10) : '', amount: Number(r.amount) || 0, kam: !!r.kam, note: r.note || '',
      hours: r.hours == null ? null : Number(r.hours), rate: r.rate == null ? null : Number(r.rate), discount: r.discount == null ? 0 : Number(r.discount), price: r.price == null ? null : Number(r.price),
      who: r.who || '', due: r.due ? String(r.due).slice(0, 10) : '', paid: !!r.paid, paidDate: r.paid_date ? String(r.paid_date).slice(0, 10) : '',
      by: r.added_by || '', uid: r.user_id || '', created: r.created_at || '',
      month: r.month || '', voided: !!r.voided, editedBy: r.edited_by || '', editedAt: r.edited_at || '', owedId: r.owed_id || null, billId: r.bill_id ? String(r.bill_id) : null };
  }
  function toRow(key, d) {
    var v = { voided: !!d.voided };
    if (key === 'paid') return Object.assign(v, { date: d.date, amount: d.amount, note: d.note || '' });
    if (key === 'rent') return Object.assign(v, { month: d.month, date: d.date, amount: d.amount, note: d.note || '' });
    if (key === 'bills') return Object.assign(v, { date: d.date, amount: d.amount, note: d.note || '', due: d.due || null });
    if (key === 'billpaid') return Object.assign(v, { bill_id: d.billId, date: d.date, amount: d.amount, note: d.note || '' });
    if (key === 'sessions') return Object.assign(v, { date: d.date, amount: d.amount, kam: !!d.kam, note: d.note || '', price: d.price == null ? null : d.price, discount: d.discount || 0, owed_id: d.owedId || null });
    if (key === 'dryhire') return Object.assign(v, { date: d.date, amount: d.amount, kam: !!d.kam, note: d.note || '', hours: d.hours == null ? null : d.hours, rate: d.rate == null ? null : d.rate, discount: d.discount || 0 });
    if (key === 'owed') return Object.assign(v, { who: d.who, amount: d.amount, due: d.due, note: d.note || '', paid: !!d.paid, paid_date: d.paidDate || null });
    return Object.assign(v, { date: d.date, amount: d.amount, kam: !!d.kam, note: d.note || '' });
  }
  function own(x) { return !!me && (CLOUD ? x.uid === me.id : x.by === me.name); }

  var LS_KEY = 'valenti-local-v1';
  function loadLocal() {
    try { var v = JSON.parse(lsGet(LS_KEY) || 'null'); if (v) KEYS.forEach(function (k) { if (Array.isArray(v[k])) state[k] = v[k]; }); } catch (e) {}
  }
  function saveLocal() { if (!CLOUD) lsSet(LS_KEY, JSON.stringify(state)); }

  function addEntry(key, data) {
    /* test mode gets its final id up front, so the row on screen can be deleted straight away */
    var tmp = Object.assign({ id: (CLOUD ? 'tmp' : 'l') + Math.random().toString(36).slice(2), by: me.name, uid: me.id, created: new Date().toISOString() }, data);
    state[key].push(tmp);
    render();
    if (!CLOUD) { saveLocal(); return Promise.resolve(tmp); }
    return sb.from(TABLE[key]).insert(toRow(key, data)).select().single().then(function (res) {
      if (res.error) throw res.error;
      var saved = fromRow(res.data);
      state[key] = state[key].filter(function (x) { return x !== tmp && x.id !== saved.id; }).concat([saved]);
      render();
      return saved;
    }).catch(function (e) {
      state[key] = state[key].filter(function (x) { return x !== tmp; });
      render();
      toast('That did not save: ' + errMsg(e) + '. Try again.');
      report('Save failed (' + key + '): ' + errMsg(e));
      return null;
    });
  }
  function delEntry(key, id) {
    if (CLOUD && String(id).indexOf('tmp') === 0) { toast('Still saving that one. Try again in a second.'); return Promise.resolve(false); }
    var keep = state[key];
    state[key] = keep.filter(function (x) { return x.id !== id; });
    render();
    if (!CLOUD) { saveLocal(); return Promise.resolve(true); }
    return sb.from(TABLE[key]).delete().eq('id', id).select().then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || !res.data.length) throw new Error('only the person who added it can delete it');
      return true;
    }).catch(function (e) { state[key] = keep; render(); toast('Could not delete that: ' + errMsg(e) + '.'); return false; });
  }
  function patchEntry(key, id, patch) {
    var item = state[key].filter(function (x) { return x.id === id; })[0];
    if (!item) return Promise.resolve(false);
    var before = Object.assign({}, item);
    Object.assign(item, patch); render();
    if (!CLOUD) { item.editedBy = me.name; item.editedAt = new Date().toISOString(); saveLocal(); render(); return Promise.resolve(true); }
    if (String(id).indexOf('tmp') === 0) { Object.assign(item, before); render(); toast('Still saving that one. Try again in a second.'); return Promise.resolve(false); }
    return sb.from(TABLE[key]).update(toRow(key, item)).eq('id', id).select().then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || !res.data.length) throw new Error('only the person who added it can change it');
      Object.assign(item, fromRow(res.data[0])); render();
      return true;
    }).catch(function (e) { Object.assign(item, before); render(); toast('Could not save that: ' + errMsg(e) + '.'); return false; });
  }

  /* cloud: load everything, then reload a table whenever anyone changes it */
  function loadTable(key) {
    return sb.from(TABLE[key]).select('*').order('created_at', { ascending: true }).then(function (res) {
      if (res.error) {
        /* rent tracking was added later: if its table isn't there yet, carry on without it */
        if (LATER[key] && missingTable(res.error)) { if (key === 'rent') rentMissing = true; else billsMissing = true; state[key] = []; return; }
        throw res.error;
      }
      if (key === 'rent') rentMissing = false;
      state[key] = (res.data || []).map(fromRow);
    });
  }
  function loadAll() {
    if (!CLOUD || !me) return Promise.resolve();
    billsMissing = false;
    return Promise.all(KEYS.map(loadTable)).then(function () { loadErr = ''; render(); }).catch(function (e) {
      loadErr = errMsg(e); render(); report('Could not load: ' + loadErr);
    });
  }
  var reloadTimers = {}, channel = null;
  function reloadSoon(key) {
    clearTimeout(reloadTimers[key]);
    reloadTimers[key] = setTimeout(function () { loadTable(key).then(render).catch(function (e) { loadErr = errMsg(e); render(); }); }, 250);
  }
  function listen() {
    if (channel) return;
    channel = sb.channel('valenti-live');
    KEYS.forEach(function (k) { channel.on('postgres_changes', { event: '*', schema: 'public', table: TABLE[k] }, function () { reloadSoon(k); }); });
    channel.subscribe();
  }

  /* ---------- backup: a copy of every table, saved to this device as a .json file ---------- */
  var BK_KEY = 'studio1-last-backup';
  function backupNote() {
    var box = $('backupBox'); if (!box) return;
    var last = lsGet(BK_KEY), days = last ? Math.floor((Date.now() - Date.parse(last)) / 864e5) : null;
    $('backupTxt').textContent = last
      ? 'Last backup on this device: ' + fmtLong(iso(new Date(last))) + (days >= 7 ? '. Time for a new one.' : '.')
      : 'Saves a copy of everything to this device. Do it once a week.';
    box.classList.toggle('due', !!last && days >= 7);
  }
  function downloadBackup() {
    var btn = $('backupBtn'); btn.disabled = true;
    var get = CLOUD ? Promise.all(KEYS.map(function (k) {
      return sb.from(TABLE[k]).select('*').order('created_at', { ascending: true }).then(function (res) {
        if (res.error) { if (LATER[k] && missingTable(res.error)) return [k, []]; throw res.error; }
        return [k, res.data || []];
      });
    })) : Promise.resolve(KEYS.map(function (k) { return [k, state[k]]; }));
    get.then(function (pairs) {
      var out = { app: 'Studio 1', savedAt: new Date().toISOString(), savedBy: me ? me.name : '', tables: {} };
      pairs.forEach(function (p) { out.tables[TABLE[p[0]]] = p[1]; });
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'studio1-backup-' + iso(new Date()) + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      lsSet(BK_KEY, new Date().toISOString()); backupNote();
      var n = pairs.reduce(function (s, p) { return s + p[1].length; }, 0);
      toast('Backup saved: ' + n + ' entries.');
    }).catch(function (e) {
      toast('Backup failed: ' + errMsg(e) + '.'); report('Backup failed: ' + errMsg(e));
    }).then(function () { btn.disabled = false; });
  }
  $('backupBtn').addEventListener('click', downloadBackup);
  backupNote();

  /* ---------- maths ---------- */
  /* undone entries stay on record but count as $0 */
  function val(x) { return x && !x.voided ? (Number(x.amount) || 0) : 0; }
  function dryKam(x) { return x && x.kam ? val(x) * VAL.kam : 0; }
  function hrsTxt(h) { h = Number(h) || 0; return (Math.round(h * 100) / 100) + (h === 1 ? ' hr' : ' hrs'); }
  /* how a dry hire was priced, e.g. "3 hrs at $60/hr, 10% off · " (older entries have no hours) */
  function dryHow(x) { return x && x.hours > 0 ? hrsTxt(x.hours) + ' at ' + money(x.rate || VAL.dryRate) + '/hr' + (x.discount > 0 ? ', ' + x.discount + '% off' : '') + ' · ' : ''; }
  /* a discounted session shows its full price, e.g. "$200.00 less 10% · " */
  function sessHow(x) { return x && x.discount > 0 && x.price > 0 ? money(x.price) + ' less ' + x.discount + '%' : ''; }
  function joinBits(list) { return list.filter(Boolean).join(' · '); }
  function dryNet(x) { return val(x) - dryKam(x); }
  function sessKam(x) { return x && x.kam ? val(x) * VAL.kam : 0; }
  function kamStill() {
    var owedAll = 0, paid = 0;
    state.sessions.forEach(function (s) { owedAll += sessKam(s); });
    state.dryhire.forEach(function (x) { owedAll += dryKam(x); });
    state.paid.forEach(function (p) { paid += val(p); });
    return { still: Math.max(0, r2(owedAll - paid)), paid: paid };
  }
  function byDateDesc(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.created < b.created ? 1 : -1); }
  function inWeek(s, wk) { return s.date >= wk && s.date <= addDays(wk, 6); }
  function daysTo(d) { return Math.round((parse(d) - parse(today)) / 86400000); }

  /* ---------- rendering ---------- */
  function byChip(x) { return '<span class="chip by' + (own(x) ? ' me' : '') + '" title="Added by ' + esc(x.by || 'unknown') + '">' + esc(x.by || '?') + '</span>'; }
  function editedNote(x) { if (!x.editedBy) return ''; var d = x.editedAt ? new Date(x.editedAt) : null; return 'changed by ' + x.editedBy + (d && !isNaN(d) ? ' ' + fmtDay(iso(d)) : ''); }
  function actBtn(act, key, x, label) { return '<button class="rowbtn' + (act === 'undo' || act === 'delete' ? ' warn' : '') + '" type="button" data-act="' + act + '" data-coll="' + key + '" data-id="' + esc(x.id) + '">' + label + '</button>'; }
  /* only the person who added an entry can change it; undone entries can be restored */
  function acts(x, key, extra) {
    if (!own(x)) return '';
    if (x.voided) return '<span class="acts">' + actBtn('restore', key, x, 'Restore') + actBtn('delete', key, x, 'Delete') + '</span>';
    return '<span class="acts">' + (extra || '') + actBtn('edit', key, x, 'Edit') + actBtn('undo', key, x, 'Undo') + '</span>';
  }
  function liOpen(x) { return '<li' + (x.voided ? ' class="voided"' : '') + (editing && editing.id === x.id ? ' data-editing="1"' : '') + '>'; }
  function rowHtml(x, key, title, sub, amount, chip, extra, day) {
    return liOpen(x) + '<span class="d">' + esc(fmtDay(day || x.date)) + '</span><span class="t">' + esc(title) + ' <small>' + esc(joinBits([sub, editedNote(x)])) + '</small>' + (x.voided ? '<span class="chip late">Undone</span>' : '') + (chip || '') + byChip(x) +
      '</span><span class="a">' + amount + '</span>' + acts(x, key, extra) + '</li>';
  }

  function renderRoom() {
    var month = today.slice(0, 7), mLabel = monthName(month);
    var rows = state.dryhire.filter(function (x) { return x.date.slice(0, 7) === month; });
    var dry = 0, kamM = 0; rows.forEach(function (x) { dry += dryNet(x); kamM += dryKam(x); });
    $('rmKamRow').hidden = !(kamM > 0); $('rmKam').textContent = money(kamM);
    var gap = Math.max(0, VAL.rent - dry), extra = Math.max(0, dry - VAL.rent);
    $('rmRent').textContent = money(VAL.rent);
    $('rmInLbl').textContent = 'Dry hire in ' + mLabel + (kamM > 0 ? ' (after Kam)' : '');
    $('dryList').innerHTML = rows.sort(byDateDesc).map(function (x) {
      var k = x.kam ? (Number(x.amount) || 0) * VAL.kam : 0;
      return rowHtml(x, 'dryhire', x.note || 'Dry hire', dryHow(x) + (x.kam ? 'Kam kept ' + money(k) + ', ' + money((Number(x.amount) || 0) - k) + ' into the rent pool' : 'Into the rent pool'), money(x.amount), x.kam ? '<span class="chip kam">Kam</span>' : '');
    }).join('');
    $('dryEmpty').hidden = rows.length > 0;
    var byM = {}; state.dryhire.forEach(function (x) { var k = x.date.slice(0, 7); if (k < month && !x.voided) byM[k] = (byM[k] || 0) + dryNet(x); });
    var ks = Object.keys(byM).sort().reverse().slice(0, 6);
    $('dryHist').innerHTML = ks.length ? '<h2 class="t2" style="margin-top:18px">Past months</h2>' + ks.map(function (k) {
      var t = byM[k], gp = Math.max(0, VAL.rent - t);
      return '<div class="kv"><span>' + esc(monthName(k, true)) + '</span><span>' + money(t) + ' dry hire &middot; ' + (gp > 0 ? money(gp / VAL.partners) + ' each' : 'rent covered') + '</span></div>';
    }).join('') : '';
    $('rmIn').textContent = money(dry);
    $('rmGapLbl').textContent = gap > 0 ? 'Short of the rent' : 'Over the rent';
    $('rmGap').textContent = money(gap > 0 ? gap : extra);
    setMeter($('rmMeter'), dry / VAL.rent);
    $('rmText').textContent = gap > 0 ? 'Dry hire covers ' + Math.round(dry / VAL.rent * 100) + '% of the rent. The four of you cover the other ' + money(gap) + ' out of pocket.' : 'Rent is covered. Nobody pays out of pocket.';
    $('rmEachLbl').textContent = gap > 0 ? 'Each of the ' + VAL.partners + ' pays' : 'Out of pocket each';
    $('rmEach').textContent = money(gap / VAL.partners);
    $('rmEachSub').textContent = gap > 0 ? money(gap) + ' split ' + VAL.partners + ' ways' : (extra > 0 ? money(extra) + ' left over' : '');
  }

  function renderSessions() {
    var month = today.slice(0, 7), gross = 0, kam = 0, per = {};
    state.sessions.forEach(function (s) {
      if (s.date.slice(0, 7) !== month || s.voided) return;
      var a = val(s), n = s.by || '?';
      per[n] = per[n] || { g: 0, k: 0 }; per[n].g += a; per[n].k += sessKam(s);
      if (own(s)) { gross += a; kam += sessKam(s); }
    });
    $('vMonthLbl').textContent = 'Your sessions in ' + monthName(month);
    $('vGross').textContent = money(gross);
    $('vKam').textContent = '-' + money(kam);
    $('vMine').textContent = money(gross - kam);
    var names = Object.keys(per).sort();
    $('vByPerson').innerHTML = names.length ? '<div class="vfd-label" style="margin-bottom:4px">Everyone in ' + esc(monthName(month)) + ', after Kam</div>' + names.map(function (n) {
      return '<div class="kv"><span>' + esc(n) + (me && n === me.name ? ' (you)' : '') + '</span><span>' + money(per[n].g - per[n].k) + '</span></div>';
    }).join('') : '';
    var rows = state.sessions.slice().sort(byDateDesc).slice(0, 12);
    $('sessList').innerHTML = rows.map(function (s) {
      var sk = s.kam ? (Number(s.amount) || 0) * VAL.kam : 0;
      return rowHtml(s, 'sessions', s.note || 'Session', joinBits([sessHow(s), s.kam ? 'Kam kept ' + money(sk) + ', you got ' + money((Number(s.amount) || 0) - sk) : '']), money(s.amount), s.kam ? '<span class="chip kam">Kam</span>' : '');
    }).join('');
    $('sessEmpty').hidden = rows.length > 0;
  }

  function dueChip(x) {
    var n = daysTo(x.due);
    return n < 0 ? '<span class="chip late">' + (-n) + (n === -1 ? ' day late' : ' days late') + '</span>' : n === 0 ? '<span class="chip soon">due today</span>' : n <= 3 ? '<span class="chip soon">in ' + n + (n === 1 ? ' day' : ' days') + '</span>' : '';
  }
  function owedRow(x, paidView) {
    var extra = paidView ? actBtn('unpay', 'owed', x, 'Not paid yet') : '<button class="pay" type="button" data-paid="' + esc(x.id) + '">Got it</button>';
    return liOpen(x) + '<span class="d">' + esc(fmtDay(paidView ? (x.paidDate || x.due) : x.due)) + '</span><span class="t">' + esc(x.who || 'Someone') + ' <small>' + esc(joinBits([x.note, editedNote(x)])) + '</small>' +
      (x.voided ? '<span class="chip late">Undone</span>' : paidView ? '<span class="chip bank">Paid</span>' : dueChip(x)) +
      '<span class="chip by' + (own(x) ? ' me' : '') + '">' + (paidView ? 'to ' : 'Owed to ') + esc(x.by || '?') + '</span></span><span class="a">' + money(x.amount) + '</span>' + acts(x, 'owed', extra) + '</li>';
  }
  function renderOwed() {
    var open = state.owed.filter(function (x) { return !x.paid; }).sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
    var live = open.filter(function (x) { return !x.voided; });
    var mine = live.filter(own), total = 0, all = 0, late = 0, who = {};
    live.forEach(function (x) { all += val(x); });
    mine.forEach(function (x) { total += val(x); who[(x.who || '').toLowerCase()] = 1; if (daysTo(x.due) < 0) late++; });
    $('owedTotalBox').hidden = state.owed.length === 0;
    $('owedTotal').textContent = money(total);
    var nw = Object.keys(who).length;
    $('owedSub').textContent = (mine.length === 0 ? 'Nothing owed to you' : mine.length + (mine.length === 1 ? ' payment' : ' payments') + ' from ' + nw + (nw === 1 ? ' person' : ' people') + (late ? ', ' + late + ' overdue' : '')) + (all > total ? ' · Everyone: ' + money(all) : '');
    $('owedList').innerHTML = open.map(function (x) { return owedRow(x, false); }).join('');
    $('owedEmpty').hidden = open.length > 0;
    var done = state.owed.filter(function (x) { return x.paid; }).sort(function (a, b) { return (a.paidDate || '') < (b.paidDate || '') ? 1 : -1; }).slice(0, 5);
    $('owedPaid').innerHTML = done.length ? '<h2 class="t2" style="margin-top:18px">Paid back</h2><ul class="entries owedlist">' + done.map(function (x) { return owedRow(x, true); }).join('') + '</ul>' : '';
    var b = $('owedBadge'); b.hidden = mine.length === 0; b.textContent = mine.length; b.style.background = late ? 'var(--bad)' : 'var(--warn)';
  }

  function renderBanner() {
    var parts = [];
    if (!CLOUD) parts.push('<span>Test mode: the shared database isn\'t connected yet, so entries are saved in this browser only and nobody else sees them.</span>');
    if (loadErr) parts.push('<span>Can\'t reach the shared database right now (' + esc(loadErr) + '). Numbers may be out of date.</span><button class="btn small ghost" type="button" id="retryLoad">Try again</button>');
    /* first week of a new month: point to last month's report */
    var lm = (function () { var d = parse(today.slice(0, 7) + '-01'); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
    var hasLast = ['dryhire', 'sessions', 'rent'].some(function (k) { return state[k].some(function (x) { return !x.voided && monthOf(x) === lm; }); });
    if (Number(today.slice(8, 10)) <= 7 && hasLast) parts.push('<span>' + esc(monthName(lm)) + ' is closed and filed. Each of you ' + (monthStats(lm).gap > 0 ? 'paid ' + money(monthStats(lm).each) + ' toward rent' : 'paid nothing, dry hire covered the rent') + '.</span><button class="btn small ghost" type="button" id="openLastReport" data-month="' + lm + '">See the report</button>');
    /* reminders: your rent share and bill shares that aren't marked paid yet */
    var due = reminders();
    if (due.rent) parts.push('<span><b>Rent reminder:</b> your ' + esc(monthName(due.rent.month)) + ' share is ' + money(due.rent.left) + ' and isn\'t marked paid yet.</span><button class="btn small ghost" type="button" data-log="rent">I paid it</button>');
    due.bills.slice(0, 3).forEach(function (b) {
      parts.push('<span><b>Bill reminder:</b> ' + esc(billWhat(b)) + ', your share is ' + money(r2(billShare(b) - billPaidBy(b, me.name))) + (b.due ? (daysTo(b.due) < 0 ? ', overdue since ' : ', due ') + esc(fmtDay(b.due)) : '') + '.</span><button class="btn small ghost" type="button" data-billpay="' + esc(b.id) + '">I paid my share</button>');
    });
    if (due.bills.length > 3) parts.push('<span>And ' + (due.bills.length - 3) + ' more bills to pay. They\'re in Bills below.</span>');
    $('banner').innerHTML = parts.map(function (p) { return '<div class="bline">' + p + '</div>'; }).join('');
    $('banner').hidden = parts.length === 0;
    /* the number on the home-screen icon: how many things you still need to pay */
    try {
      var n = (due.rent ? 1 : 0) + due.bills.length;
      if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n).catch(function () {}); else navigator.clearAppBadge().catch(function () {}); }
    } catch (e) {}
  }
  function reminders() {
    var out = { rent: null, bills: [] };
    if (!me) return out;
    if (!rentMissing) {
      var n = rentNumbers(), left = r2(n.each - paidBy(me.name, n.month));
      if (n.each > 0 && left > 0.005) out.rent = { month: n.month, left: left };
    }
    out.bills = state.bills.filter(iOwe).sort(function (a, b) { return (a.due || a.date) < (b.due || b.date) ? -1 : 1; });
    return out;
  }

  /* ---------- files: year > month > week ---------- */
  function fileRow(d, title, sub, amount) {
    return '<li><span class="d">' + esc(fmtDay(d)) + '</span><span class="t">' + esc(title) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</span><span class="a">' + amount + '</span></li>';
  }
  function weekKeys(lists) {
    var seen = {}; lists.forEach(function (l) { l.forEach(function (x) { if (x.date) seen[monday(x.date)] = 1; }); });
    return Object.keys(seen).sort().reverse();
  }
  function totalsBox(cells) { return '<div class="tot">' + cells.map(function (c) { return '<div><div class="vfd-label">' + c[0] + '</div><div class="amt">' + c[1] + '</div></div>'; }).join('') + '</div>'; }
  function valentiWeeks() {
    var cur = monday(today);
    var liveOnly = function (l) { return l.filter(function (x) { return !x.voided; }); };
    return weekKeys([liveOnly(state.dryhire), liveOnly(state.sessions), liveOnly(state.paid)]).map(function (wk) {
      var dh = state.dryhire.filter(function (x) { return !x.voided && inWeek(x, wk); }), ses = state.sessions.filter(function (x) { return !x.voided && inWeek(x, wk); }), kp = state.paid.filter(function (x) { return !x.voided && inWeek(x, wk); });
      var dry = 0, gross = 0, kam = 0, paid = 0, rows = [];
      dh.forEach(function (x) { dry += dryNet(x); kam += dryKam(x); });
      ses.forEach(function (x) { gross += val(x); kam += sessKam(x); });
      kp.forEach(function (x) { paid += val(x); });
      var sesKam = 0; ses.forEach(function (x) { sesKam += sessKam(x); });
      dh.forEach(function (x) { rows.push({ d: x.date, h: fileRow(x.date, 'Dry hire', dryHow(x) + (x.kam ? 'Kam kept ' + money(dryKam(x)) + ', rest into the rent pool' : 'Into the rent pool') + (x.note ? ' · ' + x.note : '') + ' · added by ' + (x.by || '?'), '+' + money(x.amount)) }); });
      ses.forEach(function (x) { rows.push({ d: x.date, h: fileRow(x.date, 'Personal session · ' + (x.by || '?'), joinBits([sessHow(x), x.kam ? 'Kam kept ' + money(sessKam(x)) : '', x.note]), money(x.amount)) }); });
      state.rent.filter(function (x) { return !x.voided && inWeek(x, wk); }).forEach(function (x) { rows.push({ d: x.date, h: fileRow(x.date, 'Rent share paid · ' + (x.by || '?'), joinBits(['for ' + monthName(x.month || x.date.slice(0, 7), true), x.note]), money(x.amount)) }); });
      rows.sort(function (p, q) { return p.d < q.d ? 1 : p.d > q.d ? -1 : 0; });
      var kept = gross - sesKam;
      var html = '<details class="file"' + (wk === cur ? ' open' : '') + '><summary><span class="fico" aria-hidden="true"></span><span class="fname">Week of ' + esc(fmtLong(wk)) + (wk === cur ? ' · this week' : '') + '<small>Dry hire ' + money(dry) + ' · Personal sessions ' + money(kept) + '</small></span><span class="fnet pos">' + money(dry + kept) + '</span></summary><div class="fbody"><div class="fclose"><button type="button" class="crumb" data-fclose="1">Close file</button></div><div class="fsub"><span>Dry hire (rent pool) <b>' + money(dry) + '</b></span><span>Personal sessions <b>' + money(gross) + '</b></span><span>Kam\'s 20% <b>' + money(kam) + '</b></span><span>Kept after Kam <b>' + money(kept) + '</b></span>' + '</div><ul class="entries ro">' + rows.map(function (r) { return r.h; }).join('') + '</ul></div></details>';
      return { wk: wk, a: dry, b: kept, c: kam, html: html };
    });
  }
  function sum3(list) { var t = [0, 0, 0]; list.forEach(function (w) { t[0] += w.a; t[1] += w.b; t[2] += w.c; }); return t; }
  function folderBtn(go, title, sub) {
    return '<button type="button" class="folder" data-fgo="' + esc(go) + '"><span class="fico big" aria-hidden="true"></span><span class="ftxt"><b>' + esc(title) + '</b><small>' + sub + '</small></span><span class="chev" aria-hidden="true">&rsaquo;</span></button>';
  }
  var fpath = [];
  /* ---------- monthly report: every month gets one in Files; past months are marked closed ---------- */
  function monthOf(x) { return x.month || (x.date || '').slice(0, 7); }
  function monthStats(ym) {
    var st = { ym: ym, closed: ym < today.slice(0, 7), dryGross: 0, dryKam: 0, dryNet: 0, bookings: 0, hours: 0, per: {}, shares: {} };
    state.dryhire.forEach(function (x) { if (x.voided || monthOf(x) !== ym) return; st.dryGross += val(x); st.dryKam += dryKam(x); st.dryNet += dryNet(x); st.bookings++; st.hours += Number(x.hours) || 0; });
    state.sessions.forEach(function (x) { if (x.voided || monthOf(x) !== ym) return; var n = x.by || '?'; st.per[n] = st.per[n] || { g: 0, k: 0, n: 0 }; st.per[n].g += val(x); st.per[n].k += sessKam(x); st.per[n].n++; });
    state.rent.forEach(function (x) { if (x.voided || monthOf(x) !== ym) return; var n = x.by || '?'; st.shares[n] = (st.shares[n] || 0) + val(x); });
    st.gap = Math.max(0, VAL.rent - st.dryNet); st.extra = Math.max(0, st.dryNet - VAL.rent); st.each = r2(st.gap / VAL.partners);
    return st;
  }
  function kvRow(k, v) { return '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'; }
  function monthReportHtml(ym) {
    var st = monthStats(ym), names = people.slice();
    Object.keys(st.per).concat(Object.keys(st.shares)).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    var rent = kvRow('Monthly rent', money(VAL.rent)) +
      kvRow('Dry hire', money(st.dryGross) + (st.bookings ? ' <small class="muted">(' + st.bookings + (st.bookings === 1 ? ' booking' : ' bookings') + (st.hours ? ', ' + hrsTxt(st.hours) : '') + ')</small>' : '')) +
      (st.dryKam > 0 ? kvRow('Kam kept on dry hire', '-' + money(st.dryKam)) : '') +
      kvRow('Into the rent pool', money(st.dryNet)) +
      kvRow(st.gap > 0 ? 'Short of the rent' : 'Over the rent', money(st.gap > 0 ? st.gap : st.extra)) +
      kvRow('<b>Each of the ' + VAL.partners + ' pays</b>', '<b>' + money(st.each) + '</b>');
    var shares = rentMissing ? '<p class="muted" style="font-size:13px">Rent share tracking isn\'t switched on yet.</p>' : names.map(function (n) {
      var p = r2(st.shares[n] || 0), stt = st.each <= 0 ? 'Nothing to pay' : p >= st.each - 0.005 ? 'Paid ' + money(p) + ' &#10003;' : p > 0 ? 'Paid ' + money(p) + ', ' + money(st.each - p) + (st.closed ? ' short' : ' to go') : (st.closed ? 'Didn\'t pay' : 'Not paid yet');
      return kvRow(esc(n), stt);
    }).join('');
    var sessNames = Object.keys(st.per).sort(), tg = 0, tk = 0;
    var mBills = state.bills.filter(function (b) { return !b.voided && monthOf(b) === ym; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }), bt = 0;
    var bills = mBills.length ? mBills.map(function (b) {
      bt += Number(b.amount) || 0;
      var left = billLeft(b);
      return kvRow(esc(billWhat(b)) + ' <small class="muted">' + esc(fmtDay(b.date)) + '</small>', money(b.amount) + ' <small class="muted">' + (left.length ? 'waiting on ' + esc(left.join(', ')) : 'all paid &#10003;') + '</small>');
    }).join('') + kvRow('<b>Bills total</b>', '<b>' + money(bt) + '</b> <small class="muted">' + money(r2(bt / VAL.partners)) + ' each</small>') : '<p class="muted" style="font-size:13px">No bills this month.</p>';
    var sess = sessNames.length ? sessNames.map(function (n) { var q = st.per[n]; tg += q.g; tk += q.k; return kvRow(esc(n) + ' <small class="muted">(' + q.n + ')</small>', money(q.g - q.k) + (q.k > 0 ? ' <small class="muted">after Kam ' + money(q.k) + '</small>' : '')); }).join('') + kvRow('<b>All sessions</b>', '<b>' + money(tg - tk) + '</b>' + (tk > 0 ? ' <small class="muted">Kam kept ' + money(tk) + '</small>' : '')) : '<p class="muted" style="font-size:13px">No personal sessions this month.</p>';
    return '<details class="file report" open><summary><span class="fico" aria-hidden="true"></span><span class="fname">' + esc(monthName(ym, true)) + ' report<small>' + (st.closed ? 'Month closed' : 'Month in progress, updates as you log') + '</small></span><span class="stampchip ' + (st.closed ? 'closed' : 'open') + '">' + (st.closed ? 'Closed' : 'Live') + '</span></summary>' +
      '<div class="fbody"><div class="fclose"><button type="button" class="crumb" data-pdf="' + esc(ym) + '">Save as PDF</button></div><div class="rgrid"><div><h4 class="rh">Rent</h4>' + rent + '</div><div><h4 class="rh">Rent shares</h4>' + shares + '</div><div><h4 class="rh">Personal sessions</h4>' + sess + '</div><div><h4 class="rh">Bills</h4>' + bills + '</div></div></div></details>';
  }
  function reportLine(ym) {
    var st = monthStats(ym);
    return (st.closed ? 'Closed' : 'In progress') + ' · ' + (st.gap > 0 ? money(st.each) + ' each' : 'rent covered') + ' · dry hire ' + money(st.dryNet);
  }

  function renderFiles() {
    var weeks = valentiWeeks(), years = {};
    var addMonth = function (m) { if (!m) return; var y = m.slice(0, 4); (years[y] = years[y] || {}); (years[y][m] = years[y][m] || []); };
    ['dryhire', 'sessions', 'rent', 'bills'].forEach(function (k) { state[k].forEach(function (x) { if (!x.voided) addMonth(monthOf(x)); }); });
    /* a week is filed under the month its first entry falls in (so a week starting 28 Sep with only October entries goes in October) */
    var firstDate = function (wk) { var f = ''; ['dryhire', 'sessions'].forEach(function (k) { state[k].forEach(function (x) { if (!x.voided && inWeek(x, wk) && (!f || x.date < f)) f = x.date; }); }); return f || wk; };
    weeks.forEach(function (w) { var m = firstDate(w.wk).slice(0, 7); addMonth(m); years[m.slice(0, 4)][m].push(w); });
    var allMonths = []; Object.keys(years).forEach(function (y) { allMonths = allMonths.concat(Object.keys(years[y])); });
    if (fpath[0] && !years[fpath[0]]) fpath = [];
    if (fpath[1] && !(years[fpath[0]] && years[fpath[0]][fpath[1]])) fpath = fpath.slice(0, 1);
    var scope = weeks, crumbs = '<button type="button" class="crumb" data-fgo="root">Files</button>', body = '', empty = allMonths.length === 0;
    if (fpath.length >= 1) { crumbs += '<span class="sep">&rsaquo;</span>' + (fpath.length === 1 ? '<span class="crumb on">' + esc(fpath[0]) + '</span>' : '<button type="button" class="crumb" data-fgo="y:' + esc(fpath[0]) + '">' + esc(fpath[0]) + '</button>'); scope = []; Object.keys(years[fpath[0]]).forEach(function (m) { scope = scope.concat(years[fpath[0]][m]); }); }
    if (fpath.length === 2) { crumbs += '<span class="sep">&rsaquo;</span><span class="crumb on">' + esc(monthName(fpath[1])) + '</span>'; scope = years[fpath[0]][fpath[1]]; }
    if (fpath.length === 0) {
      body = Object.keys(years).sort().reverse().map(function (y) { var ms = Object.keys(years[y]); return folderBtn('y:' + y, y, ms.length + (ms.length === 1 ? ' month' : ' months') + ' · dry hire ' + money(ms.reduce(function (t, m) { return t + monthStats(m).dryNet; }, 0))); }).join('');
    } else if (fpath.length === 1) {
      body = Object.keys(years[fpath[0]]).sort().reverse().map(function (m) { return folderBtn('m:' + m, monthName(m), reportLine(m)); }).join('');
    } else {
      body = monthReportHtml(fpath[1]) + (scope.length ? '<h2 class="t2" style="margin:14px 0 4px">Week by week</h2>' + scope.map(function (w) { return w.html; }).join('') : '');
    }
    var last = (function () { var d = parse(today.slice(0, 7) + '-01'); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
    var jump = empty ? '' : (allMonths.indexOf(last) >= 0 ? '<button type="button" class="crumb jump" data-fgo="m:' + last + '">' + esc(monthName(last)) + ' report</button>' : '') + '<button type="button" class="crumb jump" data-fgo="m:' + today.slice(0, 7) + '">This month</button>';
    $('fvCrumbs').innerHTML = '<nav class="crumbs" aria-label="Where you are in the files">' + crumbs + jump + '</nav>';
    $('fvList').innerHTML = body;
    $('fvEmpty').hidden = !empty;
    if (fpath.length === 2) { var st = monthStats(fpath[1]), kept = 0, kk = 0; Object.keys(st.per).forEach(function (n) { kept += st.per[n].g - st.per[n].k; kk += st.per[n].k; }); $('fvTotals').innerHTML = totalsBox([['Into rent pool', money(st.dryNet)], ['Each share', money(st.each)], ['Sessions kept', money(kept)]]); }
    else { var t = sum3(scope); $('fvTotals').innerHTML = totalsBox([['Dry hire in', money(t[0])], ['Kept after Kam', money(t[1])], ['Kam\'s cut', money(t[2])]]); }
    $('fvList').className = fpath.length === 2 ? 'files' : 'files folders';
  }
  var calmMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-fclose]') : null;
    if (!b) return;
    var d = b.closest('details'), body = d && d.querySelector('.fbody');
    if (!d || !body) return;
    if (calmMotion) { d.open = false; return; }
    var h = body.offsetHeight;
    body.style.overflow = 'hidden'; body.style.height = h + 'px'; body.style.transition = 'height 0.38s ease, opacity 0.3s ease';
    void body.offsetHeight;
    body.style.height = '0px'; body.style.opacity = '0';
    setTimeout(function () { d.open = false; body.removeAttribute('style'); d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 400);
  });
  /* Save as PDF: copy the month's report into a print-only area and open the print dialog (Save as PDF lives there) */
  var plainTitle = document.title;
  window.addEventListener('afterprint', function () { document.title = plainTitle; });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-pdf]') : null;
    if (!b) return;
    e.preventDefault();
    var ym = b.getAttribute('data-pdf'), d = b.closest('details');
    if (!d) return;
    var made = new Date();
    $('printArea').innerHTML = '<div class="phead"><b>Studio 1</b><span>Valenti · ' + esc(monthName(ym, true)) + ' report · saved ' + esc(fmtLong(iso(made))) + (me ? ' by ' + esc(me.name) : '') + '</span></div>' + d.outerHTML;
    var copy = $('printArea').querySelector('details'); copy.open = true;
    Array.prototype.forEach.call($('printArea').querySelectorAll('.fclose'), function (x) { x.remove(); });
    document.title = 'Studio 1 ' + monthName(ym, true) + ' report';
    setTimeout(function () { window.print(); }, 50);
  });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-fgo]') : null;
    if (!el) return;
    var go = el.getAttribute('data-fgo');
    if (go === 'root') fpath = [];
    else if (go === 'now') { var wk = monday(today); fpath = [wk.slice(0, 4), wk.slice(0, 7)]; }
    else if (go.indexOf('y:') === 0) fpath = [go.slice(2)];
    else if (go.indexOf('m:') === 0) fpath = [go.slice(2, 6), go.slice(2)];
    renderFiles();
  });

  function render() {
    if (!me) return;
    $('weekLabel').textContent = 'Week of ' + fmtLong(monday(today));
    renderRoom(); renderRent(); renderBills(); renderSessions(); renderOwed(); renderSummary(); renderFiles(); renderBanner(); impact();
  }

  /* ---------- forms ---------- */
  /* personal session: typed price (rates vary), less an optional discount */
  function sessQuote() {
    var price = parseFloat($('sAmt').value), dv = $('sDisc').value.trim(), pct = dv === '' ? 0 : parseFloat(dv);
    var q = { price: price > 0 ? r2(price) : 0, pct: pct, ok: price > 0, bad: '' };
    if (dv !== '' && !(pct >= 0 && pct <= 100)) { q.bad = 'Discount must be between 0 and 100%.'; q.ok = false; q.pct = 0; }
    q.off = r2(q.price * (q.ok ? q.pct : 0) / 100);
    q.amount = r2(q.price - q.off);
    if (q.ok && !(q.amount > 0)) { q.ok = false; q.bad = q.bad || 'A 100% discount means nothing to log.'; }
    return q;
  }
  function kamPreview() {
    var q = sessQuote(), a = q.amount, yes = $('kamYes').checked, showCalc = q.price > 0 && ($('sDisc').value.trim() !== '' || q.bad);
    $('sCalc').hidden = !showCalc;
    if (showCalc) {
      $('sCalcLines').innerHTML = '<span>Price ' + esc(money(q.price)) + '</span>' +
        (q.off > 0 ? '<span class="off">' + esc(String(q.pct)) + '% discount: -' + esc(money(q.off)) + '</span>' : '') +
        (q.bad ? '<span class="off">' + esc(q.bad) + '</span>' : '');
      $('sTotal').textContent = money(q.ok ? a : 0);
    }
    $('kamPreview').textContent = !q.ok ? '' : yes ? 'Kam keeps ' + money(a * VAL.kam) + ' before he pays you, so you get ' + money(a * (1 - VAL.kam)) + '.' : 'No cut for Kam. You keep ' + money(a) + '.';
  }
  $('sAmt').addEventListener('input', kamPreview); $('sDisc').addEventListener('input', kamPreview); $('kamYes').addEventListener('change', kamPreview); $('kamNo').addEventListener('change', kamPreview);
  $('sessForm').addEventListener('submit', function (e) {
    e.preventDefault(); refreshToday();
    var q = sessQuote(), a = q.amount, d = $('sDate').value || today, yes = $('kamYes').checked;
    if (q.bad) { toast(q.bad); $('sDisc').focus(); return; }
    if (!q.ok || !d) { toast('Enter a session price above zero.'); $('sAmt').focus(); return; }
    var data = { date: d, amount: a, kam: yes, note: $('sNote').value.trim(), price: q.price, discount: q.pct };
    if (editing && editing.key === 'sessions') { saveEdit(data, 'Session updated.'); return; }
    chaching();
    addEntry('sessions', data); closeLog();
    $('sAmt').value = ''; $('sDisc').value = ''; $('sNote').value = ''; $('kamNo').checked = true; kamPreview();
    burst(e.submitter); toast(yes ? 'Session logged. You get ' + money(a * (1 - VAL.kam)) + ' after Kam\'s 20%.' : 'Session logged. All yours.');
  });

  /* dry hire price: hours x $60/hr, less an optional discount */
  function dryQuote() {
    var h = parseFloat($('dHours').value), dv = $('dDisc').value.trim(), pct = dv === '' ? 0 : parseFloat(dv);
    var q = { hours: h > 0 ? r2(h) : 0, pct: pct, ok: h > 0, bad: '' };
    if (dv !== '' && !(pct >= 0 && pct <= 100)) { q.bad = 'Discount must be between 0 and 100%.'; q.ok = false; q.pct = 0; }
    q.full = r2(q.hours * VAL.dryRate);
    q.off = r2(q.full * (q.ok ? q.pct : 0) / 100);
    q.amount = r2(q.full - q.off);
    if (q.ok && !(q.amount > 0)) { q.ok = false; q.bad = q.bad || 'A 100% discount means nothing to log.'; }
    return q;
  }
  function dKamPreview() {
    var q = dryQuote(), yes = $('dKamYes').checked, a = q.amount;
    if (!(q.hours > 0) && !q.bad) {
      $('dCalcLines').innerHTML = '<span class="muted">Type the hours and the price works itself out at ' + esc(money(VAL.dryRate)) + '/hr.</span>';
    } else {
      $('dCalcLines').innerHTML = '<span>' + esc(hrsTxt(q.hours)) + ' &times; ' + esc(money(VAL.dryRate)) + '/hr = ' + esc(money(q.full)) + '</span>' +
        (q.off > 0 ? '<span class="off">' + esc(String(q.pct)) + '% discount: -' + esc(money(q.off)) + ' (' + esc(money(q.amount / q.hours)) + '/hr)</span>' : '') +
        (q.bad ? '<span class="off">' + esc(q.bad) + '</span>' : '');
    }
    $('dTotal').textContent = money(q.ok ? a : 0);
    $('dKamPreview').textContent = !q.ok ? '' : yes ? 'Kam keeps ' + money(a * VAL.kam) + ' before he pays it over, so ' + money(a * (1 - VAL.kam)) + ' goes into the rent pool.' : 'No cut for Kam. All ' + money(a) + ' goes into the rent pool.';
  }
  $('dHours').addEventListener('input', dKamPreview); $('dDisc').addEventListener('input', dKamPreview); $('dKamYes').addEventListener('change', dKamPreview); $('dKamNo').addEventListener('change', dKamPreview);
  $('dRateTxt').textContent = money(VAL.dryRate);
  $('dryForm').addEventListener('submit', function (e) {
    e.preventDefault(); refreshToday();
    var q = dryQuote(), a = q.amount, d = $('dDate').value || today, yes = $('dKamYes').checked;
    if (q.bad) { toast(q.bad); $('dDisc').focus(); return; }
    if (!q.ok) { toast('Enter the hours booked.'); $('dHours').focus(); return; }
    var data = { date: d, amount: a, kam: yes, note: $('dNote').value.trim(), hours: q.hours, rate: VAL.dryRate, discount: q.pct };
    if (editing && editing.key === 'dryhire') { saveEdit(data, 'Dry hire updated.'); return; }
    addEntry('dryhire', data); closeLog();
    $('dHours').value = ''; $('dDisc').value = ''; $('dNote').value = ''; $('dKamNo').checked = true; dKamPreview();
    burst(e.submitter); toast(yes ? 'Dry hire logged. ' + money(a * (1 - VAL.kam)) + ' into the rent pool after Kam\'s 20%.' : 'Dry hire logged. ' + money(a) + ' into the rent pool.');
  });


  $('owedForm').addEventListener('submit', function (e) {
    e.preventDefault(); refreshToday();
    var a = parseFloat($('oAmt').value), d = $('oDue').value || addDays(today, 7), w = $('oWho').value.trim();
    if (!w || !(a > 0) || !d) { toast('Add a name and an amount above zero.'); return; }
    var data = { who: w, amount: r2(a), due: d, note: $('oNote').value.trim() };
    if (editing && editing.key === 'owed') { saveEdit(data, 'Updated.'); return; }
    addEntry('owed', Object.assign(data, { paid: false, paidDate: '', date: d })); closeLog();
    $('oWho').value = ''; $('oAmt').value = ''; $('oNote').value = ''; $('oDue').value = addDays(today, 7);
    toast(w + ' owes you ' + money(a) + '. It stays on the list until you tap Got it.');
  });
  $('owedList').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-paid]') : null;
    if (!btn) return;
    e.stopPropagation(); refreshToday();
    btn.disabled = true;
    var id = btn.getAttribute('data-paid'), item = state.owed.filter(function (x) { return x.id === id; })[0];
    if (!item) return;
    patchEntry('owed', id, { paid: true, paidDate: today }).then(function (ok) {
      if (!ok) { btn.disabled = false; return; }
      chaching();
      return addEntry('sessions', { amount: Number(item.amount) || 0, date: today, kam: false, owedId: item.id, note: 'Paid by ' + (item.who || 'someone') + (item.note ? ' (' + item.note + ')' : '') }).then(function () {
        burst(btn); toast('Got ' + money(item.amount) + ' from ' + (item.who || 'them') + '. Logged as your personal session.');
      });
    });
  });


  /* ---------- change or undo instead of delete ---------- */
  var editing = null;
  var EDIT = {
    dryhire: { form: 'dryForm', label: 'dGoL', add: 'Add dry hire', cancel: 'dCancel',
      fill: function (x) { $('dHours').value = x.hours > 0 ? x.hours : r2((Number(x.amount) || 0) / VAL.dryRate); $('dDisc').value = x.discount > 0 ? x.discount : ''; $('dDate').value = x.date; $('dNote').value = x.note || ''; (x.kam ? $('dKamYes') : $('dKamNo')).checked = true; dKamPreview(); },
      clear: function () { $('dHours').value = ''; $('dDisc').value = ''; $('dNote').value = ''; $('dDate').value = today; $('dKamNo').checked = true; dKamPreview(); } },
    sessions: { form: 'sessForm', label: 'sGoL', add: 'Log session', cancel: 'sCancel',
      fill: function (x) { $('sAmt').value = x.price > 0 ? x.price : x.amount; $('sDisc').value = x.discount > 0 ? x.discount : ''; $('sDate').value = x.date; $('sNote').value = x.note || ''; (x.kam ? $('kamYes') : $('kamNo')).checked = true; kamPreview(); },
      clear: function () { $('sAmt').value = ''; $('sDisc').value = ''; $('sNote').value = ''; $('sDate').value = today; $('kamNo').checked = true; kamPreview(); } },
    owed: { form: 'owedForm', label: 'oGoL', add: 'Add to owed list', cancel: 'oCancel',
      fill: function (x) { $('oWho').value = x.who || ''; $('oAmt').value = x.amount; $('oDue').value = x.due; $('oNote').value = x.note || ''; },
      clear: function () { $('oWho').value = ''; $('oAmt').value = ''; $('oNote').value = ''; $('oDue').value = addDays(today, 7); } },
    rent: { form: 'rentForm', label: 'rGoL', add: 'Save my rent payment', cancel: 'rCancel',
      fill: function (x) { $('rAmt').value = x.amount; $('rDate').value = x.date; $('rNote').value = x.note || ''; rentPreview(); },
      clear: function () { $('rAmt').value = ''; $('rDate').value = today; $('rNote').value = ''; rentPreview(); } },
    bills: { form: 'billForm', label: 'bGoL', add: 'Add bill', cancel: 'bCancel',
      fill: function (x) { $('bAmt').value = x.amount; $('bDate').value = x.date; $('bWhat').value = x.note || ''; $('bDue').value = x.due || ''; billPreview(); },
      clear: function () { $('bAmt').value = ''; $('bDate').value = today; $('bWhat').value = ''; $('bDue').value = ''; billPreview(); } }
  };
  function findEntry(key, id) { return state[key].filter(function (x) { return x.id === id; })[0]; }
  function startEdit(key, id) {
    var x = findEntry(key, id); if (!x) return;
    if (editing) endEdit(true);
    editing = { key: key, id: id };
    var c = EDIT[key]; c.fill(x);
    if (c.label) $(c.label).textContent = 'Save changes';
    $(c.cancel).hidden = false; $(c.form).classList.add('editing');
    render();
    if (key === 'paid') $(c.form).scrollIntoView({ behavior: calmMotion ? 'auto' : 'smooth', block: 'center' });
    else openLog(key, true);
  }
  function endEdit(quiet) {
    if (!editing) return;
    var c = EDIT[editing.key];
    c.clear(); if (c.label) $(c.label).textContent = c.add;
    $(c.cancel).hidden = true; $(c.form).classList.remove('editing');
    var wasSheet = editing.key !== 'paid';
    editing = null;
    if (wasSheet) hideLog();
    if (!quiet) render();
  }

  /* ---------- the + Log pop-up: pick what to log, then one short form ---------- */
  var LOG_TITLES = { dryhire: 'Dry hire', sessions: 'Session', owed: 'Someone owes me', rent: 'My rent share', bills: 'Bill to split' };
  function openLog(pane, isEdit) {
    if (!isEdit && editing && editing.key !== 'paid') endEdit(true);
    $('logWrap').hidden = false;
    $('logPick').hidden = !!pane;
    Array.prototype.forEach.call(document.querySelectorAll('.logpane'), function (el) { el.hidden = el.getAttribute('data-pane') !== pane; });
    $('logH').textContent = pane ? (isEdit ? 'Change ' : '') + LOG_TITLES[pane] : 'Log something';
    if (pane === 'rent' && !isEdit) prefillRent();
    if (pane && !isEdit) {
      if (pane === 'bills') { $('bDate').value = $('bDate').value || today; billPreview(); }
      var first = { dryhire: 'dHours', sessions: 'sAmt', owed: 'oWho', rent: 'rAmt', bills: 'bAmt' }[pane];
      setTimeout(function () { try { $(first).focus({ preventScroll: true }); } catch (e) {} }, 60);
    }
  }
  function hideLog() { $('logWrap').hidden = true; }
  function closeLog() { if (editing && editing.key !== 'paid') endEdit(); hideLog(); }
  $('logFab').addEventListener('click', function () { openLog(null); });
  $('logClose').addEventListener('click', closeLog);
  $('logWrap').addEventListener('click', function (e) { if (e.target === $('logWrap')) closeLog(); });
  $('logPick').addEventListener('click', function (e) { var b = e.target.closest('[data-pane]'); if (b) openLog(b.getAttribute('data-pane')); });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-log]') : null;
    if (b) { openLog(b.getAttribute('data-log')); return; }
    var j = e.target && e.target.closest ? e.target.closest('[data-jump]') : null;
    if (j) { var t = $(j.getAttribute('data-jump')); if (t) t.scrollIntoView({ behavior: calmMotion ? 'auto' : 'smooth', block: 'start' }); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('logWrap').hidden) closeLog(); });

  /* ---------- rent shares: who has paid their part this month ---------- */
  function rentNumbers() {
    var month = today.slice(0, 7), dry = 0;
    state.dryhire.forEach(function (x) { if (x.date.slice(0, 7) === month) dry += dryNet(x); });
    var gap = Math.max(0, VAL.rent - dry);
    return { month: month, dry: dry, gap: gap, each: r2(gap / VAL.partners) };
  }
  function paidBy(name, month) {
    var t = 0; state.rent.forEach(function (x) { if (!x.voided && x.by === name && (x.month || x.date.slice(0, 7)) === month) t += Number(x.amount) || 0; });
    return r2(t);
  }
  function renderRent() {
    var n = rentNumbers(), names = people.slice();
    if (me && names.indexOf(me.name) < 0) names.push(me.name);
    $('sharesLbl').textContent = 'Rent shares for ' + monthName(n.month);
    $('rentMissing').hidden = !rentMissing; $('payShare').hidden = rentMissing;
    $('shareList').innerHTML = rentMissing ? '' : names.map(function (nm) {
      var p = paidBy(nm, n.month), st;
      if (n.each <= 0) st = '<span class="st ok">Nothing to pay</span>';
      else if (p >= n.each - 0.005) st = '<span class="st ok">Paid ' + money(p) + ' &#10003;</span>';
      else if (p > 0) st = '<span class="st part">Paid ' + money(p) + ', ' + money(n.each - p) + ' to go</span>';
      else st = '<span class="st no">Not paid yet</span>';
      return '<li><span class="who">' + esc(nm) + (me && nm === me.name ? ' (you)' : '') + '</span>' + st + '</li>';
    }).join('');
    var mine = me ? paidBy(me.name, n.month) : 0;
    $('payShareL').textContent = mine > 0 ? 'Add a rent payment' : 'Mark my share paid';
    var rows = state.rent.filter(function (x) { return (x.month || x.date.slice(0, 7)) === n.month; }).sort(byDateDesc);
    $('rentList').innerHTML = rows.map(function (x) { return rowHtml(x, 'rent', 'Rent share', x.note, money(x.amount)); }).join('');
  }
  function prefillRent() {
    var n = rentNumbers(), left = me ? r2(Math.max(0, n.each - paidBy(me.name, n.month))) : n.each;
    $('rAmt').value = left > 0 ? left : ''; $('rDate').value = today; $('rNote').value = '';
    rentPreview();
  }
  function rentPreview() {
    var n = rentNumbers(), a = parseFloat($('rAmt').value);
    $('rPreview').textContent = 'Your share of ' + monthName(n.month) + ' rent is ' + money(n.each) + (a > 0 ? '. You\'re logging ' + money(a) + '.' : '.');
  }
  $('rAmt').addEventListener('input', rentPreview);
  $('payShare').addEventListener('click', function () {
    if (rentNumbers().each <= 0) { toast('Dry hire covers the rent this month, so there\'s no share to pay.'); return; }
    openLog('rent');
  });
  $('rentForm').addEventListener('submit', function (e) {
    e.preventDefault(); refreshToday();
    var a = parseFloat($('rAmt').value), d = $('rDate').value || today;
    if (!(a > 0)) { toast('Enter the amount you paid.'); $('rAmt').focus(); return; }
    var data = { amount: r2(a), date: d, note: $('rNote').value.trim() };
    if (editing && editing.key === 'rent') { saveEdit(data, 'Rent payment updated.'); return; }
    addEntry('rent', Object.assign(data, { month: today.slice(0, 7) })).then(function (r) { if (r) toast('Logged ' + money(a) + ' toward your ' + monthName(today.slice(0, 7)) + ' rent share.'); });
    closeLog(); burst(e.submitter);
  });

  /* ---------- bills: Kam sends a bill, it's split between the four, each person marks their share paid ---------- */
  function billShare(b) { return r2((Number(b.amount) || 0) / VAL.partners); }
  function billPaidBy(b, name) {
    var t = 0; state.billpaid.forEach(function (p) { if (!p.voided && p.billId === b.id && p.by === name) t += Number(p.amount) || 0; });
    return r2(t);
  }
  function billNames() { var n = people.slice(); if (me && n.indexOf(me.name) < 0) n.push(me.name); return n; }
  function billLeft(b) { var each = billShare(b); return billNames().filter(function (n) { return billPaidBy(b, n) < each - 0.005; }); }
  function billOpen(b) { return !b.voided && billLeft(b).length > 0; }
  function iOwe(b) { return !!me && !b.voided && billPaidBy(b, me.name) < billShare(b) - 0.005; }
  function billWhat(b) { return b.note || 'Bill'; }
  function billRow(b) {
    var each = billShare(b), names = billNames();
    var who = names.map(function (n) { var ok = billPaidBy(b, n) >= each - 0.005; return '<span class="chip ' + (ok ? 'bank' : 'wait') + '">' + esc(n) + (ok ? ' &#10003;' : '') + '</span>'; }).join('');
    var mine = state.billpaid.filter(function (p) { return p.billId === b.id && !p.voided && own(p); });
    var btns = '';
    if (!b.voided) {
      if (iOwe(b)) btns += '<button class="pay" type="button" data-billpay="' + esc(b.id) + '">I paid my share</button>';
      else if (mine.length) btns += actBtn('undo', 'billpaid', mine[mine.length - 1], 'Not paid yet');
    }
    if (own(b)) btns += b.voided ? actBtn('restore', 'bills', b, 'Restore') + actBtn('delete', 'bills', b, 'Delete') :actBtn('edit', 'bills', b, 'Edit') + actBtn('undo', 'bills', b, 'Undo');
    return liOpen(b) + '<span class="d">' + esc(fmtDay(b.date)) + '</span><span class="t">' + esc(billWhat(b)) + ' <small>' + esc(joinBits([money(each) + ' each', b.due ? 'due ' + fmtDay(b.due) : '', editedNote(b)])) + '</small>' +
      (b.voided ? '<span class="chip late">Undone</span>' : (b.due && billOpen(b) ? dueChip(b) : '')) + byChip(b) + '<br>' + who +
      '</span><span class="a">' + money(b.amount) + '</span>' + (btns ? '<span class="acts">' + btns + '</span>' : '') + '</li>';
  }
  function renderBills() {
    $('billsMissing').hidden = !billsMissing; $('billsAdd').hidden = billsMissing;
    var open = state.bills.filter(billOpen).sort(function (a, b) { return (a.due || a.date) < (b.due || b.date) ? -1 : 1; });
    var done = state.bills.filter(function (b) { return !billOpen(b); }).sort(byDateDesc).slice(0, 5);
    var owe = 0; open.forEach(function (b) { if (iOwe(b)) owe += billShare(b) - billPaidBy(b, me.name); });
    $('billsOwe').textContent = open.length === 0 ? 'No bills waiting. When Kam sends one, add it and it\'s split ' + VAL.partners + ' ways.' : owe > 0.005 ? 'Your share still to pay: ' + money(owe) + '.' : 'You\'ve paid your share of every open bill.';
    $('billList').innerHTML = open.map(billRow).join('');
    $('billDone').innerHTML = done.length ? '<h2 class="t2" style="margin-top:18px">Settled</h2><ul class="entries">' + done.map(billRow).join('') + '</ul>' : '';
  }
  function billPreview() {
    var a = parseFloat($('bAmt').value);
    $('bPreview').textContent = a > 0 ? 'Split ' + VAL.partners + ' ways: ' + money(r2(a / VAL.partners)) + ' each.' : 'Type the bill total and it\'s split ' + VAL.partners + ' ways.';
  }
  $('bAmt').addEventListener('input', billPreview);
  $('billForm').addEventListener('submit', function (e) {
    e.preventDefault(); refreshToday();
    var a = parseFloat($('bAmt').value), d = $('bDate').value || today, what = $('bWhat').value.trim();
    if (!(a > 0)) { toast('Enter the bill total.'); $('bAmt').focus(); return; }
    var data = { amount: r2(a), date: d, note: what, due: $('bDue').value || '' };
    if (editing && editing.key === 'bills') { saveEdit(data, 'Bill updated.'); return; }
    addEntry('bills', data).then(function (r) { if (r) toast((what || 'Bill') + ' added: ' + money(r2(a / VAL.partners)) + ' each. Everyone can see it.'); });
    closeLog(); burst(e.submitter);
    EDIT.bills.clear();
  });
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-billpay]') : null;
    if (!btn) return;
    e.stopPropagation(); refreshToday();
    var b = findEntry('bills', btn.getAttribute('data-billpay'));
    if (!b || !me) return;
    var left = r2(billShare(b) - billPaidBy(b, me.name));
    if (left <= 0) return;
    btn.disabled = true;
    addEntry('billpaid', { billId: b.id, date: today, amount: left, note: '' }).then(function (r) {
      if (!r) { btn.disabled = false; return; }
      chaching(); toast('Marked your ' + money(left) + ' share of ' + billWhat(b) + ' as paid.');
    });
  });

  /* ---------- summary tiles ---------- */
  function renderSummary() {
    var n = rentNumbers(), month = n.month, mine = 0, mineKam = 0, owedMe = 0, owedN = 0, late = 0;
    state.sessions.forEach(function (s) { if (own(s) && s.date.slice(0, 7) === month) { mine += val(s); mineKam += sessKam(s); } });
    state.owed.forEach(function (x) { if (own(x) && !x.paid && !x.voided) { owedMe += val(x); owedN++; if (daysTo(x.due) < 0) late++; } });
    var myPaid = me ? paidBy(me.name, month) : 0;
    $('sumRent').textContent = n.gap > 0 ? money(n.each) : 'Covered';
    $('sumRentSub').textContent = n.gap > 0 ? 'each · ' + Math.round(n.dry / VAL.rent * 100) + '% covered by dry hire' + (rentMissing ? '' : myPaid >= n.each - 0.005 ? ' · you\'ve paid' : myPaid > 0 ? ' · you\'ve paid ' + money(myPaid) : ' · you haven\'t paid yet') : 'Dry hire covers ' + monthName(month) + ' rent';
    $('sumRent').parentNode.classList.toggle('good', n.gap <= 0 || (!rentMissing && myPaid >= n.each - 0.005));
    $('sumMineLbl').textContent = 'Your ' + monthName(month) + ' sessions';
    $('sumMine').textContent = money(mine - mineKam);
    $('sumMineSub').textContent = mineKam > 0 ? 'after Kam\'s ' + money(mineKam) : 'yours to keep';
    var dn = 0, dh = 0; state.dryhire.forEach(function (x) { if (!x.voided && x.date.slice(0, 7) === month) { dn++; dh += Number(x.hours) || 0; } });
    $('sumDryLbl').textContent = monthName(month) + ' dry hire';
    $('sumDry').textContent = money(n.dry);
    $('sumDrySub').textContent = dn === 0 ? 'no bookings yet' : dn + (dn === 1 ? ' booking' : ' bookings') + (dh > 0 ? ', ' + hrsTxt(dh) : '') + ' · into the rent pool';
    $('sumOwed').textContent = money(owedMe);
    $('sumOwedSub').textContent = owedN === 0 ? 'nobody owes you' : owedN + (owedN === 1 ? ' person' : ' people') + (late ? ', ' + late + ' overdue' : '');
    $('sumOwed').parentNode.classList.toggle('alert', late > 0);
  }
  function saveEdit(data, msg) {
    var ed = editing;
    patchEntry(ed.key, ed.id, data).then(function (ok) { if (ok) { endEdit(); toast(msg); } });
  }
  ['dCancel', 'sCancel', 'oCancel', 'rCancel', 'bCancel'].forEach(function (id) { $(id).addEventListener('click', function () { endEdit(); }); });
  /* an undone "Got it" (or undoing a paid-back entry) also undoes the session it created */
  function setLinkedSessions(owedId, voided) {
    return Promise.all(state.sessions.filter(function (s) { return s.owedId === owedId && !!s.voided !== voided; }).map(function (s) { return patchEntry('sessions', s.id, { voided: voided }); }));
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (e.target && e.target.id === 'retryLoad') { loadAll(); return; }
    if (e.target && e.target.id === 'openLastReport') { var m = e.target.getAttribute('data-month'); fpath = [m.slice(0, 4), m]; setView('files'); renderFiles(); return; }
    if (!t) return;
    var act = t.getAttribute('data-act'), key = t.getAttribute('data-coll'), id = t.getAttribute('data-id'), x = findEntry(key, id);
    if (!x) return;
    if (act === 'edit') { startEdit(key, id); return; }
    if (editing && editing.id === id) endEdit(true);
    if (act === 'undo') {
      patchEntry(key, id, { voided: true }).then(function (ok) {
        if (!ok) return;
        if (key === 'owed' && x.paid) setLinkedSessions(id, true);
        toast(key === 'billpaid' ? 'Marked your share as not paid yet.' : 'Undone. It stays on record but no longer counts. Tap Restore to bring it back.');
      });
    } else if (act === 'restore') {
      patchEntry(key, id, { voided: false }).then(function (ok) {
        if (!ok) return;
        if (key === 'owed' && x.paid) setLinkedSessions(id, false);
        toast('Restored. It counts again.');
      });
    } else if (act === 'delete') {
      if (!window.confirm('Delete this for good? It will be gone for everyone and can\'t be brought back.')) return;
      delEntry(key, id).then(function (ok) {
        if (!ok) return;
        if (key === 'bills') state.billpaid = state.billpaid.filter(function (p) { return p.billId !== id; });
        saveLocal(); render(); toast('Deleted.');
      });
    } else if (act === 'unpay') {
      patchEntry('owed', id, { paid: false, paidDate: '' }).then(function (ok) {
        if (!ok) return;
        setLinkedSessions(id, true);
        toast((x.who || 'They') + ' is back on the owed list, and the session it logged is undone.');
      });
    }
  });

  /* ---------- impact: number tweens, confetti, panel reveal ---------- */
  function tweenNum(id) {
    var el = $(id); if (!el) return;
    var txt = el.textContent, prev = el.dataset.final;
    if (txt === prev) return;
    el.dataset.final = txt;
    var m = txt.match(/-?\$?[\d,]+(\.\d+)?/); if (!m || calmMotion) return;
    var to = parseFloat(m[0].replace(/[$,]/g, '')), neg = m[0].charAt(0) === '-', dec = m[1] ? m[1].length - 1 : 0;
    var from = el._v || 0; el._v = to;
    var pre = txt.slice(0, m.index), post = txt.slice(m.index + m[0].length), t0 = performance.now(), dur = 800;
    cancelAnimationFrame(el._raf);
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur), ez = 1 - Math.pow(1 - k, 3), v = from + (to - from) * ez;
      var f = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      el.textContent = pre + (neg ? '-' : '') + (m[0].indexOf('$') >= 0 ? '$' : '') + f + post;
      if (k < 1) el._raf = requestAnimationFrame(step); else el.textContent = txt;
    })(t0);
  }
  function impact() { ['vGross', 'vMine', 'rmIn', 'rmEach', 'rmGap', 'owedTotal'].forEach(tweenNum); }

  var cv = document.createElement('canvas'); cv.id = 'confetti'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv);
  var bits = [], cfRun = false;
  function burst(fromEl) {
    if (calmMotion) return;
    var r = fromEl && fromEl.getBoundingClientRect ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    var x = r.left + r.width / 2, y = r.top + r.height / 2, cs = getComputedStyle(document.documentElement), cols = ['--accent', '--accent2', '--g1', '--g2', '--pop'].map(function (k) { return (cs.getPropertyValue(k) || '').trim() || '#2F66F0'; }).concat(['#FFFFFF']);
    for (var i = 0; i < 90; i++) { var a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 9; bits.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, w: 5 + Math.random() * 7, h: 3 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length], life: 90 + Math.random() * 40 }); }
    if (!cfRun) { cfRun = true; cv.width = innerWidth; cv.height = innerHeight; requestAnimationFrame(confettiFrame); }
  }
  function confettiFrame() {
    var g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    bits = bits.filter(function (p) { return p.life > 0 && p.y < cv.height + 40; });
    bits.forEach(function (p) { p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--; g.save(); g.globalAlpha = Math.min(1, p.life / 30); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore(); });
    if (bits.length) requestAnimationFrame(confettiFrame); else { cfRun = false; g.clearRect(0, 0, cv.width, cv.height); }
  }

  var mastEl = document.querySelector('.mast');
  if (mastEl && !calmMotion) {
    window.addEventListener('pointermove', function (e) { mastEl.style.setProperty('--px', ((e.clientX / innerWidth) - 0.5).toFixed(3)); mastEl.style.setProperty('--py', ((e.clientY / innerHeight) - 0.5).toFixed(3)); }, { passive: true });
  }
  if ('IntersectionObserver' in window && !calmMotion) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }); }, { threshold: 0.08 });
    Array.prototype.forEach.call(document.querySelectorAll('section.panel'), function (p) { p.classList.add('rv'); io.observe(p); });
  }

  /* ---------- themes and self-test ---------- */
  var THEMES = [
    { id: 'sheet', name: 'Track sheet', note: 'Paper, black ink and a red record light', bg: '#F3EEE3', a: '#16140F', b: '#E2402B', bar: '#F3EEE3' },
    { id: 'control', name: 'Control room', note: 'Lights down, red on black', bg: '#121212', a: '#F1ECE0', b: '#FF4A2E', bar: '#121212' },
    { id: 'tape', name: 'Tape box', note: 'Kraft card, cream labels, blue pen', bg: '#C9AE85', a: '#2B1A0C', b: '#1F5C8C', bar: '#F4E9D3' },
    { id: 'console', name: 'Console', note: 'Slate desk, cream faders, orange keys', bg: '#2F3B44', a: '#E4E1D8', b: '#E8762B', bar: '#2F3B44' },
    { id: 'night', name: 'Night session', note: 'Deep navy with mint meters', bg: '#0E1626', a: '#E6F1EE', b: '#5EE0B8', bar: '#0E1626' }
  ];
  var CUR_INK = { sheet: '#16140F', control: '#FF4A2E', tape: '#2B1A0C', console: '#E8762B', night: '#2A9C7C' };
  function currentTheme() { var t = document.documentElement.getAttribute('data-theme') || 'sheet'; return THEMES.some(function (x) { return x.id === t; }) ? t : 'sheet'; }
  /* the pointing hand, outlined in the theme's ink; pressed version tilts in with little lines */
  function handSvg(c, down) {
    c = encodeURIComponent(c);
    var hand = "<g fill='%23ffffff' stroke='" + c + "' stroke-width='3.6' stroke-linejoin='round'><rect x='11' y='2.5' width='6' height='16' rx='3'/><rect x='8' y='13' width='18' height='13' rx='5.5'/><rect x='4' y='14' width='8' height='6' rx='3' transform='rotate(35 8 17)'/></g><g fill='%23ffffff'><rect x='11' y='2.5' width='6' height='16' rx='3'/><rect x='8' y='13' width='18' height='13' rx='5.5'/><rect x='4' y='14' width='8' height='6' rx='3' transform='rotate(35 8 17)'/></g><path d='M14 21v-3M17.5 21v-3M21 21v-3' stroke='" + c + "' stroke-width='1.4' stroke-linecap='round' fill='none'/><rect x='9.5' y='26.2' width='15' height='4' rx='1.6' fill='" + c + "'/>";
    var body = down ? "<path d='M8.5 4.5L6.5 2.5M14 3.5V0.8M19.5 4.5L21.5 2.5' stroke='" + c + "' stroke-width='1.8' stroke-linecap='round' fill='none'/><g transform='translate(1.2 3.2) scale(0.92)'>" + hand + "</g>" : hand;
    return 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\' viewBox=\'0 0 32 32\'>' + body + '</svg>") ' + (down ? '14 6' : '14 3') + ', auto';
  }
  function syncThemeColor(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t.bar);
    var c = CUR_INK[t.id] || '#16140F', rs = document.documentElement.style;
    rs.setProperty('--cur', handSvg(c, false)); rs.setProperty('--cur-down', handSvg(c, true));
  }
  function applyTheme(id) {
    if (id === 'sheet') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', id);
    lsSet('valenti-theme', id); syncThemeColor(id); drawThemes();
  }
  function drawThemes() {
    var cur = currentTheme();
    $('themeList').innerHTML = THEMES.map(function (t) {
      return '<button type="button" class="theme-opt" role="radio" aria-checked="' + (t.id === cur) + '" data-theme-id="' + t.id + '"><span class="swatch" style="background:' + t.bg + '"><i style="background:' + t.a + '"></i><u style="background:' + t.b + '"></u></span><span><b>' + esc(t.name) + '</b><small>' + esc(t.note) + '</small></span><span class="tick" aria-hidden="true">&#10003;</span></button>';
    }).join('');
  }
  syncThemeColor(currentTheme());
  $('themeBtn').addEventListener('click', function (e) { e.stopPropagation(); drawThemes(); $('themeWrap').hidden = false; });
  $('themeClose').addEventListener('click', function () { $('themeWrap').hidden = true; });
  $('themeWrap').addEventListener('click', function (e) { if (e.target === $('themeWrap')) $('themeWrap').hidden = true; });
  $('themeList').addEventListener('click', function (e) { var b = e.target.closest('[data-theme-id]'); if (b) applyTheme(b.getAttribute('data-theme-id')); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('themeWrap').hidden = true; });
  $('diagBtn').addEventListener('click', function () {
    var out = [];
    out.push('Browser: ' + navigator.userAgent.slice(0, 100));
    out.push('Storage: ' + (CLOUD ? 'shared database (Supabase)' : 'test mode, this browser only'));
    out.push('Signed in as: ' + (me ? me.name : 'nobody'));
    out.push('Script errors: ' + (window.__skyErrs && window.__skyErrs.length ? window.__skyErrs.join(' | ') : 'none'));
    if (!me) { $('diagOut').textContent = out.join('\n'); return; }
    out.push('Saving a $1 test dry hire...');
    $('diagOut').textContent = out.join('\n');
    addEntry('dryhire', { date: today, amount: 1, kam: false, note: 'Studio 1 self-test' }).then(function (row) {
      out.push(row ? 'Saved: yes' : 'Saved: NO (see the red bar)');
      $('diagOut').textContent = out.join('\n');
      if (!row) return;
      setTimeout(function () {
        var p = CLOUD ? loadTable('dryhire') : Promise.resolve();
        p.then(function () {
          var found = state.dryhire.some(function (x) { return x.id === row.id; });
          out.push('Read back after 2 seconds: ' + (found ? 'yes' : 'NO (the save was lost)'));
          return delEntry('dryhire', row.id);
        }).then(function (ok) {
          out.push(ok ? 'Test row removed. All good.' : 'Could not remove the test row. Delete "Studio 1 self-test" by hand.');
          out.push('Screenshot this and send it to Sasha if something is wrong.');
          $('diagOut').textContent = out.join('\n'); render();
        }).catch(function (e) { out.push('Read back failed: ' + errMsg(e)); $('diagOut').textContent = out.join('\n'); });
      }, 2000);
    });
  });

  /* ---------- session timer ---------- */
  var tm = { acc: 0, start: null, rate: '' };
  try { var tj = JSON.parse(lsGet('valenti-timer') || 'null'); if (tj) tm = tj; } catch (e) {}
  function tmSave() { lsSet('valenti-timer', JSON.stringify(tm)); }
  function tmMs() { return tm.acc + (tm.start ? Date.now() - tm.start : 0); }
  function tmDraw() {
    var ms = tmMs(), sec = Math.floor(ms / 1000), rate = parseFloat($('tmRate').value) || 0;
    $('tmClock').textContent = Math.floor(sec / 3600) + ':' + pad(Math.floor(sec % 3600 / 60)) + ':' + pad(sec % 60);
    $('tmAmt').textContent = money(rate * ms / 3600000);
    $('tmBox').classList.toggle('run', !!tm.start); $('recLamp').classList.toggle('on', !!tm.start);
    $('tmGoL').textContent = tm.start ? 'Pause' : (tm.acc > 0 ? 'Resume' : 'Start');
  }
  $('tmRate').value = tm.rate || '';
  setInterval(function () { if (tm.start) tmDraw(); }, 250);
  $('tmRate').addEventListener('input', function () { tm.rate = $('tmRate').value; tmSave(); tmDraw(); });
  $('tmGo').addEventListener('click', function () { if (tm.start) { tm.acc += Date.now() - tm.start; tm.start = null; } else tm.start = Date.now(); tmSave(); tmDraw(); });
  $('tmReset').addEventListener('click', function () { tm = { acc: 0, start: null, rate: $('tmRate').value }; tmSave(); tmDraw(); });
  $('tmLog').addEventListener('click', function () {
    refreshToday();
    var rate = parseFloat($('tmRate').value) || 0, ms = tmMs(), amt = r2(rate * ms / 3600000);
    if (!(amt > 0)) { toast('Set a rate and run the timer first.'); return; }
    var sec = Math.floor(ms / 1000);
    chaching();
    addEntry('sessions', { amount: amt, date: today, kam: $('tmKam').checked, note: 'Timed session ' + Math.floor(sec / 3600) + 'h ' + pad(Math.floor(sec % 3600 / 60)) + 'm' });
    tm = { acc: 0, start: null, rate: $('tmRate').value }; tmSave(); tmDraw(); $('tmKam').checked = false;
    toast('Logged ' + money(amt) + ' as your personal session.'); try { burst($('tmBox')); } catch (e) {}
  });
  tmDraw();

  /* ---------- ripples, orbs, panel glow ---------- */
  document.addEventListener('pointerdown', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.btn, .tab, .sbtn, .crumb, .themebtn, .pay, .folder, .theme-opt') : null;
    if (!t || t.disabled) return;
    try { if (navigator.vibrate) navigator.vibrate(6); } catch (er) {}
    var r = t.getBoundingClientRect(), sz = Math.max(r.width, r.height) * 2, sp = document.createElement('span');
    sp.className = 'ripple'; sp.style.width = sp.style.height = sz + 'px'; sp.style.left = (e.clientX - r.left - sz / 2) + 'px'; sp.style.top = (e.clientY - r.top - sz / 2) + 'px';
    t.appendChild(sp); setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 650);
  });
  var mvRaf = 0, mvE = null;
  document.addEventListener('pointermove', function (e) {
    mvE = e; if (mvRaf) return;
    mvRaf = requestAnimationFrame(function () {
      mvRaf = 0; var ev = mvE; if (!ev) return;
            var p = ev.target && ev.target.closest ? ev.target.closest('.panel') : null;
      if (p) { var r = p.getBoundingClientRect(); p.style.setProperty('--mx', (ev.clientX - r.left) + 'px'); p.style.setProperty('--my', (ev.clientY - r.top) + 'px'); }
    });
  }, { passive: true });

  /* ---------- cha-ching when a payment is marked (the owner removed the tap "drop" sound) ---------- */
  var sndOn = lsGet('valenti-sound') !== '0', actx = null;
  function syncSnd() { $('sndOn').checked = sndOn; var b = $('sndBtn'); b.textContent = 'Sound: ' + (sndOn ? 'On' : 'Off'); b.setAttribute('aria-pressed', sndOn ? 'true' : 'false'); b.style.opacity = sndOn ? '' : '0.6'; }
  function setSnd(v) { sndOn = v; lsSet('valenti-sound', v ? '1' : '0'); syncSnd(); }
  syncSnd();
  $('sndBtn').addEventListener('click', function () { setSnd(!sndOn); });
  $('sndOn').addEventListener('change', function () { setSnd($('sndOn').checked); });
  function audio() {
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    if (!actx) actx = new AC(); if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function chaching() {
    if (!sndOn) return;
    try {
      var ac = audio(); if (!ac) return;
      var t0 = ac.currentTime;
      var bell = function (t, f, dur, vol) {
        [1, 2.76, 5.4].forEach(function (m, i) {
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine'; o.frequency.value = f * m;
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol / (i + 1), t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur / (i + 1));
          o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
        });
      };
      var n = ac.createBufferSource(), len = Math.floor(ac.sampleRate * 0.05), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      n.buffer = buf; var hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500; var ng = ac.createGain(); ng.gain.value = 0.18;
      n.connect(hp); hp.connect(ng); ng.connect(ac.destination); n.start(t0);
      bell(t0 + 0.02, 1318.5, 0.16, 0.16);
      bell(t0 + 0.13, 1975.5, 0.7, 0.2);
    } catch (e) {}
  }
  var root = document.documentElement;
  document.addEventListener('pointerdown', function (e) { if (e.button > 0) return; root.classList.add('pressing'); }, true);
  document.addEventListener('pointerup', function () { root.classList.remove('pressing'); }, true);
  document.addEventListener('pointercancel', function () { root.classList.remove('pressing'); }, true);
  window.addEventListener('blur', function () { root.classList.remove('pressing'); });

  /* ---------- tabs ---------- */
  var view = 'val';
  function setView(v, keep) {
    view = v === 'files' ? 'files' : 'val';
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (el) { el.hidden = (' ' + el.getAttribute('data-view') + ' ').indexOf(' ' + view + ' ') < 0; });
    $('tabVal').setAttribute('aria-selected', view === 'val'); $('tabFiles').setAttribute('aria-selected', view === 'files');
    syncFab();
    if (!keep) { lsSet('valenti-view', view); window.scrollTo(0, 0); }
  }
  $('tabVal').addEventListener('click', function () { setView('val'); });
  $('tabFiles').addEventListener('click', function () { setView('files'); });
  setView(lsGet('valenti-view') || 'val', true);

  /* the page can stay open past midnight: keep "today" and the default dates fresh */
  function refreshToday() {
    var n = iso(new Date()); if (n === today) return;
    var old = today; today = n;
    ['sDate', 'dDate'].forEach(function (id) { if ($(id).value === old) $(id).value = today; });
    if ($('oDue').value === addDays(old, 7)) $('oDue').value = addDays(today, 7);
    render();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshToday(); if (CLOUD && me) loadAll(); } });
  window.addEventListener('focus', refreshToday);
  setInterval(refreshToday, 30000);

  /* Sandboxed previews block native form submission, so the submit event never fires.
     Handle submit buttons ourselves and hand the form its own submit event. */
  document.addEventListener('click', function (e) {
    var t = e.target, btn = t && t.closest ? t.closest('button') : null;
    if (!btn || btn.disabled) return;
    var type = (btn.getAttribute('type') || 'submit').toLowerCase();
    var form = btn.form || (btn.closest ? btn.closest('form') : null);
    if (type !== 'submit' || !form) return;
    e.preventDefault();
    var ev;
    try { ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: btn }); }
    catch (er) { ev = document.createEvent('Event'); ev.initEvent('submit', true, true); try { Object.defineProperty(ev, 'submitter', { value: btn }); } catch (e2) {} }
    form.dispatchEvent(ev);
  }, true);

  /* ---------- signing in ---------- */
  function syncFab() { $('logFab').hidden = !(me && view === 'val'); }
  function showAuth(part) {
    me = null; syncFab(); hideLog();
    $('appBody').hidden = true; $('userChip').hidden = true; $('authPanel').hidden = false;
    $('authCloud').hidden = !CLOUD; $('authLocal').hidden = CLOUD;
    if (CLOUD) {
      $('authForm').hidden = part !== 'login'; $('resetForm').hidden = part !== 'reset'; $('notMember').hidden = part !== 'notmember';
      $('authH').textContent = part === 'reset' ? 'New password' : part === 'notmember' ? 'Not on the list yet' : (signUp ? 'Make your login' : 'Sign in');
    }
  }
  function enterApp(person) {
    me = person;
    $('userName').textContent = person.name; $('userChip').hidden = false;
    $('authPanel').hidden = true; $('appBody').hidden = false; syncFab();
    render();
  }

  /* test mode: pick who you are */
  function localBoot() {
    loadLocal();
    $('whoGrid').innerHTML = PEOPLE.map(function (p) { return '<button type="button" class="btn" data-who="' + esc(p) + '">' + esc(p) + '</button>'; }).join('');
    $('whoGrid').addEventListener('click', function (e) {
      var b = e.target.closest('[data-who]'); if (!b) return;
      var n = b.getAttribute('data-who'); lsSet('valenti-local-who', n);
      enterApp({ name: n, id: 'local:' + n });
    });
    var who = lsGet('valenti-local-who');
    if (who && PEOPLE.indexOf(who) >= 0) enterApp({ name: who, id: 'local:' + who }); else showAuth('login');
  }

  /* shared mode: Supabase email + password */
  var signUp = false, entering = null;
  function setAuthMode(up) {
    signUp = up;
    $('aGoL').textContent = up ? 'Make my login' : 'Sign in';
    $('aMode').textContent = up ? 'I already have a login' : 'First time? Make my login';
    $('aPass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    $('authH').textContent = up ? 'Make your login' : 'Sign in';
    $('aErr').textContent = '';
  }
  function authErr(msg) { $('aErr').textContent = msg; }
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = ok; s.onerror = function () { bad(new Error('could not load the login library (are you online?)')); };
      document.head.appendChild(s);
    });
  }
  function onSession(session) {
    if (!session) { entering = null; showAuth('login'); return; }
    if (me && me.id === session.user.id) return;
    if (entering === session.user.id) return;
    entering = session.user.id;
    var email = String(session.user.email || '').toLowerCase();
    sb.from('members').select('name,email').then(function (res) {
      entering = null;
      if (res.error) throw res.error;
      var row = (res.data || []).filter(function (r) { return String(r.email).toLowerCase() === email; })[0];
      if (!row) { $('nmEmail').textContent = email; showAuth('notmember'); return; }
      people = (res.data || []).map(function (r) { return r.name; }).filter(function (n, i, a) { return a.indexOf(n) === i && (n !== 'Test' || n === row.name); });
      enterApp({ name: row.name, id: session.user.id });
      listen();
      return loadAll();
    }).catch(function (e) { entering = null; showAuth('login'); authErr('Could not check the member list: ' + errMsg(e)); report('Member check failed: ' + errMsg(e)); });
  }
  function cloudBoot() {
    showAuth('login');
    /* supabase.js ships with the app; the CDN is only a fallback */
    (window.supabase && window.supabase.createClient ? Promise.resolve() : loadScript(SUPA_JS)).then(function () {
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      sb.auth.onAuthStateChange(function (event, session) {
        /* run outside the callback: calling Supabase inside it can stall */
        setTimeout(function () {
          if (event === 'PASSWORD_RECOVERY') { showAuth('reset'); return; }
          if (event === 'SIGNED_OUT') { if (channel) { sb.removeChannel(channel); channel = null; } KEYS.forEach(function (k) { state[k] = []; }); showAuth('login'); return; }
          if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') onSession(session);
        }, 0);
      });
    }).catch(function (e) { authErr(errMsg(e)); report(errMsg(e)); });
  }
  $('aMode').addEventListener('click', function () { setAuthMode(!signUp); });
  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sb) { authErr('Still loading, try again in a moment.'); return; }
    var email = $('aEmail').value.trim(), pass = $('aPass').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { authErr('Enter your email.'); return; }
    if (pass.length < 8) { authErr('Passwords need 8 or more characters.'); return; }
    authErr(signUp ? 'Making your login...' : 'Signing in...');
    var p = signUp ? sb.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } }) : sb.auth.signInWithPassword({ email: email, password: pass });
    p.then(function (res) {
      if (res.error) throw res.error;
      $('aPass').value = '';
      if (signUp && !res.data.session) { setAuthMode(false); authErr('Done. Check your email for a confirmation link, then sign in here.'); return; }
      authErr('');
    }).catch(function (er) {
      var m = errMsg(er);
      if (!signUp && /invalid login credentials/i.test(m)) m = 'No Studio 1 login matches that email and password. First time here? Tap "First time? Make my login" below and set your password there.';
      else if (/rate limit/i.test(m)) m = 'Too many emails sent in the last hour. Your login is probably already made: check your inbox for the Supabase confirmation email, click it, then tap "I already have a login" and sign in.';
      else if (/email not confirmed/i.test(m)) m = 'Your login is made but not confirmed yet. Click the link in the email from Supabase, then sign in here.';
      else if (signUp && /already registered|already exists/i.test(m)) { setAuthMode(false); m = 'You already have a login. Sign in instead, or tap Forgot password.'; }
      authErr(m);
    });
  });
  $('aForgot').addEventListener('click', function () {
    if (!sb) return;
    var email = $('aEmail').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { authErr('Type your email above first, then tap Forgot password.'); return; }
    sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (res) {
      authErr(res.error ? errMsg(res.error) : 'Check your email for a link to choose a new password.');
    });
  });
  $('resetForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = $('aNew').value;
    if (pass.length < 8) { $('rErr').textContent = 'Passwords need 8 or more characters.'; return; }
    sb.auth.updateUser({ password: pass }).then(function (res) {
      if (res.error) { $('rErr').textContent = errMsg(res.error); return; }
      $('aNew').value = ''; toast('Password saved.');
      sb.auth.getSession().then(function (r) { onSession(r.data && r.data.session); });
    });
  });
  $('nmOut').addEventListener('click', function () { if (sb) sb.auth.signOut(); });
  $('signOutBtn').addEventListener('click', function () {
    if (CLOUD) { if (sb) sb.auth.signOut(); return; }
    try { localStorage.removeItem('valenti-local-who'); } catch (e) {}
    showAuth('login');
  });

  if (CLOUD) cloudBoot(); else localBoot();
})();
