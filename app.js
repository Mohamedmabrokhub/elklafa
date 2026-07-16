(function () {
"use strict";

/* ============================== CONFIG ============================== */

const USERS = {
  mabrok:      { name: "مبروك",        password: "1", role: "admin", avatar: "👑" },
  boda:        { name: "بوضا",         password: "2", avatar: "🤪" },
  manzor1:     { name: "منظور 1",       password: "3", avatar: "🥴" },
  manzor2:     { name: "منظور 2",       password: "4", avatar: "😵" },
  kalfeuropa:  { name: "كلف أوروبا",    password: "5", avatar: "🤡" }
};

const REACTIONS = [
  { max: 2,  emoji: "😐", lines: ["عادي كده، مفيش داعي للفخر ولا الزعل", "يوم هادي، مفيش غباء يُذكر النهاردة"] },
  { max: 4,  emoji: "😅", lines: ["لسه بداية، بس فيه أمل", "خفيف خفيف، ولا يهز الترتيب"] },
  { max: 6,  emoji: "🙃", lines: ["دي كانت لفتة تستاهل تتقال", "شغل من عيار الغباء المتوسط"] },
  { max: 8,  emoji: "🤪", lines: ["يا ساتر! ده كلام يتقال في التاريخ", "لفتة قوية، الغباء بقى شغل فنون"] },
  { max: 10, emoji: "🐒", lines: ["أسطورة رسمية! اسمك هيتسجل في كتاب الغباء", "خلاص كده يا نجم، إنت غبي العصر الحديث"] }
];

const TODAY_DONE_EMOJIS = ["🎉", "🫡", "😮‍💨", "🥴", "🔥"];

const JSONBIN_BASE = "https://api.jsonbin.io/v3/b/";

/* ============================== STATE ============================== */

let session = null;          // current username
let db = { entries: [] };    // { entries: [...] }
let syncCfg = { binId: "", key: "", enabled: false };
let activeTab = "today";
let weekOffset = 0;          // 0 = current week
let historyFilter = "all";
let syncTimer = null;

/* ============================== HELPERS: DATE/WEEK ============================== */

function pad(n){ return String(n).padStart(2, "0"); }

function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function mondayOf(date){
  const d = new Date(date);
  const diff = (d.getDay() + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0,0,0,0);
  return d;
}

function dateToKey(d){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function weekKeyForDate(date){
  return "W-" + dateToKey(mondayOf(date));
}

function weekRangeForOffset(offset){
  const now = new Date();
  const base = new Date(now);
  base.setDate(base.getDate() + offset * 7);
  const start = mondayOf(base);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end, key: weekKeyForDate(start) };
}

const AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

function fmtShort(d){
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]}`;
}

function fmtDateTime(dateKey){
  const parts = dateKey.split("-");
  const d = new Date(+parts[0], +parts[1]-1, +parts[2]);
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ============================== STORAGE ============================== */

function loadLocal(){
  try{
    const raw = localStorage.getItem("kalafa_db");
    db = raw ? JSON.parse(raw) : { entries: [] };
    if(!db.entries) db.entries = [];
  }catch(e){ db = { entries: [] }; }

  try{
    const rawCfg = localStorage.getItem("kalafa_sync_cfg");
    syncCfg = rawCfg ? JSON.parse(rawCfg) : { binId: "", key: "", enabled: false };
  }catch(e){ syncCfg = { binId:"", key:"", enabled:false }; }

  session = localStorage.getItem("kalafa_session") || null;
}

function saveLocal(){
  localStorage.setItem("kalafa_db", JSON.stringify(db));
}

function saveSyncCfg(){
  localStorage.setItem("kalafa_sync_cfg", JSON.stringify(syncCfg));
}

/* ============================== CLOUD SYNC ============================== */

function setSyncBadge(state){
  const el = document.getElementById("sync-badge");
  if(!el) return;
  if(state === "ok") el.textContent = "☁️";
  else if(state === "busy") el.textContent = "⏳";
  else if(state === "err") el.textContent = "⚠️";
  else el.textContent = "📴";
}

function mergeDB(local, remote){
  const map = new Map();
  (local.entries||[]).forEach(e => map.set(e.id, JSON.parse(JSON.stringify(e))));
  (remote.entries||[]).forEach(re => {
    const existing = map.get(re.id);
    if(!existing){
      map.set(re.id, JSON.parse(JSON.stringify(re)));
    } else {
      existing.ratings = Object.assign({}, existing.ratings||{}, re.ratings||{});
      if(!existing.text && re.text) existing.text = re.text;
      existing.createdAt = Math.min(existing.createdAt||Infinity, re.createdAt||Infinity);
    }
  });
  return { entries: Array.from(map.values()) };
}

async function pullCloud(silent){
  if(!syncCfg.enabled || !syncCfg.binId || !syncCfg.key) return false;
  if(!silent) setSyncBadge("busy");
  try{
    const res = await fetch(JSONBIN_BASE + syncCfg.binId + "/latest", {
      headers: { "X-Master-Key": syncCfg.key, "X-Bin-Meta": "false" }
    });
    if(!res.ok) throw new Error("bad status " + res.status);
    const remote = await res.json();
    db = mergeDB(db, remote && remote.entries ? remote : { entries: [] });
    saveLocal();
    setSyncBadge("ok");
    return true;
  }catch(e){
    setSyncBadge("err");
    return false;
  }
}

async function pushCloud(){
  if(!syncCfg.enabled || !syncCfg.binId || !syncCfg.key) return false;
  setSyncBadge("busy");
  try{
    const res = await fetch(JSONBIN_BASE + syncCfg.binId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": syncCfg.key, "X-Bin-Meta": "false" },
      body: JSON.stringify(db)
    });
    if(!res.ok) throw new Error("bad status " + res.status);
    setSyncBadge("ok");
    return true;
  }catch(e){
    setSyncBadge("err");
    return false;
  }
}

async function syncAfterWrite(){
  saveLocal();
  if(syncCfg.enabled){
    await pushCloud();
  }
}

function startBackgroundSync(){
  if(syncTimer) clearInterval(syncTimer);
  if(!syncCfg.enabled) { setSyncBadge("off"); return; }
  syncTimer = setInterval(async () => {
    const changed = await pullCloud(true);
    if(changed && (activeTab === "today" || activeTab === "leaderboard" || activeTab === "history")){
      renderActiveTab();
    }
  }, 20000);
}

/* ============================== TOAST ============================== */

let toastTimer = null;
function toast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ============================== SCORING ============================== */

function entryAvg(entry){
  const vals = Object.values(entry.ratings||{});
  if(vals.length === 0) return null;
  return vals.reduce((a,b)=>a+b,0) / vals.length;
}

function reactionFor(score){
  const tier = REACTIONS.find(t => score <= t.max) || REACTIONS[REACTIONS.length-1];
  const line = tier.lines[Math.floor(Math.random()*tier.lines.length)];
  return { emoji: tier.emoji, line };
}

function weeklyStats(weekKey){
  const stats = {};
  Object.keys(USERS).forEach(u => stats[u] = { user:u, sum:0, count:0, totalEntries:0, avg:0 });
  db.entries.filter(e => e.week === weekKey).forEach(e => {
    if(!stats[e.username]) return;
    stats[e.username].totalEntries++;
    const avg = entryAvg(e);
    if(avg !== null){
      stats[e.username].sum += avg;
      stats[e.username].count++;
    }
  });
  Object.values(stats).forEach(s => { s.avg = s.count ? s.sum / s.count : 0; });
  return Object.values(stats).sort((a,b) => b.sum - a.sum);
}

/* ============================== AUTH ============================== */

function renderUserPicker(){
  const wrap = document.getElementById("user-picker");
  wrap.innerHTML = "";
  let selected = null;
  Object.entries(USERS).forEach(([key, u]) => {
    const chip = document.createElement("div");
    chip.className = "user-chip";
    chip.innerHTML = `<span class="av">${u.avatar}</span><span>${u.name}</span>`;
    chip.dataset.user = key;
    chip.addEventListener("click", () => {
      wrap.querySelectorAll(".user-chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
      selected = key;
      wrap.dataset.selected = key;
      document.getElementById("password-input").focus();
    });
    wrap.appendChild(chip);
  });
}

function attemptLogin(){
  const wrap = document.getElementById("user-picker");
  const selected = wrap.dataset.selected;
  const pass = document.getElementById("password-input").value;
  const errEl = document.getElementById("login-error");

  if(!selected){
    errEl.textContent = "اختار مين حضرتك الأول 👆";
    errEl.classList.remove("hidden");
    return;
  }
  if(USERS[selected].password !== pass){
    errEl.textContent = "غلط يا نجم، جرب تاني 🙃";
    errEl.classList.remove("hidden");
    return;
  }
  errEl.classList.add("hidden");
  session = selected;
  localStorage.setItem("kalafa_session", session);
  enterApp();
}

function logout(){
  session = null;
  localStorage.removeItem("kalafa_session");
  if(syncTimer) clearInterval(syncTimer);
  document.getElementById("password-input").value = "";
  document.getElementById("login-error").classList.add("hidden");
  document.querySelectorAll(".user-chip").forEach(c => c.classList.remove("selected"));
  delete document.getElementById("user-picker").dataset.selected;
  showScreen("login-screen");
}

/* ============================== SCREEN / TAB SWITCHING ============================== */

function showScreen(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function switchTab(tab){
  activeTab = tab;
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById("tab-" + tab).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  renderActiveTab();
}

function renderActiveTab(){
  if(activeTab === "today") renderToday();
  else if(activeTab === "leaderboard") renderLeaderboard();
  else if(activeTab === "history") renderHistory();
  else if(activeTab === "settings") renderSettings();
}

/* ============================== TODAY TAB ============================== */

function renderToday(){
  const card = document.getElementById("today-card");
  const myEntryId = `${session}__${todayStr()}`;
  const mine = db.entries.find(e => e.id === myEntryId);

  if(mine){
    const emoji = TODAY_DONE_EMOJIS[Math.floor(Math.random()*TODAY_DONE_EMOJIS.length)];
    card.innerHTML = `
      <div class="today-done">
        <span class="big-emoji">${emoji}</span>
        <div class="card-title" style="margin-bottom:2px;">سجلت غبائك النهاردة</div>
        <div class="muted-text">"${escapeHtml(mine.text)}"</div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="today-prompt">
        <div class="card-title">إيه أغبى حاجة عملتها النهاردة؟</div>
        <textarea id="today-text" placeholder="احكيلنا... إحنا مش هنحكم عليك (هنحكم عليك فعلاً 😏)"></textarea>
        <button id="today-submit" class="btn btn-primary btn-block">سجّل غبائي 📝</button>
      </div>`;
    document.getElementById("today-submit").addEventListener("click", submitTodayEntry);
  }

  renderPendingRatings();
}

function submitTodayEntry(){
  const textEl = document.getElementById("today-text");
  const text = textEl.value.trim();
  if(!text){
    toast("اكتب حاجة الأول يا معلم 😅");
    return;
  }
  const entry = {
    id: `${session}__${todayStr()}`,
    username: session,
    date: todayStr(),
    week: weekKeyForDate(new Date()),
    text: text,
    ratings: {},
    createdAt: Date.now()
  };
  db.entries.push(entry);
  syncAfterWrite();
  toast("تم التسجيل! يلا نستنى الأحكام 🔥");
  renderToday();
}

function renderPendingRatings(){
  const list = document.getElementById("pending-list");
  const countEl = document.getElementById("pending-count");
  list.innerHTML = "";

  const cutoff = Date.now() - 1000*60*60*24*21; // last 3 weeks
  const pending = db.entries
    .filter(e => e.username !== session && !(e.ratings && (session in e.ratings)) && e.createdAt >= cutoff)
    .sort((a,b) => b.createdAt - a.createdAt);

  countEl.textContent = pending.length;

  if(pending.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<span class="big-emoji">✅</span>مفيش حد محتاج حكمك دلوقتي، ارجع تاني بعدين`;
    list.appendChild(empty);
    return;
  }

  const tpl = document.getElementById("tpl-pending-entry");
  pending.forEach(entry => {
    const node = tpl.content.cloneNode(true);
    const rootCard = node.querySelector(".entry-card");
    rootCard.querySelector(".entry-avatar").textContent = USERS[entry.username].avatar;
    rootCard.querySelector(".entry-name").textContent = USERS[entry.username].name;
    rootCard.querySelector(".entry-date").textContent = fmtDateTime(entry.date);
    rootCard.querySelector(".entry-text").textContent = entry.text;

    const slider = rootCard.querySelector(".rating-slider");
    const gaugeFill = rootCard.querySelector(".gauge-fill");
    const gaugeNeedle = rootCard.querySelector(".gauge-needle");
    const gaugeValue = rootCard.querySelector(".gauge-value");
    const submitBtn = rootCard.querySelector(".rate-submit-btn");

    function updateGauge(v){
      const pct = v/10;
      gaugeFill.style.strokeDashoffset = String(283 - 283*pct);
      gaugeNeedle.style.transform = `rotate(${-90 + 180*pct}deg)`;
      gaugeValue.textContent = v;
      const t = REACTIONS.find(t => v <= t.max) || REACTIONS[REACTIONS.length-1];
      gaugeFill.style.stroke = v <= 4 ? "var(--green)" : (v <= 7 ? "var(--gold)" : "var(--red)");
    }
    updateGauge(0);
    slider.addEventListener("input", () => updateGauge(+slider.value));

    submitBtn.addEventListener("click", () => {
      const val = +slider.value;
      entry.ratings = entry.ratings || {};
      entry.ratings[session] = val;
      syncAfterWrite();
      const r = reactionFor(val);
      toast(`${r.emoji} تم! ${r.line}`);
      renderPendingRatings();
      countEl.textContent = String(+countEl.textContent - 1 >= 0 ? +countEl.textContent - 1 : 0);
    });

    list.appendChild(node);
  });
}

