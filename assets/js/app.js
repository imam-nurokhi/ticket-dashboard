/**
 * Nexora Support v2.1 — IT Helpdesk Dashboard
 * app.js — Data pipeline + UI rendering + Analytics
 */
'use strict';

/* ═══ CONSTANTS ═══ */
const PER_PAGE = 20;
const AVATAR_COLORS = [
  '#00d4aa','#4f94f8','#a371f7','#f0883e',
  '#3fb950','#f85149','#db61a2','#58a6ff',
  '#e3b341','#79c0ff','#56d364','#ff9a3c',
];
const MONTH_SHORT = {'01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec'};
const STATUS_COLORS = { open:'#3fb950', in_progress:'#f0883e', pending:'#a371f7', closed:'#4f94f8', hold:'#f85149' };

/* ═══ STATE ═══ */
const state = {
  tickets:[], stats:null, agentStats:null, userIdMap:{},
  filterStatus:'', filterCat:'', searchQ:'',
  page:1, selectedId:null,
  view:'overview',
  tblSort:{ col:'total', dir:'desc' },
};

/* ═══ INIT ═══ */
async function init() {
  setTopbarDate();
  try {
    const res = await fetch('./data/tickets.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    state.userIdMap  = buildUserIdMap(raw);
    state.tickets    = normalise(raw);
    state.stats      = computeStats(state.tickets);
    state.agentStats = computeAgentStats(raw);
    populateCatSelect();
    updateNavBadges();
    renderDonut();
    render();
    hideLoader();
  } catch(err) {
    document.getElementById('loading-screen').innerHTML = `
      <div style="text-align:center;padding:32px">
        <div style="font-size:36px;margin-bottom:14px">⚠️</div>
        <div style="color:var(--red);font-family:'JetBrains Mono',monospace;font-size:13px;margin-bottom:8px">Failed to load data</div>
        <div style="color:var(--t4);font-size:11px;margin-bottom:16px">${esc(err.message)}</div>
        <code style="color:var(--t3);font-size:10px;background:var(--bg3);padding:10px 16px;border-radius:8px;display:inline-block">python3 -m http.server 3000</code>
      </div>`;
  }
}

function setTopbarDate() {
  const el = document.getElementById('topbar-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
}

/* ═══ BUILD USER ID MAP (id → display_name) ═══ */
function buildUserIdMap(raw) {
  const map = {};
  for (const t of raw) {
    const u = t.user||{};
    if (u.id && u.display_name) map[u.id] = u.display_name;
  }
  return map;
}

/* ═══ NORMALISE ═══ */
function normalise(raw) {
  return raw.map(t => {
    const user = t.user||{};
    const tags  = (t.tags||[]).map(g=>g.display_name||g.name||'').filter(Boolean);
    return {
      id:      t.id,
      subject: t.subject||'',
      status:  (t.status||'open').toLowerCase().replace(/ /g,'_'),
      created: fmtDate(t.created_at),
      updated: fmtDate(t.updated_at),
      closed:  fmtDate(t.closed_at),
      created_raw: t.created_at||'',
      closed_raw:  t.closed_at||'',
      replies: t.replies_count||0,
      user:    user.display_name||'',
      assignedTo: t.assigned_to ? (state.userIdMap[t.assigned_to] || `Agent #${t.assigned_to}`) : '—',
      tags,
      preview: stripHtml(t.latest_reply?.body||''),
      _ym:     (t.created_at||'').slice(0,7),
    };
  });
}
function stripHtml(s) {
  return s.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
}

/* ═══ COMPUTE STATS (overview) ═══ */
function computeStats(tickets) {
  const byStatus={}, byCat={}, byMonth={}, userCount={};
  for (const t of tickets) {
    byStatus[t.status]=(byStatus[t.status]||0)+1;
    for (const tag of t.tags) byCat[tag]=(byCat[tag]||0)+1;
    if (t._ym) byMonth[t._ym]=(byMonth[t._ym]||0)+1;
    if (t.user) userCount[t.user]=(userCount[t.user]||0)+1;
  }
  const byCatArr   = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const byMonthArr = Object.entries(byMonth)
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([ym,cnt])=>{ const [yr,mo]=ym.split('-'); return [MONTH_SHORT[mo],`${MONTH_SHORT[mo]} '${yr.slice(2)}`,cnt]; });
  const topUsers = Object.entries(userCount)
    .sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([name,cnt],i)=>[name,cnt,AVATAR_COLORS[i%AVATAR_COLORS.length]]);
  const closed=byStatus.closed||0;
  return {
    total:tickets.length,
    resolveRate:tickets.length?+((closed/tickets.length)*100).toFixed(1):0,
    byStatus:{open:byStatus.open||0,in_progress:byStatus.in_progress||0,pending:byStatus.pending||0,hold:byStatus.hold||0,closed},
    byCat:byCatArr,byMonth:byMonthArr,topUsers,
  };
}

/* ═══ COMPUTE AGENT STATS (analytics — uses assigned_to) ═══ */
function computeAgentStats(raw) {
  const map = {};
  for (const t of raw) {
    const aid  = t.assigned_to;
    if (!aid) continue;
    const name = state.userIdMap[aid] || `Agent #${aid}`;
    if (!map[name]) map[name] = {name, agentId:aid, total:0, closed:0, open:0, in_progress:0, pending:0, hold:0, replies:0, days:[], cats:{}, byMonth:{}};
    const s = (t.status||'open').toLowerCase().replace(/ /g,'_');
    map[name].total++;
    map[name][s] = (map[name][s]||0) + 1;
    map[name].replies += (t.replies_count||0);
    // resolution time
    if (s==='closed' && t.created_at && t.closed_at) {
      try {
        const cr=new Date(t.created_at), cl=new Date(t.closed_at);
        if (!isNaN(cr)&&!isNaN(cl)) map[name].days.push(Math.max(0,(cl-cr)/86400000));
      } catch(e){}
    }
    // top category
    for (const tag of (t.tags||[])) {
      const n=tag.display_name||tag.name||'';
      if (n) map[name].cats[n]=(map[name].cats[n]||0)+1;
    }
    // monthly breakdown
    const ym=(t.created_at||'').slice(0,7);
    if (ym) map[name].byMonth[ym]=(map[name].byMonth[ym]||0)+1;
  }
  return Object.values(map).map((a,i)=>({
    ...a,
    resolveRate: a.total ? +((a.closed/a.total)*100).toFixed(1) : 0,
    avgDays:     a.days.length ? +(a.days.reduce((x,y)=>x+y,0)/a.days.length).toFixed(1) : null,
    topCat:      Object.entries(a.cats).sort((x,y)=>y[1]-x[1])[0]?.[0]||'—',
    color:       AVATAR_COLORS[i%AVATAR_COLORS.length],
  })).sort((a,b)=>b.total-a.total);
}

/* ═══ LOADER ═══ */
function hideLoader() {
  const el=document.getElementById('loading-screen');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(()=>el.remove(),500);
}