/* ============================== LEADERBOARD TAB ============================== */

function renderLeaderboard(){
  const range = weekRangeForOffset(weekOffset);
  document.getElementById("week-label").textContent =
    (weekOffset === 0 ? "الأسبوع الحالي: " : "") + `${fmtShort(range.start)} - ${fmtShort(range.end)}`;
  document.getElementById("week-next").disabled = weekOffset >= 0;

  const stats = weeklyStats(range.key);
  const spotlight = document.getElementById("winner-spotlight");
  const listEl = document.getElementById("leaderboard-list");
  listEl.innerHTML = "";

  const winner = stats.find(s => s.sum > 0);

  if(!winner){
    spotlight.innerHTML = `<div class="winner-empty">😴 لسه محدش سجّل غباء كافي الأسبوع ده... يلا يا جماعة فينكم!</div>`;
  }else{
    const r = reactionFor(winner.avg);
    spotlight.innerHTML = `
      <span class="winner-crown">👑</span>
      <div class="winner-name">${USERS[winner.user].avatar} ${USERS[winner.user].name}</div>
      <div class="winner-title">${r.emoji} ${r.line}</div>
      <div class="winner-score">${winner.sum.toFixed(1)}</div>
      <div class="winner-score-label">إجمالي نقاط الغباء (${winner.count} موقف)</div>`;
    fireConfetti();
  }

  const maxSum = Math.max(1, ...stats.map(s => s.sum));
  stats.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "rank-row" + (idx === 0 && s.sum > 0 ? " rank-1" : "");
    row.innerHTML = `
      <div class="rank-num">${idx+1}</div>
      <div class="rank-avatar">${USERS[s.user].avatar}</div>
      <div class="rank-info">
        <div class="rank-name">${USERS[s.user].name}</div>
        <div class="rank-sub">${s.count} موقف مُقيَّم${s.totalEntries > s.count ? " · " + (s.totalEntries - s.count) + " قيد التقييم" : ""}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(s.sum/maxSum*100)}%"></div></div>
      </div>
      <div class="rank-score">${s.sum.toFixed(1)}</div>`;
    listEl.appendChild(row);
  });
}

/* ============================== HISTORY TAB ============================== */

function renderHistoryFilters(){
  const wrap = document.getElementById("history-filters");
  wrap.innerHTML = "";
  const chips = [{key:"all", label:"الكل", avatar:"📜"}].concat(
    Object.entries(USERS).map(([k,u]) => ({key:k, label:u.name, avatar:u.avatar}))
  );
  chips.forEach(c => {
    const chip = document.createElement("div");
    chip.className = "chip" + (historyFilter === c.key ? " active" : "");
    chip.textContent = `${c.avatar} ${c.label}`;
    chip.addEventListener("click", () => { historyFilter = c.key; renderHistory(); });
    wrap.appendChild(chip);
  });
}

function renderHistory(){
  renderHistoryFilters();
  const list = document.getElementById("history-list");
  list.innerHTML = "";

  let entries = db.entries.slice().sort((a,b) => b.createdAt - a.createdAt);
  if(historyFilter !== "all") entries = entries.filter(e => e.username === historyFilter);

  if(entries.length === 0){
    list.innerHTML = `<div class="empty-state"><span class="big-emoji">🕳️</span>مفيش أي مواقف لسه</div>`;
    return;
  }

  const tpl = document.getElementById("tpl-history-entry");
  entries.forEach(entry => {
    const node = tpl.content.cloneNode(true);
    node.querySelector(".entry-avatar").textContent = USERS[entry.username].avatar;
    node.querySelector(".entry-name").textContent = USERS[entry.username].name;
    node.querySelector(".entry-date").textContent = fmtDateTime(entry.date);
    node.querySelector(".entry-text").textContent = entry.text;

    const avg = entryAvg(entry);
    node.querySelector(".score-chip").textContent = avg === null ? "قيد التقييم" : avg.toFixed(1);

    const breakdown = node.querySelector(".ratings-breakdown");
    const ratings = entry.ratings || {};
    Object.keys(ratings).forEach(rater => {
      const pill = document.createElement("span");
      pill.className = "rating-pill";
      pill.textContent = `${USERS[rater] ? USERS[rater].avatar : "👤"} ${ratings[rater]}`;
      breakdown.appendChild(pill);
    });

    list.appendChild(node);
  });
}