/* ═══ DONUT CHART (sidebar) ═══ */
function renderDonut() {
  const el=document.getElementById('donutChart');
  const pctEl=document.getElementById('donutPct');
  if (!el||!state.stats) return;
  const {byStatus,resolveRate}=state.stats;
  const segs=[
    {val:byStatus.closed,color:'#4f94f8'},
    {val:byStatus.open,  color:'#3fb950'},
    {val:byStatus.in_progress,color:'#f0883e'},
    {val:byStatus.pending,color:'#a371f7'},
    {val:byStatus.hold,  color:'#f85149'},
  ].filter(s=>s.val>0);
  const total=segs.reduce((s,x)=>s+x.val,0);
  const cx=40,cy=40,r=32,sw=8,circ=2*Math.PI*r;
  let off=0,paths='';
  for (const seg of segs) {
    const dash=(seg.val/total)*circ;
    paths+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(2)} ${(circ-dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" style="transition:stroke-dasharray .6s ease"/>`;
    off+=dash;
  }
  paths+=`<circle cx="${cx}" cy="${cy}" r="${r-sw/2-2}" fill="var(--bg2)"/>`;
  el.innerHTML=paths;
  if (pctEl) pctEl.textContent=resolveRate+'%';
}

/* ═══ FILTER ═══ */
function getFiltered() {
  const q=state.searchQ.toLowerCase();
  return state.tickets.filter(t=>{
    if (q&&!t.subject.toLowerCase().includes(q)&&!t.user.toLowerCase().includes(q)&&!t.assignedTo.toLowerCase().includes(q)&&!String(t.id).includes(q)) return false;
    if (state.filterStatus&&t.status!==state.filterStatus) return false;
    if (state.filterCat&&!t.tags.includes(state.filterCat)) return false;
    return true;
  });
}

/* ═══ NAV ═══ */
function navClick(el,status) {
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  state.view='overview'; state.filterStatus=status; state.page=1;
  syncChips(); showView('overview'); render();
}
function navAnalytics(el) {
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  state.view='analytics';
  showView('analytics');
  renderAnalytics();
  if (window.innerWidth<=768) toggleSidebar();
}
function bnavClick(el,status) {
  document.querySelectorAll('.bnav-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  state.view='overview'; state.filterStatus=status; state.filterCat=''; state.searchQ=''; state.page=1;
  const sq=document.getElementById('searchQ'); if(sq) sq.value='';
  syncChips(); showView('overview'); render();
  if (window.innerWidth<=768) { document.getElementById('sidebar')?.classList.remove('open'); document.getElementById('mob-overlay')?.classList.remove('show'); }
}

function showView(v) {
  const ov=document.getElementById('overviewContent');
  const av=document.getElementById('analyticsContent');
  const statsGrid=document.getElementById('statsGrid');
  const chipRow=document.querySelector('.chip-row');
  if (!ov||!av) return;
  const isAnalytics = v==='analytics';
  ov.style.display     = isAnalytics ? 'none' : '';
  av.style.display     = isAnalytics ? '' : 'none';
  // hide stats/chips when analytics is shown (they're overview-specific)
  if (statsGrid) statsGrid.style.display = isAnalytics ? 'none' : '';
  if (chipRow)   chipRow.style.display   = isAnalytics ? 'none' : '';
}

function setFilter(s) { state.filterStatus=s; state.page=1; syncChips(); render(); }
function setChip(el,s) { state.filterStatus=s; state.page=1; syncChips(); render(); }
function syncChips() { document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c.dataset.status===state.filterStatus)); }
function doFilter() {
  state.searchQ=document.getElementById('searchQ')?.value||'';
  state.filterCat=document.getElementById('catSel')?.value||'';
  state.page=1; render();
}
function goPage(p) {
  if (p<1) return; state.page=p; renderList();
  document.getElementById('ticketList')?.scrollTo({top:0,behavior:'smooth'});
}
function resetToOverview() {
  state.view='overview'; state.filterStatus=''; state.filterCat=''; state.searchQ=''; state.page=1;
  const sq=document.getElementById('searchQ'); if(sq) sq.value='';
  const cs=document.getElementById('catSel'); if(cs) cs.value='';
  syncChips(); showView('overview'); render();
  document.querySelectorAll('.nav-item').forEach((n,i)=>n.classList.toggle('active',i===0));
  document.querySelectorAll('.bnav-item').forEach((n,i)=>n.classList.toggle('active',i===0));
}

/* ═══ HELPERS ═══ */
function isUrgent(s){return /urgent/i.test(s);}
function fmtDate(d){
  if(!d) return null;
  const dt=new Date(d.includes('T')?d:d+'T00:00:00');
  if(isNaN(dt)) return null;
  return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
}
function statusColor(s){return STATUS_COLORS[s]||'var(--t4)';}
function initials(name){const p=name.split(/[.\s_\-]+/).filter(Boolean);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():name.slice(0,2).toUpperCase();}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function rateColor(r){return r>=90?'var(--green)':r>=70?'var(--amber)':'var(--red)';}

/* ═══ RENDER STATS ═══ */
function renderStats() {
  const el=document.getElementById('statsGrid');
  if (!el||!state.stats) return;
  const {total,byStatus,resolveRate}=state.stats;
  const months=(state.stats.byMonth||[]).slice(-8).map(([,,c])=>c);
  const maxM=Math.max(...months,1);
  function spark(vals,clr) {
    if (!vals.length) return '';
    const w=48,h=22;
    const pts=vals.map((v,i)=>`${Math.round(i/(vals.length-1||1)*w)},${Math.round(h-v/maxM*(h-4))}`).join(' ');
    return `<svg class="stat-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${clr}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/></svg>`;
  }
  const cards=[
    {label:'Total Tickets',val:total,key:'',clr:'#00d4aa',rgb:'0,212,170',icon:'<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>',delta:'all time',spark:spark(months,'#00d4aa')},
    {label:'Open',val:byStatus.open,key:'open',clr:'#3fb950',rgb:'63,185,80',icon:'<circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>',delta:'needs attention'},
    {label:'In Progress',val:byStatus.in_progress,key:'in_progress',clr:'#f0883e',rgb:'240,136,62',icon:'<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/><circle cx="12" cy="12" r="4"/>',delta:'being worked on'},
    {label:'Pending',val:byStatus.pending,key:'pending',clr:'#a371f7',rgb:'163,113,247',icon:'<circle cx="12" cy="12" r="10"/><path d="M10 9h4M10 15h4"/>',delta:'awaiting response'},
    {label:'Resolved',val:byStatus.closed,key:'closed',clr:'#4f94f8',rgb:'79,148,248',icon:'<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',delta:`${resolveRate}% resolve rate`,deltaUp:true,spark:spark(months,'#4f94f8')},
  ];
  el.innerHTML=cards.map((c,i)=>`
    <div class="stat-card${state.filterStatus===c.key&&c.key?' active':''}"
         style="--stat-clr:${c.clr};--stat-rgb:${c.rgb};animation-delay:${i*.07}s"
         onclick="setChip(document.querySelectorAll('.chip')[${i}],'${c.key}')">
      <div class="stat-card-top">
        <div class="stat-icon"><svg viewBox="0 0 24 24">${c.icon}</svg></div>
        ${c.spark||''}
      </div>
      <div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.val.toLocaleString()}</div>
      ${c.delta?`<div class="stat-delta${c.deltaUp?' up':''}">${c.delta}</div>`:''}
    </div>`).join('');
}