/* ============================== SETTINGS TAB ============================== */

function renderSettings(){
  document.getElementById("sync-bin").value = syncCfg.binId || "";
  document.getElementById("sync-key").value = syncCfg.key || "";
  document.getElementById("sync-toggle").checked = !!syncCfg.enabled;
  document.getElementById("sync-status").textContent = syncCfg.enabled
    ? "المزامنة شغالة ✅"
    : "المزامنة متوقفة، البيانات محلية بس على الجهاز ده 📴";

  document.getElementById("admin-card").classList.toggle("hidden", USERS[session].role !== "admin");
  document.getElementById("me-avatar").textContent = USERS[session].avatar;
}

async function saveSyncSettings(){
  syncCfg.binId = document.getElementById("sync-bin").value.trim();
  syncCfg.key = document.getElementById("sync-key").value.trim();
  syncCfg.enabled = document.getElementById("sync-toggle").checked;
  saveSyncCfg();

  const statusEl = document.getElementById("sync-status");
  if(syncCfg.enabled){
    statusEl.textContent = "بنجرب الاتصال...";
    const okPull = await pullCloud(false);
    if(okPull){
      await pushCloud();
      statusEl.textContent = "اتوصل بنجاح! ✅ البيانات بقت متزامنة";
      toast("المزامنة شغالة 🎉");
      renderActiveTab();
    }else{
      statusEl.textContent = "فيه مشكلة في الاتصال، اتأكد من الـ Bin ID والمفتاح 🧐";
    }
  }else{
    statusEl.textContent = "المزامنة متوقفة، البيانات محلية بس على الجهاز ده 📴";
  }
  startBackgroundSync();
}