/* ═══ RENDER LIST ═══ */
function renderList() {
  const filtered=getFiltered();
  const totalP=Math.max(1,Math.ceil(filtered.length/PER_PAGE));
  if (state.page>totalP) state.page=1;
  const paged=filtered.slice((state.page-1)*PER_PAGE,state.page*PER_PAGE);
  const cntEl=document.getElementById('resultCount');
  if (cntEl) cntEl.textContent=`${filtered.length.toLocaleString()} result${filtered.length!==1?'s':''}`;
  const listEl=document.getElementById('ticketList');
  if (!listEl) return;
  if (!paged.length) {
    listEl.innerHTML=`<div class="empty-state"><div class="empty-icon">🎫</div><p>No tickets match your filters.</p></div>`;
  } else {
    listEl.innerHTML=paged.map((t,i)=>{
      const urgent=isUrgent(t.subject);
      const subj=urgent?t.subject.replace(/\[urgent\]/i,'').trim():t.subject;
      const clr=statusColor(t.status);
      return `
        <div class="t-row${t.id===state.selectedId?' selected':''}"
             style="animation-delay:${Math.min(i,12)*.025}s;--bar-clr:${clr}"
             onclick="openDetail(${t.id})">
          <div class="t-bar"></div>
          <div class="t-inner">
            <div class="t-top">
              ${urgent?'<span class="urgent-pill">⚡ URGENT</span>':''}
              <span class="t-subject">${esc(subj)}</span>
              <span class="t-id">#${t.id}</span>
            </div>
            <div class="t-bottom">
              <span class="status-badge s-${t.status}">${t.status.replace('_',' ')}</span>
              ${t.tags.slice(0,2).map(g=>`<span class="cat-tag">${esc(g)}</span>`).join('')}
              <span class="t-meta">
                <span class="t-replies"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>${t.replies}</span>
                <span title="Requester">${esc(t.user)}</span>·<span title="Assigned">${esc(t.assignedTo)}</span>·<span>${t.updated||'—'}</span>
              </span>
            </div>
          </div>
        </div>`;
    }).join('');
  }
  renderPager(filtered.length,totalP);
}

function renderPager(total,totalP) {
  const el=document.getElementById('pager');
  if (!el) return;
  if (totalP<=1){el.innerHTML='';return;}
  const btns=[];
  btns.push(`<button class="p-btn" onclick="goPage(${state.page-1})" ${state.page===1?'disabled':''}>‹</button>`);
  for (let i=1;i<=totalP;i++) {
    if (totalP<=7||i===1||i===totalP||Math.abs(i-state.page)<=1) btns.push(`<button class="p-btn${i===state.page?' cur':''}" onclick="goPage(${i})">${i}</button>`);
    else if (Math.abs(i-state.page)===2) btns.push(`<span style="padding:0 2px;color:var(--t4);font-size:11px">…</span>`);
  }
  btns.push(`<button class="p-btn" onclick="goPage(${state.page+1})" ${state.page===totalP?'disabled':''}>›</button>`);
  el.innerHTML=`<span class="pager-info">Page ${state.page}/${totalP} · ${total.toLocaleString()} tickets</span><div class="pager-btns">${btns.join('')}</div>`;
}

/* ═══ RENDER RIGHT PANEL ═══ */
function renderSidebar() {
  const el=document.getElementById('rightPanel');
  if (!el||!state.stats) return;
  const {byCat,byMonth,topUsers,total}=state.stats;
  const maxM=Math.max(...byMonth.map(([,,c])=>c),1);
  const gradients=['#00d4aa','#00d4aa','#00d4aa','#4f94f8','#4f94f8','#4f94f8','#f0883e','#f0883e','#a371f7','#a371f7'];
  const trend=byMonth.map(([lbl,full,c],i)=>{
    const h=Math.max(4,Math.round(c/maxM*52));
    return `<div class="trend-col" title="${esc(full)}: ${c}"><div class="trend-bar-bg"><div class="trend-bar" style="height:${h}px;background:${gradients[i]||'#4f94f8'};transition:height .5s ${i*.05}s ease"></div></div><div class="trend-lbl">${lbl}</div></div>`;
  }).join('');
  const maxC=byCat[0]?.[1]||1;
  const cats=byCat.slice(0,8).map(([name,cnt],i)=>`
    <div class="cat-bar-row" style="animation-delay:${i*.04}s">
      <span class="cat-bar-label" title="${esc(name)}">${esc(name)}</span>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${Math.round(cnt/maxC*100)}%"></div></div>
      <span class="cat-bar-count">${cnt}</span>
    </div>`).join('');
  const users=topUsers.map(([name,cnt,col])=>`
    <div class="user-row">
      <div class="u-avatar-sm" style="background:${col}1a;color:${col}">${initials(name)}</div>
      <span class="u-name-sm" title="${esc(name)}">${esc(name)}</span>
      <span class="u-cnt-sm">${cnt}</span>
    </div>`).join('');
  const range=byMonth.length>=2?`${byMonth[0][1]} – ${byMonth.at(-1)[1]}`:'All time';
  el.innerHTML=`
    <div class="r-card">
      <div class="r-card-head"><span class="r-card-title">Monthly Volume</span><span class="r-card-sub">${esc(range)}</span></div>
      <div class="r-card-body"><div class="trend-wrap">${trend}</div></div>
    </div>
    <div class="r-card">
      <div class="r-card-head"><span class="r-card-title">By Category</span><span class="r-card-sub">${total} total</span></div>
      <div class="r-card-body">${cats}</div>
    </div>
    <div class="r-card">
      <div class="r-card-head"><span class="r-card-title">Top Requesters</span><span class="r-card-sub">all time</span></div>
      <div class="r-card-body">${users}</div>
    </div>`;
}