function exportData(){
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kalafa-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function resetCurrentWeek(){
  if(!confirm("متأكد إنك عايز تصفّر ترتيب الأسبوع الحالي؟")) return;
  const range = weekRangeForOffset(weekOffset);
  db.entries = db.entries.filter(e => e.week !== range.key);
  syncAfterWrite();
  toast("تم تصفير الأسبوع 🧹");
  renderActiveTab();
}

function resetAllData(){
  if(!confirm("متأكد 100%؟ هيتمسح كل حاجة نهائيًا ولا يمكن الرجوع فيها!")) return;
  if(!confirm("آخر تأكيد: كل المواقف والتقييمات هتتمسح فعلاً. متابع؟")) return;
  db.entries = [];
  syncAfterWrite();
  toast("اتمسح كل حاجة 🗑️");
  renderActiveTab();
}

/* ============================== CONFETTI ============================== */

let confettiRunning = false;
function fireConfetti(){
  if(confettiRunning) return;
  confettiRunning = true;
  const canvas = document.getElementById("confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ["#f7a521", "#ffd987", "#ff7c93", "#6fbf73", "#fdf3df"];
  const particles = Array.from({length: 80}, () => ({
    x: Math.random()*canvas.width,
    y: -20 - Math.random()*canvas.height*0.5,
    size: 5 + Math.random()*6,
    color: colors[Math.floor(Math.random()*colors.length)],
    speedY: 2 + Math.random()*3,
    speedX: (Math.random()-0.5)*2,
    rotation: Math.random()*360,
    rotSpeed: (Math.random()-0.5)*10
  }));

  let frame = 0;
  const maxFrames = 130;

  function draw(){
    ctx.clearRect(0,0,canvas.width, canvas.height);
    particles.forEach(p => {
      p.y += p.speedY;
      p.x += p.speedX;
      p.rotation += p.rotSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI/180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size*0.6);
      ctx.restore();
    });
    frame++;
    if(frame < maxFrames){
      requestAnimationFrame(draw);
    }else{
      ctx.clearRect(0,0,canvas.width, canvas.height);
      confettiRunning = false;
    }
  }
  draw();
}

window.addEventListener("resize", () => {
  const canvas = document.getElementById("confetti-canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

/* ============================== UTIL ============================== */

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* ============================== ENTER APP ============================== */

async function enterApp(){
  showScreen("app-screen");
  document.getElementById("me-avatar").textContent = USERS[session].avatar;
  weekOffset = 0;
  historyFilter = "all";
  switchTab("today");
  setSyncBadge(syncCfg.enabled ? "ok" : "off");
  if(syncCfg.enabled){
    const changed = await pullCloud(true);
    if(changed) renderActiveTab();
  }
  startBackgroundSync();
}

/* ============================== INIT ============================== */

function wireEvents(){
  document.getElementById("login-btn").addEventListener("click", attemptLogin);
  document.getElementById("password-input").addEventListener("keydown", e => {
    if(e.key === "Enter") attemptLogin();
  });

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("week-prev").addEventListener("click", () => {
    weekOffset -= 1;
    renderLeaderboard();
  });
  document.getElementById("week-next").addEventListener("click", () => {
    if(weekOffset < 0){ weekOffset += 1; renderLeaderboard(); }
  });

  document.getElementById("sync-save").addEventListener("click", saveSyncSettings);
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("reset-week-btn").addEventListener("click", resetCurrentWeek);
  document.getElementById("reset-all-btn").addEventListener("click", resetAllData);
  document.getElementById("logout-btn").addEventListener("click", logout);

  document.getElementById("sync-badge").addEventListener("click", async () => {
    if(!syncCfg.enabled) return;
    const changed = await pullCloud(false);
    if(changed) renderActiveTab();
    toast("تم تحديث البيانات 🔄");
  });
}

function registerSW(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadLocal();
  renderUserPicker();
  wireEvents();
  registerSW();

  setTimeout(() => {
    if(session && USERS[session]){
      enterApp();
    }else{
      showScreen("login-screen");
    }
  }, 1100);
});

})();