/* ═══════════════════════════════════════════
   ANALYTICS VIEW  (based on assigned_to = agents)
═══════════════════════════════════════════ */
function renderAnalytics() {
  const el=document.getElementById('analyticsContent');
  if (!el||!state.agentStats) return;
  const agents=sortAgentStats([...state.agentStats]);
  const top3=state.agentStats.slice(0,3); // always sort by total for top cards
  const maxTotal=state.agentStats[0]?.total||1;
  const pcColors=[['#00d4aa','0,212,170'],['#4f94f8','79,148,248'],['#a371f7','163,113,247']];

  /* ── Top 3 Performer Cards ── */
  const perfCards=top3.map((a,i)=>{
    const [clr,rgb]=pcColors[i];
    const barW=Math.round(a.total/maxTotal*100);
    return `
      <div class="perf-card" style="--pc-clr:${clr};--pc-rgb:${rgb}">
        <div class="perf-rank">#${i+1}</div>
        <div class="perf-avatar">${initials(a.name)}</div>
        <div class="perf-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <div class="perf-meta">Top: ${esc(a.topCat)}</div>
        <div class="perf-stats">
          <div class="perf-stat">
            <span class="perf-stat-val" style="color:${clr}">${a.total}</span>
            <span class="perf-stat-lbl">assigned</span>
          </div>
          <div class="perf-stat">
            <span class="perf-stat-val" style="color:${rateColor(a.resolveRate)}">${a.resolveRate}%</span>
            <span class="perf-stat-lbl">resolved</span>
          </div>
          <div class="perf-stat">
            <span class="perf-stat-val" style="color:var(--amber)">${a.avgDays!=null?a.avgDays+'d':'—'}</span>
            <span class="perf-stat-lbl">avg time</span>
          </div>
        </div>
        <div class="perf-bar-wrap"><div class="perf-bar-fill" style="width:${barW}%;background:linear-gradient(90deg,${clr},transparent)"></div></div>
      </div>`;
  }).join('');

  /* ── SVG Horizontal Bar Chart: tickets per agent ── */
  const barData=state.agentStats; // use all agents sorted by total
  const chartW=460, rowH=32, padL=110, padR=60;
  const maxV=barData[0]?.total||1;
  const barRows=barData.map((a,i)=>{
    const bw=Math.max(4, Math.round(a.total/maxV*(chartW-padL-padR)));
    const y=i*rowH;
    const clr=AVATAR_COLORS[i%AVATAR_COLORS.length];
    return `
      <g onclick="filterByAgent('${a.name.replace(/'/g,"\\'")}')" style="cursor:pointer">
        <text class="bar-label" x="${padL-8}" y="${y+rowH/2+4}" text-anchor="end">${esc(a.name.length>14?a.name.slice(0,13)+'…':a.name)}</text>
        <rect class="bar-track" x="${padL}" y="${y+6}" width="${chartW-padL-padR}" height="${rowH-12}" rx="4" fill="var(--bg4)" opacity=".5"/>
        <rect class="bar-rect" x="${padL}" y="${y+6}" width="${bw}" height="${rowH-12}" rx="4" fill="${clr}" opacity=".8">
          <title>${esc(a.name)}: ${a.total} tickets · ${a.resolveRate}% resolved · avg ${a.avgDays!=null?a.avgDays+'d':'—'}</title>
        </rect>
        <text class="bar-value" x="${padL+bw+6}" y="${y+rowH/2+4}">${a.total}</text>
        <text class="bar-pct" x="${chartW-padR+4}" y="${y+rowH/2+4}" style="fill:${rateColor(a.resolveRate)}">${a.resolveRate}%</text>
      </g>`;
  }).join('');
  const chartH = barData.length * rowH + 8;

  /* ── SVG Line Chart: monthly trend ── */
  const months=state.stats.byMonth;
  const lcW=460,lcH=100,lcPad=30;
  const lcMax=Math.max(...months.map(([,,c])=>c),1);
  const lcPts=months.map(([,,c],i)=>`${Math.round(lcPad+i/(months.length-1||1)*(lcW-lcPad*2))},${Math.round(lcH-4-c/lcMax*(lcH-12))}`);
  const lcPath=lcPts.join(' ');
  const lcArea=`${lcPts[0].split(',')[0]},${lcH-2} `+lcPts.join(' ')+` ${lcPts.at(-1).split(',')[0]},${lcH-2}`;
  const lcDots=months.map(([lbl,full,c],i)=>{
    const [cx,cy]=lcPts[i].split(',');
    return `<circle class="lc-dot" cx="${cx}" cy="${cy}" r="3.5" fill="#00d4aa" stroke="var(--bg2)" stroke-width="2">
      <title>${esc(full)}: ${c} tickets</title></circle>
    <text class="bar-label" x="${cx}" y="${lcH+14}" text-anchor="middle">${lbl}</text>`;
  }).join('');

  /* ── Status Breakdown Donut ── */
  const {byStatus,total,resolveRate}=state.stats;
  const statusSegs=[
    {label:'Closed',  val:byStatus.closed,      color:'#4f94f8', filter:'closed'},
    {label:'Open',    val:byStatus.open,         color:'#3fb950', filter:'open'},
    {label:'Progress',val:byStatus.in_progress,  color:'#f0883e', filter:'in_progress'},
    {label:'Pending', val:byStatus.pending,       color:'#a371f7', filter:'pending'},
    {label:'Hold',    val:byStatus.hold||0,       color:'#f85149', filter:'hold'},
  ].filter(s=>s.val>0);
  const donutTot=statusSegs.reduce((s,x)=>s+x.val,0);
  const dr=36,dsw=10,dcirc=2*Math.PI*dr;
  let doff=0,dpaths='';
  for (const seg of statusSegs) {
    const dash=(seg.val/donutTot)*dcirc;
    dpaths+=`<circle cx="44" cy="44" r="${dr}" fill="none" stroke="${seg.color}" stroke-width="${dsw}" stroke-dasharray="${dash.toFixed(2)} ${(dcirc-dash).toFixed(2)}" stroke-dashoffset="${(-doff).toFixed(2)}" style="cursor:pointer"><title>${seg.label}: ${seg.val}</title></circle>`;
    doff+=dash;
  }
  const legend=statusSegs.map(s=>`
    <div class="leg-row" onclick="jumpToFilter('${s.filter}')">
      <span class="leg-dot" style="background:${s.color}"></span>
      <span class="leg-name">${s.label}</span>
      <span class="leg-val">${s.val}</span>
      <span class="leg-pct">${((s.val/donutTot)*100).toFixed(1)}%</span>
    </div>`).join('');

  /* ── Performance Table ── */
  const thSort=(col,label)=>`<th class="sortable${state.tblSort.col===col?' sort-active':''} ${state.tblSort.col===col?(state.tblSort.dir==='asc'?'sort-asc':'sort-desc'):''}" onclick="sortTable('${col}')">${label}</th>`;
  const tableRows=agents.map((a,i)=>{
    const clr=AVATAR_COLORS[state.agentStats.indexOf(a)%AVATAR_COLORS.length]||AVATAR_COLORS[0];
    const rclr=rateColor(a.resolveRate);
    return `
      <tr>
        <td class="tbl-rank">${i+1}</td>
        <td>
          <div class="tbl-user">
            <div class="tbl-avatar" style="background:${clr}1a;color:${clr}">${initials(a.name)}</div>
            <span class="tbl-name">${esc(a.name)}</span>
          </div>
        </td>
        <td class="tbl-num" style="color:var(--teal)">${a.total}</td>
        <td class="tbl-num" style="color:var(--green)">${a.closed}</td>
        <td class="tbl-num" style="color:var(--amber)">${a.open}</td>
        <td>
          <div class="tbl-rate-wrap">
            <div class="tbl-rate-bar"><div class="tbl-rate-fill" style="width:${a.resolveRate}%;background:${rclr}"></div></div>
            <span class="tbl-num" style="color:${rclr};min-width:36px">${a.resolveRate}%</span>
          </div>
        </td>
        <td class="tbl-num" style="color:var(--amber)">${a.avgDays!=null?a.avgDays+'d':'—'}</td>
        <td class="tbl-num" style="color:var(--t3)">${a.replies}</td>
        <td><span class="tbl-badge" style="background:var(--bg4);color:var(--t3)">${esc((a.topCat||'—').slice(0,14))}</span></td>
      </tr>`;
  }).join('');

  el.innerHTML=`
    <div class="analytics-view">
      <!-- Header -->
      <div class="analytics-header">
        <div>
          <h2 class="analytics-title">Agent Performance Analytics</h2>
          <p class="analytics-desc">Based on ticket assignments · ${state.tickets.length} total tickets · ${state.agentStats.length} active agents</p>
        </div>
      </div>

      <!-- Top Performers -->
      <div>
        <div class="section-head">
          <span class="section-title">Top Performers</span>
          <span class="section-sub">by total assignments</span>
        </div>
        <div class="perf-cards">${perfCards}</div>
      </div>

      <!-- Charts row -->
      <div class="chart-grid">
        <!-- Horizontal Bar Chart: workload per agent -->
        <div class="chart-card wide">
          <div class="chart-head">
            <span class="chart-title">Workload per Agent</span>
            <span class="chart-sub">tickets assigned · resolve % · click to filter</span>
          </div>
          <div class="chart-body" style="overflow-x:auto">
            <svg class="bar-chart-svg" viewBox="0 0 ${chartW} ${chartH+8}" style="width:100%;height:${chartH+8}px">
              ${barRows}
            </svg>
          </div>
        </div>

        <!-- Monthly trend -->
        <div class="chart-card">
          <div class="chart-head">
            <span class="chart-title">Monthly Volume Trend</span>
            <span class="chart-sub">${months.length} months · all agents</span>
          </div>
          <div class="chart-body" style="overflow-x:auto">
            <svg class="line-chart-svg" viewBox="0 0 ${lcW} ${lcH+20}" style="min-width:240px;height:${lcH+32}px;width:100%">
              <defs>
                <linearGradient id="lcGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#00d4aa" stop-opacity=".35"/>
                  <stop offset="100%" stop-color="#00d4aa" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <polygon class="lc-area" points="${lcArea}" fill="url(#lcGrad)"/>
              <polyline class="lc-line" points="${lcPath}" stroke="#00d4aa"/>
              ${lcDots}
            </svg>
          </div>
        </div>

        <!-- Status donut -->
        <div class="chart-card">
          <div class="chart-head">
            <span class="chart-title">Status Distribution</span>
            <span class="chart-sub">${total} total · click to filter</span>
          </div>
          <div class="chart-body">
            <div class="breakdown-wrap">
              <div class="breakdown-donut" style="position:relative;width:88px;height:88px;flex-shrink:0">
                <svg viewBox="0 0 88 88" style="transform:rotate(-90deg);width:88px;height:88px">
                  ${dpaths}
                  <circle cx="44" cy="44" r="${dr-dsw/2-2}" fill="var(--bg2)"/>
                </svg>
                <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
                  <div style="font-size:14px;font-weight:700;color:var(--teal);font-family:'JetBrains Mono',monospace">${resolveRate}%</div>
                  <div style="font-size:8px;color:var(--t4)">resolved</div>
                </div>
              </div>
              <div class="breakdown-legend">${legend}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Performance Table -->
      <div>
        <div class="section-head">
          <span class="section-title">Full Performance Table</span>
          <span class="section-sub">Click column headers to sort · click agent name to filter tickets</span>
        </div>
        <div class="chart-card">
          <div class="chart-body" style="padding:0;overflow-x:auto">
            <table class="perf-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  ${thSort('total','Assigned')}
                  ${thSort('closed','Closed')}
                  ${thSort('open','Open')}
                  ${thSort('resolveRate','Resolve %')}
                  ${thSort('avgDays','Avg Days')}
                  ${thSort('replies','Replies')}
                  <th>Top Category</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function sortAgentStats(arr) {
  const {col,dir}=state.tblSort;
  return arr.sort((a,b)=>{ const av=a[col]??-1,bv=b[col]??-1; return dir==='asc'?av-bv:bv-av; });
}
function sortTable(col) {
  if (state.tblSort.col===col) state.tblSort.dir=state.tblSort.dir==='asc'?'desc':'asc';
  else { state.tblSort.col=col; state.tblSort.dir='desc'; }
  renderAnalytics();
}
function filterByAgent(name) {
  state.view='overview'; state.filterStatus=''; state.searchQ=name;
  const sq=document.getElementById('searchQ'); if(sq) sq.value=name;
  showView('overview'); render();
  document.querySelectorAll('.nav-item').forEach((n,i)=>n.classList.toggle('active',i===0));
}
function jumpToFilter(status) {
  state.view='overview'; state.filterStatus=status; state.page=1;
  syncChips(); showView('overview'); render();
  document.querySelectorAll('.nav-item').forEach((n,i)=>n.classList.toggle('active',i===0));
}

/* ═══ DETAIL DRAWER ═══ */
function openDetail(id) {
  state.selectedId=id;
  const t=state.tickets.find(x=>x.id===id);
  if (!t) return;
  const urgent=isUrgent(t.subject);
  const subj=urgent?t.subject.replace(/\[urgent\]/i,'').trim():t.subject;
  document.getElementById('drawerBody').innerHTML=`
    <div class="drawer-status-row">
      <span class="status-badge s-${t.status}">${t.status.replace('_',' ')}</span>
      ${urgent?'<span class="urgent-pill">⚡ URGENT</span>':''}
      ${t.tags.map(g=>`<span class="cat-tag">${esc(g)}</span>`).join('')}
    </div>
    <div class="drawer-subject">${esc(subj)}</div>
    <div class="drawer-meta-grid">
      <span class="dm-key">ticket_id</span><span class="dm-val mono">#${t.id}</span>
      <span class="dm-key">requester</span><span class="dm-val">${esc(t.user)}</span>
      <span class="dm-key">assigned_to</span><span class="dm-val" style="color:var(--teal)">${esc(t.assignedTo)}</span>
      <span class="dm-key">created</span><span class="dm-val mono">${t.created||'—'}</span>
      <span class="dm-key">updated</span><span class="dm-val mono">${t.updated||'—'}</span>
      ${t.closed?`<span class="dm-key">resolved</span><span class="dm-val mono">${t.closed}</span>`:''}
      <span class="dm-key">replies</span><span class="dm-val mono">${t.replies}</span>
    </div>
    ${t.preview?`
    <div class="reply-box">
      <div class="reply-label">Latest Reply</div>
      <div class="reply-text">${esc(t.preview.slice(0,400))}${t.preview.length>400?'…':''}</div>
      <div class="reply-date">${t.updated||'—'}</div>
    </div>`:''}`;
  document.getElementById('detail-overlay').classList.add('show');
  renderList();
}
function closeDetail(e) {
  if (e&&e.target!==document.getElementById('detail-overlay')) return;
  document.getElementById('detail-overlay').classList.remove('show');
  state.selectedId=null; renderList();
}

/* ═══ SIDEBAR TOGGLE ═══ */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('mob-overlay').classList.toggle('show');
}

/* ═══ CAT SELECT ═══ */
function populateCatSelect() {
  const s=document.getElementById('catSel');
  if (!s||!state.stats) return;
  while (s.options.length>1) s.remove(1);
  for (const [name] of state.stats.byCat) { const o=document.createElement('option'); o.value=name; o.textContent=name; s.appendChild(o); }
}
function updateNavBadges() {
  if (!state.stats) return;
  const o=document.getElementById('nav-open'), p=document.getElementById('nav-progress'), sb=document.getElementById('sb-total');
  if (o) o.textContent=state.stats.byStatus.open;
  if (p) p.textContent=state.stats.byStatus.in_progress;
  if (sb) sb.textContent=state.stats.total.toLocaleString();
}

/* ═══ MAIN RENDER ═══ */
function render() { renderStats(); renderList(); renderSidebar(); }

/* ═══ KEYBOARD ═══ */
document.addEventListener('keydown',e=>{
  if (e.key==='Escape') closeDetail({target:document.getElementById('detail-overlay')});
  if ((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();document.getElementById('searchQ')?.focus();}
});

document.addEventListener('DOMContentLoaded',init);
