import { firebaseConfig, ADMIN_UID } from "./firebase-config.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const $ = s => document.querySelector(s);
const main = $("#main");
const topActions = $("#topActions");
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const params = new URLSearchParams(location.search);
const missionParam = params.get("m");
const FORCE_ADMIN = params.get("admin") === "1";
const MAX_SHIPS = 2;
const MAX_PER_SHIP = 14;
const FLEX = "__FLEX__";
const FLEX_LABEL = "No preference / fill a gap";
const SHIP_BADGES = {
  Takanami: "https://cdn.discordapp.com/emojis/1351204968992084038.webp?size=96",
  Havock: "https://cdn.discordapp.com/emojis/1351204847453605970.webp?size=96"
};
function shipBadgeUrl(shipOrName){
  const name=typeof shipOrName==="string"?shipOrName:shipOrName?.name;
  return SHIP_BADGES[name]||"";
}
function shipClass(ship){
  const name=String(ship?.name||"").toLowerCase();
  if(name==="takanami")return "ship-takanami";
  if(name==="havock")return "ship-havock";
  return "ship-unknown";
}

const TEAMS = [
  {id:"command",name:"Command",roles:["Captain"]},
  {id:"operations",name:"Operations",roles:["Helm","Beams","Missiles"]},
  {id:"science",name:"Science",roles:["Nav","Radar","Comms"]},
  {id:"engineering",name:"Engineering",roles:["Engineering","Manual engineer","Dock and drone"]},
  {id:"shuttle",name:"Shuttle",roles:["XO","Shuttle helm","Shuttle generalist","Shuttle engineer"]}
];
const ROLES = TEAMS.flatMap(t=>t.roles.map(name=>({name,team:t.id,teamName:t.name})));
const ROLE_NAMES = ROLES.map(r=>r.name);
const CORE9 = ROLE_NAMES.filter(r=>r!=="Dock and drone" && !r.startsWith("Shuttle") && r!=="XO");
const MAIN10 = ROLE_NAMES.filter(r=>!r.startsWith("Shuttle") && r!=="XO");
const configured = !Object.values(firebaseConfig).some(v=>String(v).startsWith("PASTE_"));

let app, auth, db;
let currentUser = null;
let currentRole = "";
let activeMission = null;
let missionPlayers = [];
let missionUnsubs = [];
let activePlayerProfile = null;
let activePlayerContext = null;
let viewerContext = null;

function roleFor(name){return ROLES.find(r=>r.name===name);}
function teamClass(team){return `team-${team}`;}
function displayShip(ship,index){return ship?.name?.trim() || `Ship ${index+1}`;}
function missionTitle(m){return m?.title?.trim() || "Crew Deployment";}
function deploymentShipSummary(m){
  const names=(m?.ships||[]).map((s,i)=>displayShip(s,i));
  return names.length?names.join(" + "):"Unknown";
}
function dateText(v){if(!v)return "Date not set";const [y,m,d]=String(v).split("-").map(Number);if(!y||!m||!d)return v;return new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(y,m-1,d)));}
function timestampMs(value){if(!value)return Number.MAX_SAFE_INTEGER;if(typeof value.toMillis==="function")return value.toMillis();if(Number.isFinite(value.seconds))return value.seconds*1000+(value.nanoseconds||0)/1e6;const n=Date.parse(value);return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;}
function prioritySort(a,b){return timestampMs(a.priorityAt||a.createdAt)-timestampMs(b.priorityAt||b.createdAt)||String(a.id).localeCompare(String(b.id));}
function normalizeName(s){return String(s||"").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g," ");}
function nameClaimId(name){return encodeURIComponent(normalizeName(name));}
function nameClaimRef(dbInstance,deploymentId,name){return doc(dbInstance,"missions",deploymentId,"nameClaims",nameClaimId(name));}
function duplicateNameMessage(name="That name"){return `${name} is already registered for this deployment. Please use a different name.`;}
function randId(prefix="x"){return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;}
function setMessage(el,text,type=""){if(!el)return;el.textContent=text||"";el.className=`message${type?` ${type}`:""}`;}
function debounce(fn,wait=300){let timer;return function(...args){const ctx=this;clearTimeout(timer);timer=setTimeout(()=>fn.apply(ctx,args),wait);};}
function clearUnsubs(){missionUnsubs.forEach(fn=>{try{fn();}catch{}});missionUnsubs=[];}
const SHUTTLE_FALLBACKS = {
  "XO": ["Captain"],
  "Shuttle helm": ["Helm"],
  "Shuttle engineer": ["Engineering"],
  "Shuttle generalist": ["Beams","Missiles"]
};
function shuttleActiveForCount(count){return Number(count)>=11;}
function rolesForPreference(pref,shuttleActive=true){
  if(!pref||pref===FLEX)return [];
  if(!shuttleActive&&SHUTTLE_FALLBACKS[pref])return [...SHUTTLE_FALLBACKS[pref]];
  return [pref];
}
function fallbackPreferenceLabel(pref,role){
  if(pref==="Shuttle generalist"&&(role==="Beams"||role==="Missiles"))return "Shuttle generalist → weapons";
  if(pref==="XO"&&role==="Captain")return "XO → Captain";
  if(pref==="Shuttle helm"&&role==="Helm")return "Shuttle helm → Helm";
  if(pref==="Shuttle engineer"&&role==="Engineering")return "Shuttle engineer → Engineering";
  return "";
}
function quality(person,role,shuttleActive=true){
  if((person.dislikes||[]).includes(role))return{kind:"avoid",rank:0,label:"Really don't want"};
  for(let i=0;i<3;i++){
    const pref=person.prefs?.[i];
    if(pref===FLEX)return{kind:"flex",rank:0,label:"Happy to fill a gap"};
    if(pref===role)return{kind:"rank",rank:i+1,label:`${i+1}${i===0?"st":i===1?"nd":"rd"} choice`,fallback:false};
    if(!shuttleActive&&rolesForPreference(pref,false).includes(role)){
      const map=fallbackPreferenceLabel(pref,role);
      return{kind:"rank",rank:i+1,label:`${i+1}${i===0?"st":i===1?"nd":"rd"} choice equivalent${map?` · ${map}`:""}`,fallback:true,sourcePref:pref};
    }
  }
  return{kind:"other",rank:0,label:"Other available role"};
}
const FAIRNESS_BASE=31;

function fairnessBase(q){
  const B=FAIRNESS_BASE;
  if(q.kind==="avoid")return B**6+B**4+B**3+B**2+B;
  if(q.kind==="rank"&&q.rank===1)return 0;
  if(q.kind==="rank"&&q.rank===2)return B**4;
  if(q.kind==="rank"&&q.rank===3)return B**4+B**3;
  if(q.kind==="flex")return B**4+B**3+B**2;
  return B**4+B**3+B**2+B;
}
function qualityTieLevel(q){
  if(q.kind==="rank")return Math.max(0,q.rank-1);
  if(q.kind==="flex")return 3;
  if(q.kind==="other")return 4;
  return 5;
}
function stableTie(id,ship,role){
  let h=2166136261;
  const s=`${id}|${ship}|${role}`;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}
  return ((h>>>0)%997)*1e-12;
}
function getOverride(mission,playerId){return mission?.overrides?.[playerId]||null;}

function normalShuttleActive(count,totalCrew,mission){
  count=Number(count)||0;
  totalCrew=Number(totalCrew)||0;
  const shipCount=mission?.ships?.length||1;
  if(shipCount<2)return count>=11;
  if(mission?.balanceShips!==false)return totalCrew>=21&&count>=11;
  return count>=11;
}
function forcedShipCount(players,mission,shipId){
  return players.filter(p=>getOverride(mission,p.id)?.shipId===shipId).length;
}
function rolesForShipCount(ship,count,totalCrew,mission,players){
  const forcedToShip=forcedShipCount(players,mission,ship.id);
  const shuttleActive=normalShuttleActive(count,totalCrew,mission)||forcedToShip>10;
  const roles=shuttleActive?[...ROLE_NAMES]:[...MAIN10];

  // A locked Shuttle station is always legal even below the normal threshold.
  for(const p of players){
    const ov=getOverride(mission,p.id);
    if(!ov?.role)continue;
    if(ov.shipId&&ov.shipId!==ship.id)continue;
    if(!roles.includes(ov.role))roles.push(ov.role);
  }
  return{roles,shuttleActive};
}
function compatibleWithOverride(person,slot,mission){
  const ov=getOverride(mission,person.id);
  if(ov?.role&&slot.role!==ov.role)return false;
  if(ov?.shipId&&slot.shipId!==ov.shipId)return false;
  return true;
}
function globalAssignmentCost(person,slot,mission,shuttleActive,priorityIndex,totalPlayers){
  const ov=getOverride(mission,person.id);
  const shipPenalty=person.shipPref&&person.shipPref!==slot.shipId?1:0;

  // Organiser locks are hard constraints. If only a station is locked,
  // ship preference can still decide which copy of that station is used.
  if(ov?.role){
    return shipPenalty+stableTie(person.id,slot.shipId,slot.role);
  }

  const q=quality(person,slot.role,shuttleActive);
  const primary=fairnessBase(q);
  // Earlier preference time wins only after all substantive outcomes,
  // ship preference and any gentle spreading preference are otherwise tied.
  const priorityWeight=Math.max(1,totalPlayers-priorityIndex);
  const timeTie=priorityWeight*qualityTieLevel(q)*1e-8;
  return primary+shipPenalty+timeTie+stableTie(person.id,slot.shipId,slot.role);
}

function addFlowEdge(graph,from,to,cap,cost,meta=null){
  const forward={to,rev:graph[to].length,cap,cost,meta};
  const reverse={to:from,rev:graph[from].length,cap:0,cost:-cost,meta:null};
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}
function minCostFlow(graph,source,sink,wantedFlow){
  let flow=0,cost=0;
  const n=graph.length;
  while(flow<wantedFlow){
    const dist=Array(n).fill(Infinity);
    const inQueue=Array(n).fill(false);
    const prevNode=Array(n).fill(-1);
    const prevEdge=Array(n).fill(-1);
    const queue=[source];
    dist[source]=0;
    inQueue[source]=true;

    while(queue.length){
      const u=queue.shift();
      inQueue[u]=false;
      for(let i=0;i<graph[u].length;i++){
        const e=graph[u][i];
        if(e.cap<=0)continue;
        const nd=dist[u]+e.cost;
        if(nd+1e-12<dist[e.to]){
          dist[e.to]=nd;
          prevNode[e.to]=u;
          prevEdge[e.to]=i;
          if(!inQueue[e.to]){
            queue.push(e.to);
            inQueue[e.to]=true;
          }
        }
      }
    }
    if(!Number.isFinite(dist[sink]))break;

    let add=wantedFlow-flow;
    for(let v=sink;v!==source;v=prevNode[v]){
      if(v<0||prevNode[v]<0){add=0;break;}
      add=Math.min(add,graph[prevNode[v]][prevEdge[v]].cap);
    }
    if(add<=0)break;

    for(let v=sink;v!==source;v=prevNode[v]){
      const u=prevNode[v],ei=prevEdge[v];
      const e=graph[u][ei];
      e.cap-=add;
      graph[v][e.rev].cap+=add;
    }
    flow+=add;
    cost+=dist[sink]*add;
  }
  return{flow,cost};
}
function solveSplit(players,mission,counts){
  const ships=mission.ships||[];
  const totalPlayers=players.length;
  const slotInfo=ships.map((ship,i)=>rolesForShipCount(ship,counts[i]||0,totalPlayers,mission,players));
  for(let i=0;i<ships.length;i++){
    if(slotInfo[i].roles.length<(counts[i]||0))return null;
  }

  const slots=[];
  ships.forEach((ship,shipIndex)=>{
    for(const role of slotInfo[shipIndex].roles){
      slots.push({
        shipId:ship.id,
        shipIndex,
        role,
        roleData:roleFor(role),
        shuttleActive:slotInfo[shipIndex].shuttleActive
      });
    }
  });

  const playerCount=players.length;
  const source=0;
  const playerStart=1;
  const slotStart=playerStart+playerCount;
  const shipStart=slotStart+slots.length;
  const sink=shipStart+ships.length;
  const graph=Array.from({length:sink+1},()=>[]);
  const usedEdges=Array.from({length:playerCount},()=>[]);

  for(let i=0;i<playerCount;i++){
    addFlowEdge(graph,source,playerStart+i,1,0);
  }
  slots.forEach((slot,j)=>{
    addFlowEdge(graph,slotStart+j,shipStart+slot.shipIndex,1,0);
  });
  ships.forEach((ship,i)=>{
    addFlowEdge(graph,shipStart+i,sink,counts[i]||0,0);
  });

  players.forEach((person,i)=>{
    slots.forEach((slot,j)=>{
      if(!compatibleWithOverride(person,slot,mission))return;
      const edge=addFlowEdge(
        graph,
        playerStart+i,
        slotStart+j,
        1,
        globalAssignmentCost(person,slot,mission,slot.shuttleActive,i,playerCount),
        {playerIndex:i,slotIndex:j}
      );
      usedEdges[i].push({edge,slotIndex:j});
    });
  });

  const solved=minCostFlow(graph,source,sink,playerCount);
  if(solved.flow!==playerCount)return null;

  const assignments=[];
  players.forEach((person,i)=>{
    const used=usedEdges[i].find(x=>x.edge.cap===0);
    if(!used)return;
    const slot=slots[used.slotIndex];
    const q=quality(person,slot.role,slot.shuttleActive);
    assignments.push({
      playerId:person.id,
      name:person.name,
      shipId:slot.shipId,
      role:slot.role,
      team:slot.roleData.team,
      teamName:slot.roleData.teamName,
      quality:q,
      shipMet:!person.shipPref||person.shipPref===slot.shipId,
      forced:Boolean(getOverride(mission,person.id)?.role||getOverride(mission,person.id)?.shipId)
    });
  });
  if(assignments.length!==playerCount)return null;

  return{cost:solved.cost,assignments,slotInfo,counts};
}
function possibleShipSplits(total,shipCount){
  if(shipCount<=1)return total<=MAX_PER_SHIP?[[total]]:[];
  const out=[];
  const minFirst=Math.max(0,total-MAX_PER_SHIP);
  const maxFirst=Math.min(MAX_PER_SHIP,total);
  for(let first=minFirst;first<=maxFirst;first++){
    const second=total-first;
    if(second<0||second>MAX_PER_SHIP)continue;
    out.push([first,second]);
  }
  return out;
}
function chooseGlobalSolution(players,mission){
  const ships=mission.ships||[];
  const splits=possibleShipSplits(players.length,ships.length);
  const solved=[];

  for(const counts of splits){
    const result=solveSplit(players,mission,counts);
    if(!result)continue;
    const imbalance=ships.length===2?Math.abs((counts[0]||0)-(counts[1]||0)):0;
    solved.push({...result,imbalance});
  }
  if(!solved.length)return null;

  // "Balance ships = Yes" is a real operational constraint:
  // use the most even feasible split, with organiser locks allowed to force
  // a less even result. Preference optimisation then happens within that set.
  let pool=solved;
  if(ships.length===2&&mission?.balanceShips!==false){
    const minImbalance=Math.min(...solved.map(x=>x.imbalance));
    pool=solved.filter(x=>x.imbalance===minImbalance);
  }

  for(const x of pool){
    // If balance is off, evenness is only a gentle nudge and is weaker than
    // a single ship preference, station preference, or organiser override.
    x.finalCost=x.cost+(
      ships.length===2&&mission?.balanceShips===false
        ? x.imbalance*0.001
        : 0
    );
  }
  pool.sort((a,b)=>a.finalCost-b.finalCost||a.imbalance-b.imbalance||a.counts[0]-b.counts[0]);
  return pool[0];
}
function computePlan(players,mission){
  const cap=(mission.ships?.length||1)*MAX_PER_SHIP;
  const ordered=[...players].sort(prioritySort);
  const eligible=ordered.slice(0,cap);
  const overflow=Math.max(0,ordered.length-cap);
  const solved=chooseGlobalSolution(eligible,mission);

  if(!solved){
    return{
      byShip:(mission.ships||[]).map(ship=>({ship,players:[],assignments:[],allowed:[...MAIN10],shuttleActive:false})),
      assignments:[],
      overflow,
      error:"No valid crew arrangement could satisfy the current locked assignments.",
      metrics:{first:0,second:0,third:0,flex:0,avoid:0,shipMet:0}
    };
  }

  const byShip=(mission.ships||[]).map((ship,i)=>{
    const assignments=solved.assignments.filter(a=>a.shipId===ship.id);
    const ids=new Set(assignments.map(a=>a.playerId));
    return{
      ship,
      players:eligible.filter(p=>ids.has(p.id)),
      assignments,
      allowed:[...solved.slotInfo[i].roles],
      shuttleActive:Boolean(solved.slotInfo[i].shuttleActive)
    };
  });

  const all=solved.assignments;
  const metrics={
    first:all.filter(a=>a.quality.rank===1).length,
    second:all.filter(a=>a.quality.rank===2).length,
    third:all.filter(a=>a.quality.rank===3).length,
    flex:all.filter(a=>a.quality.kind==="flex").length,
    avoid:all.filter(a=>a.quality.kind==="avoid").length,
    shipMet:all.filter(a=>a.shipMet).length
  };
  return{byShip,assignments:all,overflow,metrics,counts:solved.counts};
}
function roleOptions(selected=""){return `<option value="">Choose…</option><option value="${FLEX}"${selected===FLEX?" selected":""}>${FLEX_LABEL}</option>`+TEAMS.map(t=>`<optgroup label="${esc(t.name)}">${t.roles.map(r=>`<option value="${esc(r)}"${selected===r?" selected":""}>${esc(r)}</option>`).join("")}</optgroup>`).join("");}
function fixedRoleOptions(selected=""){return `<option value="">No fixed assignment</option>`+TEAMS.map(t=>`<optgroup label="${esc(t.name)}">${t.roles.map(r=>`<option value="${esc(r)}"${selected===r?" selected":""}>${esc(r)}</option>`).join("")}</optgroup>`).join("");}
function checkboxes(values=[]){const set=new Set(values);return TEAMS.map(t=>`<div class="check-heading ${t.id}">${t.name}</div>${t.roles.map(r=>`<label class="check"><input type="checkbox" value="${esc(r)}"${set.has(r)?" checked":""}><span>${esc(r)}</span></label>`).join("")}`).join("");}
function readChecks(box){return [...box.querySelectorAll('input[type="checkbox"]:checked')].map(x=>x.value);}
function validatePrefs(p,players=[],ignoreId="",allowBlank=false){
  if(!p.name.trim())return "Enter a name.";
  const prefs=Array.isArray(p.prefs)?p.prefs:["","",""];
  const hasStationChoice=prefs.some(Boolean);
  // Every response must state a station preference. Players can either rank
  // stations or choose the flexible No preference / fill a gap option.
  // Ship preference and organiser locks remain independent of this.
  if(!hasStationChoice)return "Choose your station preferences, or select No preference / fill a gap if you don't mind where you are placed.";
  if(prefs.some(x=>!x))return "Choose all three station preferences. If you don't mind, select No preference / fill a gap.";
  const flexAt=prefs.indexOf(FLEX);if(flexAt>=0&&prefs.slice(flexAt).some(x=>x!==FLEX))return "After No preference, the remaining choices should also be No preference.";
  const concrete=prefs.filter(x=>x&&x!==FLEX);if(new Set(concrete).size!==concrete.length)return "Choose different station roles for your ranked choices.";
  const clash=concrete.find(x=>(p.dislikes||[]).includes(x));if(clash)return `${clash} cannot be both a preference and a role you really don't want.`;
  if(players.some(x=>x.id!==ignoreId&&normalizeName(x.name)===normalizeName(p.name)))return "That name has already been registered for this deployment.";return "";
}
function stationPrefsText(prefs=[]){
  const chosen=(prefs||[]).filter(Boolean);
  if(!chosen.length)return "No station preference";
  return chosen.map(x=>x===FLEX?"No preference":x).join(" → ");
}
function setupCheckHandlers(prefix=""){
  const ids=prefix?[`${prefix}Pref1`,`${prefix}Pref2`,`${prefix}Pref3`]:["pref1","pref2","pref3"];const sels=ids.map(id=>document.getElementById(id));
  function sync(){if(sels[0].value===FLEX){sels[1].value=FLEX;sels[2].value=FLEX;sels[1].disabled=true;sels[2].disabled=true;}else{sels[1].disabled=false;if(sels[1].value===FLEX){sels[2].value=FLEX;sels[2].disabled=true;}else sels[2].disabled=false;}}
  sels.forEach(s=>s?.addEventListener("change",sync));sync();
}
function renderPlan(plan,mission,{organiser=false,ownId=""}={}){
  const chips=TEAMS.map(t=>`<span class="team-chip ${teamClass(t.id)}">${t.name}</span>`).join("");
  const ships=plan.byShip.map((group,idx)=>{const assignmentMap=new Map(group.assignments.map(a=>[a.role,a]));const allowed=new Set(group.allowed);const forcedExtra=new Set(group.assignments.filter(a=>a.forced).map(a=>a.role));const showRoles=[...ROLE_NAMES];
    let rows="";for(const t of TEAMS){const teamRoles=showRoles.filter(r=>roleFor(r).team===t.id);rows+=`<div class="team-heading ${teamClass(t.id)}">${t.name}</div>`;for(const role of teamRoles){const a=assignmentMap.get(role);const own=a?.playerId===ownId;const inactive=!allowed.has(role)&&!forcedExtra.has(role);const state=a?"Filled for now":inactive?"Not in use":"To be decided";const name=a?esc(a.name):inactive?"Shuttle available from 11 crew":"To be decided";rows+=`<div class="station ${teamClass(t.id)}${inactive?" inactive":""}"><div class="station-top"><span class="station-role">${esc(role)}</span><span class="station-state">${state}</span></div><div class="station-name${a?"":" empty"}${a?.quality.kind==="avoid"?" avoid":""}">${name}</div>${organiser&&a?`<div class="quality-note">${esc(a.quality.label)}${a.shipMet?"":" · different ship preference"}${a.forced?" · locked by organiser":""}</div>`:own&&a?`<div class="quality-note">Your current suggestion · ${esc(a.quality.label)}</div>`:""}</div>`;}}
    const badge=shipBadgeUrl(group.ship);return `<section class="ship-card ${shipClass(group.ship)}"><div class="ship-head"><div class="ship-identity">${badge?`<img class="ship-badge" src="${esc(badge)}" alt="${esc(displayShip(group.ship,idx))} badge">`:""}<div class="ship-title${group.ship.name?.trim()?"":" unnamed"}">${esc(displayShip(group.ship,idx))}</div></div><div class="ship-count">${group.players.length} crew</div></div>${rows}</section>`;}).join("");
  const hasInactiveShuttle=plan.byShip.some(group=>!group.shuttleActive);
  const balancedTwo=(mission?.ships?.length||1)===2&&mission?.balanceShips!==false;
  const shuttleRule=balancedTwo
    ?`<b>Balanced two-ship deployment.</b> Shuttle stations stay inactive through response 20. As soon as response 21 exists, the entire crew is recalculated and Shuttle can be used on the ship that takes the 11th crew member.`
    :`<b>Shuttle activates when a ship reaches 11 crew.</b>`;
  const fallbackNote=hasInactiveShuttle?`<div class="shuttle-fallback-note">${shuttleRule} All main-ship stations, including Dock and drone, remain available. Until Shuttle activates, Shuttle choices are remembered and count toward equivalent main-ship roles: XO → Captain, Shuttle helm → Helm, Shuttle engineer → Engineering, Shuttle generalist → Beams or Missiles.</div>`:"";
  return `<div class="team-key">${chips}</div>${fallbackNote}<div class="crew-grid">${ships}</div>`;
}
function playerRules(){return `<div class="rules"><div class="rule"><span class="rule-num">1</span><span><b>First come, first served</b> is used only when two people are otherwise tied for the same place.</span></div><div class="rule"><span class="rule-num">2</span><span><b>The crew can move around</b> while people are still adding preferences. Every new response can change the best overall suggestion.</span></div><div class="rule"><span class="rule-num">3</span><span><b>This is a planning aid.</b> The organiser can make the final call and the suggested crew does not have to be followed.</span></div></div>`;}

async function boot(){
  if(!configured){renderNeedsSetup();return;}
  app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
  if(missionParam){await bootPlayer(missionParam);return;}
  onAuthStateChanged(auth,async user=>{
    currentUser=user;
    if(!user){currentRole="";renderAccountLanding();return;}
    currentRole=user.uid===ADMIN_UID?"admin":"organiser";
    renderTopUser();
    try{
      if(currentRole==="admin"){await renderAdminDashboard();return;}
      try{await user.reload();}catch{}
      await ensureOrganiserProfileAndRender();
    }catch(ex){
      console.error("Could not load account dashboard",ex);
      renderAccountLoadError(ex);
    }
  });
}

function renderAccountLoadError(ex){
  const code=ex?.code||"";
  let detail=ex?.message||"Firebase could not load your account.";
  if(code.includes("permission-denied")){
    detail="Your sign-in worked, but Firestore is blocking the dashboard. Publish the Spark-only firestore.rules file, then refresh this page.";
  }else if(code.includes("failed-precondition")){
    detail="Your sign-in worked, but Firestore is not ready yet. Make sure a Firestore database has been created for this Firebase project.";
  }
  main.innerHTML=`<section class="empty-state"><div class="eyebrow">Signed in, but dashboard could not load</div><h2>Firebase needs one more check</h2><p>${esc(detail)}</p><div class="actions" style="justify-content:center"><button id="retryDashboard" class="btn primary">Try again</button><button id="signOutAfterError" class="btn ghost">Sign out</button></div><p class="sub" style="margin-top:12px">Error code: ${esc(code||"unknown")}</p></section>`;
  $("#retryDashboard").onclick=async()=>{
    try{if(currentRole==="admin")await renderAdminDashboard();else await ensureOrganiserProfileAndRender();}
    catch(err){console.error(err);renderAccountLoadError(err);}
  };
  $("#signOutAfterError").onclick=()=>signOut(auth);
}

function renderNeedsSetup(){topActions.innerHTML="";main.innerHTML=`<section class="empty-state"><div class="eyebrow">One-time setup needed</div><h2>The planner code is ready</h2><p>Create the Firebase project, then put its config into <b>firebase-config.js</b>. The setup guide in the repo walks through it.</p></section>`;}
function renderTopUser(){topActions.innerHTML=`<span class="pill ${currentRole}">${currentRole==="admin"?"Admin":"Organiser"}</span><button id="logoutBtn" class="btn ghost tiny">Sign out</button>`;$("#logoutBtn").onclick=()=>signOut(auth);}
function friendlyAuthError(ex){
  const code=String(ex?.code||"");
  if(code.includes("popup-closed-by-user")||code.includes("cancelled-popup-request"))return "Google sign-in was cancelled.";
  if(code.includes("popup-blocked"))return "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.";
  if(code.includes("account-exists-with-different-credential"))return "An older organiser login already exists for this email. Sign in using the previous method once, or ask the administrator to migrate the organiser account.";
  if(code.includes("unauthorized-domain"))return "This website domain is not authorised in Firebase Authentication yet.";
  if(code.includes("operation-not-allowed"))return "Google Sign-In is not enabled in Firebase Authentication yet.";
  if(code.includes("invalid-credential")||code.includes("wrong-password")||code.includes("user-not-found"))return "That administrator email or password wasn't recognised.";
  if(code.includes("invalid-email"))return "Check the administrator email address.";
  if(code.includes("too-many-requests"))return "Firebase has temporarily limited sign-in attempts from this device. Wait a little and try again.";
  if(code.includes("network-request-failed"))return "The sign-in request could not reach Firebase. Check the connection and try again.";
  return ex?.message||"Something went wrong. Please try again.";
}

function renderBlockedOrganiser(profile){
  topActions.innerHTML=`<span class="pill blocked-account">Organiser access removed</span><button id="blockedSignOut" class="btn ghost tiny">Sign out</button>`;
  main.innerHTML=`<section class="empty-state blocked-account-state"><div class="eyebrow">Organiser account</div><h2>Access has been removed</h2><p>This Google/Firebase organiser identity can still exist in Firebase Authentication, but it cannot create, edit or manage deployments in the planner.</p><p class="sub">If this was unexpected, contact the planner administrator.</p></section>`;
  $("#blockedSignOut").onclick=()=>signOut(auth);
}

function renderAccountLanding(){
  topActions.innerHTML="";
  main.innerHTML=`<section class="login-hero"><div class="login-intro"><div class="eyebrow">Interstellar Deployment Planner</div><h1>Build the right crew for every deployment</h1><p class="login-lead">Collect ranked crew preferences, balance stations across ships, and keep one live suggested deployment plan as responses change.</p></div><div class="login-layout"><div class="login-column"><section class="panel green organiser-primary"><div class="eyebrow">Organiser access</div><h2>Sign in with Google</h2><p class="sub">Use your Google account to create and manage deployments. There is no password to remember and the planner does not send a sign-in email.</p><button id="googleOrganiserBtn" class="google-signin-btn" type="button"><svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.715v2.259h2.909c1.702-1.567 2.684-3.878 2.684-6.614Z"/><path fill="#34A853" d="M9 18c2.43 0 4.468-.806 5.956-2.181l-2.91-2.259c-.805.54-1.835.859-3.046.859-2.344 0-4.328-1.585-5.037-3.715H.956v2.332A8.997 8.997 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.963 10.704A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.168.281-1.704V4.964H.956A8.997 8.997 0 0 0 0 9c0 1.452.347 2.826.956 4.036l3.007-2.332Z"/><path fill="#EA4335" d="M9 3.581c1.321 0 2.507.454 3.441 1.346l2.581-2.582C13.464.892 11.426 0 9 0A8.997 8.997 0 0 0 .956 4.964l3.007 2.332C4.672 5.166 6.656 3.581 9 3.581Z"/></svg><span>Continue with Google</span></button><div id="googleOrganiserMessage" class="message"></div><div class="google-auth-note"><b>What gets stored?</b><span>Your Google display name, email address and Firebase user ID are saved to your organiser profile so the administrator can identify who owns each deployment. The planner does not receive your Google password.</span></div></section><section class="player-link-note"><div><b>Joining a crew?</b><span>Use the unique deployment link your organiser sent you. Players do not need a Google account or password.</span></div></section><details class="admin-access"><summary>Administrator sign in</summary><div class="admin-access-body"><p class="sub">Administrator access only.</p><form id="loginForm"><div class="admin-login-fields"><div class="field"><label>Email</label><input id="loginEmail" type="email" autocomplete="username" required></div><div class="field"><label>Password</label><input id="loginPassword" type="password" autocomplete="current-password" required></div><button class="btn ghost" type="submit">Admin sign in</button></div><div id="loginMessage" class="message"></div></form></div></details></div><aside class="panel feature-panel"><div class="eyebrow">Deployment control</div><h2>What the planner can do</h2><p class="sub feature-intro">Everything an organiser needs to turn a group of preferences into a workable crew plan.</p><div class="feature-list"><div class="feature-item"><span class="feature-index">01</span><div><b>Create deployments</b><span>Set the deployment date and choose the ship in use. Two-ship deployments automatically use Takanami and Havock.</span></div></div><div class="feature-item"><span class="feature-index">02</span><div><b>Send one player link</b><span>Every deployment gets its own unique link. Players open it and submit choices without creating an account.</span></div></div><div class="feature-item"><span class="feature-index">03</span><div><b>Collect real preferences</b><span>Players can rank three stations, choose No preference / fill a gap if they are flexible, and choose a preferred ship on two-ship deployments. They can also flag roles they really do not want.</span></div></div><div class="feature-item"><span class="feature-index">04</span><div><b>Rebalance automatically</b><span>The suggested crew is recalculated whenever preferences change, aiming to satisfy the group as a whole.</span></div></div><div class="feature-item"><span class="feature-index">05</span><div><b>Adapt to crew size</b><span>All stations stay visible. Shuttle availability responds to crew size and the organiser’s ship-balance setting, while early Shuttle preferences still map to useful main-ship equivalents.</span></div></div><div class="feature-item"><span class="feature-index">06</span><div><b>Stay in control</b><span>Add or edit players, close choices, and lock a person to a specific station or ship when the deployment needs it.</span></div></div><div class="feature-item"><span class="feature-index">07</span><div><b>Export a crew PDF</b><span>Generate a sci-fi crew manifest with one page per ship, ready to brief or print.</span></div></div></div></aside></div></section>`;

  $("#googleOrganiserBtn").onclick=async()=>{
    const btn=$("#googleOrganiserBtn"),msg=$("#googleOrganiserMessage");
    btn.disabled=true;setMessage(msg,"Opening Google sign-in…");
    try{
      const provider=new GoogleAuthProvider();
      provider.setCustomParameters({prompt:"select_account"});
      await signInWithPopup(auth,provider);
    }catch(ex){
      setMessage(msg,friendlyAuthError(ex),"error");
      btn.disabled=false;
    }
  };

  $("#loginForm").onsubmit=async e=>{e.preventDefault();try{const cred=await signInWithEmailAndPassword(auth,$("#loginEmail").value.trim(),$("#loginPassword").value);if(cred.user.uid!==ADMIN_UID){await signOut(auth);throw new Error("That is not the administrator account.");}}catch(ex){setMessage($("#loginMessage"),friendlyAuthError(ex),"error");}};
}

async function ensureOrganiserProfileAndRender(){
  if(!currentUser?.emailVerified){
    main.innerHTML=`<section class="empty-state"><div class="eyebrow">Google sign-in</div><h2>Email verification unavailable</h2><p>Firebase did not mark this Google account email as verified, so organiser access cannot be created safely.</p><div class="actions" style="justify-content:center"><button id="unverifiedGoogleSignOut" class="btn ghost">Sign out</button></div></section>`;
    $("#unverifiedGoogleSignOut").onclick=()=>signOut(auth);return;
  }
  const ref=doc(db,"profiles",currentUser.uid),snap=await getDoc(ref);
  if(snap.exists()){
    const profile={id:snap.id,...snap.data()};
    if(profile.blocked===true){renderBlockedOrganiser(profile);return;}
    const patch={};
    if(!profile.email&&currentUser.email)patch.email=currentUser.email;
    if(!profile.name&&currentUser.displayName)patch.name=currentUser.displayName;
    if(Object.keys(patch).length)await updateDoc(ref,{...patch,updatedAt:serverTimestamp()});
    await renderOrganiserDashboard();return;
  }
  const fallback=currentUser.email?.split("@")[0]||"Organiser";
  await setDoc(ref,{name:currentUser.displayName||fallback,email:currentUser.email||"",role:"organiser",blocked:false,authProvider:"google.com",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  await renderOrganiserDashboard();
}
async function renderOrganiserDashboard(){clearUnsubs();const q=query(collection(db,"missions"),where("ownerUid","==",currentUser.uid));const snap=await getDocs(q);const missions=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Organiser dashboard</div><h1>My deployments</h1><p class="sub">Create a deployment, share its player link, then manage the crew as preferences arrive.</p></div><button id="createMissionBtn" class="btn primary">Create deployment</button></div><div id="missionCards" class="grid cards">${missions.length?missions.map(m=>missionCard(m,false)).join(""):`<section class="empty-state"><h2>No deployments yet</h2><p>Create your first deployment to get a player preference link.</p></section>`}</div>`;$("#createMissionBtn").onclick=()=>openMissionSetup();document.querySelectorAll("[data-manage]").forEach(b=>b.onclick=()=>openMissionManager(b.dataset.manage));document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyMissionLink(b.dataset.copy,b));}
function missionCard(m,admin){return `<section class="panel mission-card"><div class="mission-date">${esc(dateText(m.date))}</div><h2>${esc(missionTitle(m))}</h2><p class="sub">${esc(deploymentShipSummary(m))}${Number.isFinite(m.responseCount)?` · ${m.responseCount} response${m.responseCount===1?"":"s"}`:""}</p><div class="mission-meta"><span class="pill ${m.closed?"closed":"open"}">${m.closed?"Choices closed":"Choices open"}</span>${admin?`<span class="pill organiser">${esc(m.ownerName||"Organiser")}</span>`:""}</div><div class="share-box"><input readonly value="${esc(buildMissionLink(m.id))}" aria-label="Player link"><button class="btn ghost tiny" data-copy="${m.id}">Copy link</button></div><div class="actions"><button class="btn primary" data-manage="${m.id}">Manage crew</button>${admin?`<button class="btn ghost" data-transfer-mission="${m.id}">Change organiser</button><button class="btn danger" data-delete-mission="${m.id}">Delete</button>`:""}</div></section>`;}
function buildMissionLink(id){return `${location.origin}${location.pathname}?m=${encodeURIComponent(id)}`;}
async function copyMissionLink(id,button){const text=buildMissionLink(id);try{await navigator.clipboard.writeText(text);const old=button.textContent;button.textContent="Copied";setTimeout(()=>button.textContent=old,1500);}catch{prompt("Copy this player link:",text);}}
async function adminOwnerOptions(selectedUid=""){
  if(currentRole!=="admin")return"";
  const snap=await getDocs(collection(db,"profiles"));
  const profiles=snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.role==="organiser"&&p.blocked!==true).sort((a,b)=>String(a.email||a.name||"").localeCompare(String(b.email||b.name||"")));
  const opts=[`<option value="${esc(ADMIN_UID)}"${selectedUid===ADMIN_UID?" selected":""}>Administrator</option>`];
  for(const p of profiles){const label=p.name&&p.email?`${p.name} — ${p.email}`:(p.email||p.name||p.id);opts.push(`<option value="${esc(p.id)}"${selectedUid===p.id?" selected":""}>${esc(label)}</option>`);}
  return opts.join("");
}
async function ownerDisplay(uid){
  if(uid===ADMIN_UID)return{name:"Administrator",email:""};
  const snap=await getDoc(doc(db,"profiles",uid));
  if(!snap.exists())return{name:"Organiser",email:""};
  const p=snap.data();return{name:p.name||p.email||"Organiser",email:p.email||""};
}
async function openMissionSetup(existing=null){
  const initialCount=Math.max(1,Math.min(2,existing?.ships?.length||1));
  const existingSingle=existing?.ships?.[0]?.name;
  let singleShip=["Takanami","Havock","Unknown"].includes(existingSingle)?existingSingle:"Unknown";
  let balanceShips=existing?.balanceShips!==false;
  const selectedOwner=existing?.ownerUid||(currentRole==="admin"?ADMIN_UID:currentUser.uid);
  const ownerSelect=currentRole==="admin"?`<div class="setup-section admin-owner-section"><div class="setup-section-head"><div><div class="label">Deployment owner</div><p class="sub">Create this deployment under an organiser account, or transfer an existing deployment without changing its players or settings.</p></div></div><div class="field"><label>Organiser account</label><select id="missionOwner">${await adminOwnerOptions(selectedOwner)}</select></div></div>`:"";
  showModal(`<button class="btn ghost tiny modal-close" data-close>Close</button><div class="setup-heading"><div><div class="eyebrow">Deployment setup</div><h2>${existing?"Edit deployment":"Create deployment"}</h2><p class="sub">Set the event details and choose the ship or ships running this deployment.</p></div></div><form id="missionSetupForm" class="deployment-setup-form"><div class="setup-main-fields"><div class="field"><label>Deployment / event name</label><input id="missionName" maxlength="100" value="${esc(existing?.title||"")}" placeholder="e.g. Saturday evening crew"></div><div class="field"><label>Deployment date</label><input id="missionDate" type="date" value="${esc(existing?.date||"")}" required></div></div>${ownerSelect}<div class="setup-section"><div class="setup-section-head"><div><div class="label">How many ships?</div><p class="sub">Choose one ship, or run Takanami and Havock together.</p></div></div><div class="ship-count-choice" role="group" aria-label="Number of ships"><button class="ship-count-card${initialCount===1?" selected":""}" type="button" data-ship-count="1"><b>1</b><span>One ship</span></button><button class="ship-count-card${initialCount===2?" selected":""}" type="button" data-ship-count="2"><b>2</b><span>Takanami + Havock</span></button></div><input id="shipCount" type="hidden" value="${initialCount}"></div><div class="setup-section"><div class="setup-section-head"><div><div class="label">Ships in use</div><p id="shipChoiceHelp" class="sub"></p></div></div><div id="shipVisualPicker" class="ship-visual-picker"></div></div><div id="balanceShipsSection" class="setup-section${initialCount===2?"":" hidden"}"><div class="setup-section-head"><div><div class="label">Balance ships?</div><p class="sub">Choose whether equal ship numbers are an operational priority or whether station preferences should be allowed to create a more uneven split.</p></div></div><div class="balance-choice" role="group" aria-label="Balance ships"><button type="button" class="balance-card${balanceShips?" selected":""}" data-balance-choice="yes"><b>Yes — keep them even</b><span>Keep crew numbers as balanced as possible. Shuttle stays unavailable through response 20; response 21 triggers a full recalculation and can open Shuttle on the 11-crew ship.</span></button><button type="button" class="balance-card${balanceShips?"":" selected"}" data-balance-choice="no"><b>No — optimise freely</b><span>Prioritise the best station matches. Shuttle can open as soon as either ship reaches 11 crew, with a gentle preference for spreading people when outcomes are otherwise similar.</span></button></div></div><div class="setup-lock-note"><div class="lock-symbol">◆</div><div><b>Need to guarantee a station?</b><span>After players respond, the organiser can lock anyone to a station, or to an exact ship + station. Locked assignments are treated as hard constraints by the crew planner.</span></div></div><div class="actions setup-actions"><button class="btn primary" type="submit">${existing?"Save deployment":"Create deployment"}</button></div><div id="missionSetupMessage" class="message"></div></form>`);
  const countEl=$("#shipCount"),picker=$("#shipVisualPicker"),help=$("#shipChoiceHelp"),balanceSection=$("#balanceShipsSection");
  function shipTile(name,selected=false,locked=false){const badge=shipBadgeUrl(name);return `<button type="button" class="visual-ship-card ${shipClass({name})}${selected?" selected":""}${locked?" locked":""}" data-ship-choice="${esc(name)}"${locked?" disabled":""}>${badge?`<img src="${esc(badge)}" alt="">`:`<span class="unknown-ship-icon">?</span>`}<span class="visual-ship-name">${esc(name)}</span>${locked?`<small>Included</small>`:""}</button>`;}
  function drawShips(){const count=Number(countEl.value)||1;document.querySelectorAll("[data-ship-count]").forEach(btn=>btn.classList.toggle("selected",Number(btn.dataset.shipCount)===count));if(count===2){help.textContent="Two-ship deployments automatically use both ships.";picker.innerHTML=shipTile("Takanami",true,true)+shipTile("Havock",true,true);balanceSection.classList.remove("hidden");}else{help.textContent="Tap the ship being used. Choose Unknown if it has not been confirmed yet.";picker.innerHTML=["Takanami","Havock","Unknown"].map(name=>shipTile(name,name===singleShip,false)).join("");picker.querySelectorAll("[data-ship-choice]").forEach(btn=>btn.onclick=()=>{singleShip=btn.dataset.shipChoice;drawShips();});balanceSection.classList.add("hidden");}}
  document.querySelectorAll("[data-balance-choice]").forEach(btn=>btn.onclick=()=>{balanceShips=btn.dataset.balanceChoice==="yes";document.querySelectorAll("[data-balance-choice]").forEach(x=>x.classList.toggle("selected",(x.dataset.balanceChoice==="yes")===balanceShips));});
  document.querySelectorAll("[data-ship-count]").forEach(btn=>btn.onclick=()=>{countEl.value=btn.dataset.shipCount;if(Number(btn.dataset.shipCount)===1&&existing?.ships?.length===1){const old=existing.ships[0]?.name;if(["Takanami","Havock","Unknown"].includes(old))singleShip=old;}drawShips();});
  drawShips();
  $("#missionSetupForm").onsubmit=async e=>{
    e.preventDefault();const n=Number(countEl.value)||1,names=n===2?["Takanami","Havock"]:[singleShip||"Unknown"],ships=names.map((name,i)=>({id:existing?.ships?.[i]?.id||`ship_${i+1}`,name}));
    const ownerUid=currentRole==="admin"?$("#missionOwner").value:currentUser.uid;
    const owner=await ownerDisplay(ownerUid);
    const payload={title:$("#missionName").value.trim(),date:$("#missionDate").value,shipCount:n,ships,balanceShips:n===2?balanceShips:false,closed:existing?.closed||false,overrides:existing?.overrides||{},ownerUid,ownerName:owner.name,updatedAt:serverTimestamp()};
    try{
      if(existing&&currentRole==="admin"&&existing.ownerUid!==ownerUid&&!confirm(`Transfer this deployment to ${owner.name}? The previous organiser will no longer be able to manage it.`))return;
      if(existing)await updateDoc(doc(db,"missions",existing.id),payload);
      else{Object.assign(payload,{createdAt:serverTimestamp()});await addDoc(collection(db,"missions"),payload);}
      closeModal();currentRole==="admin"?renderAdminDashboard():renderOrganiserDashboard();
    }catch(ex){setMessage($("#missionSetupMessage"),ex.message,"error");}
  };
}
function openOwnerTransfer(mission){
  (async()=>{
    showModal(`<button class="btn ghost tiny modal-close" data-close>Close</button><div class="eyebrow">Administrator</div><h2>Change organiser</h2><p class="sub">Transfer <b>${esc(missionTitle(mission))}</b> without changing any players, preferences, assignments or deployment settings.</p><form id="ownerTransferForm"><div class="field"><label>New deployment owner</label><select id="transferOwner">${await adminOwnerOptions(mission.ownerUid)}</select></div><div class="message warn">The new owner will gain organiser control immediately. The previous organiser will no longer be able to manage this deployment.</div><div class="actions"><button class="btn primary" type="submit">Transfer deployment</button></div><div id="transferOwnerMessage" class="message"></div></form>`);
    $("#ownerTransferForm").onsubmit=async e=>{e.preventDefault();const uid=$("#transferOwner").value;if(uid===mission.ownerUid){closeModal();return;}const owner=await ownerDisplay(uid);if(!confirm(`Transfer ${missionTitle(mission)} to ${owner.name}?`))return;try{await updateDoc(doc(db,"missions",mission.id),{ownerUid:uid,ownerName:owner.name,updatedAt:serverTimestamp()});closeModal();renderAdminDashboard();}catch(ex){setMessage($("#transferOwnerMessage"),ex.message,"error");}};
  })();
}

function showModal(content){document.body.insertAdjacentHTML("beforeend",`<div id="modalBackdrop" class="modal-backdrop"><div class="modal">${content}</div></div>`);$("#modalBackdrop").addEventListener("click",e=>{if(e.target.id==="modalBackdrop"||e.target.closest("[data-close]"))closeModal();});}
function closeModal(){$("#modalBackdrop")?.remove();}

async function openMissionManager(id){clearUnsubs();const ref=doc(db,"missions",id),snap=await getDoc(ref);if(!snap.exists()){alert("Deployment not found.");return;}const mission={id:snap.id,...snap.data()};if(currentRole!=="admin"&&mission.ownerUid!==currentUser.uid){alert("You don't have access to manage this deployment.");return;}activeMission=mission;renderManagerShell();const playerRef=collection(db,"missions",id,"players");missionUnsubs.push(onSnapshot(ref,s=>{if(!s.exists())return;activeMission={id:s.id,...s.data()};renderManagerState();}));missionUnsubs.push(onSnapshot(playerRef,s=>{missionPlayers=s.docs.map(d=>({id:d.id,...d.data()}));renderManagerState();}));}

function safeFilenamePart(value){
  return String(value||"")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g,"")
    .replace(/\s+/g,"-")
    .replace(/-+/g,"-")
    .replace(/^-|-$/g,"")
    .slice(0,80) || "deployment";
}
function deploymentPdfFilename(mission){
  const shipPart=(mission?.ships||[]).map((s,i)=>safeFilenamePart(displayShip(s,i))).join("-");
  return `${safeFilenamePart(missionTitle(mission))}_${shipPart||"crew"}_Crew.pdf`;
}
function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=reject;
    reader.readAsDataURL(blob);
  });
}
async function pdfImageData(url){
  if(!url)return null;
  try{
    const response=await fetch(url,{mode:"cors",cache:"force-cache"});
    if(!response.ok)return null;
    return await blobToDataUrl(await response.blob());
  }catch{
    return null;
  }
}
function pdfTeamPalette(team){
  const palettes={
    command:{fill:"#F2BC48",text:"#2E2208",glow:"#F7D987"},
    operations:{fill:"#E88937",text:"#301A08",glow:"#FFC18D"},
    science:{fill:"#41D3EB",text:"#062B35",glow:"#A7F1FC"},
    engineering:{fill:"#49BA7E",text:"#082D1D",glow:"#A6EFC8"},
    shuttle:{fill:"#9D6FDC",text:"#23133C",glow:"#DCC8F9"}
  };
  return palettes[team]||{fill:"#B1C2D0",text:"#172531",glow:"#E1E9EF"};
}
function assignmentForRole(shipPlan,role){
  return (shipPlan?.assignments||[]).find(a=>a.role===role)||null;
}
function loadCanvasImage(dataUrl){
  return new Promise((resolve,reject)=>{
    if(!dataUrl){resolve(null);return;}
    const image=new Image();
    image.onload=()=>resolve(image);
    image.onerror=()=>reject(new Error("Image could not be loaded"));
    image.src=dataUrl;
  });
}
function roundRectPath(ctx,x,y,w,h,r){
  const rr=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y,x+w,y+h,rr);
  ctx.arcTo(x+w,y+h,x,y+h,rr);
  ctx.arcTo(x,y+h,x,y,rr);
  ctx.arcTo(x,y,x+w,y,rr);
  ctx.closePath();
}
function fillRoundRect(ctx,x,y,w,h,r,fill,stroke=null,lineWidth=1){
  roundRectPath(ctx,x,y,w,h,r);
  if(fill){ctx.fillStyle=fill;ctx.fill();}
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lineWidth;ctx.stroke();}
}
function canvasFont(ctx,size,weight="600",family="Rajdhani"){
  ctx.font=`${weight} ${size}px "${family}", sans-serif`;
}
function fitCanvasText(ctx,text,maxWidth,startSize,minSize,weight="700",family="Orbitron"){
  const value=String(text??"");
  let size=startSize;
  while(size>minSize){
    canvasFont(ctx,size,weight,family);
    if(ctx.measureText(value).width<=maxWidth)break;
    size-=1;
  }
  return size;
}
function drawCanvasText(ctx,text,x,y,{size=28,weight="600",family="Orbitron",colour="#172531",align="left",baseline="alphabetic",maxWidth=null}={}){
  canvasFont(ctx,size,weight,family);
  ctx.fillStyle=colour;
  ctx.textAlign=align;
  ctx.textBaseline=baseline;
  if(maxWidth)ctx.fillText(String(text??""),x,y,maxWidth);
  else ctx.fillText(String(text??""),x,y);
}
function drawHudCorners(ctx,x,y,w,h,colour="#41D3EB",length=28,line=3){
  ctx.strokeStyle=colour;
  ctx.lineWidth=line;
  ctx.beginPath();
  ctx.moveTo(x,y+length);ctx.lineTo(x,y);ctx.lineTo(x+length,y);
  ctx.moveTo(x+w-length,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+length);
  ctx.moveTo(x,y+h-length);ctx.lineTo(x,y+h);ctx.lineTo(x+length,y+h);
  ctx.moveTo(x+w-length,y+h);ctx.lineTo(x+w,y+h);ctx.lineTo(x+w,y+h-length);
  ctx.stroke();
}
function drawHexBadge(ctx,cx,cy,r,label,accent="#41D3EB"){
  ctx.save();
  ctx.translate(cx,cy);
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a=-Math.PI/2+i*Math.PI/3;
    const px=Math.cos(a)*r,py=Math.sin(a)*r;
    if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }
  ctx.closePath();
  ctx.fillStyle="#0A2034";ctx.fill();
  ctx.strokeStyle=accent;ctx.lineWidth=4;ctx.stroke();
  ctx.beginPath();ctx.arc(0,0,r*0.68,0,Math.PI*2);ctx.strokeStyle="rgba(255,255,255,.16)";ctx.lineWidth=2;ctx.stroke();
  drawCanvasText(ctx,label,0,4,{size:Math.round(r*.48),weight:"800",family:"Orbitron",colour:"#F7FBFE",align:"center",baseline:"middle"});
  ctx.restore();
}
function drawCircuitDecoration(ctx,w,h){
  ctx.save();
  ctx.strokeStyle="rgba(65,211,235,.11)";
  ctx.lineWidth=2;
  const paths=[
    [[80,410],[210,410],[210,460],[355,460]],
    [[w-80,420],[w-250,420],[w-250,505],[w-390,505]],
    [[95,h-310],[245,h-310],[245,h-365],[360,h-365]],
    [[w-100,h-260],[w-260,h-260],[w-260,h-335],[w-390,h-335]]
  ];
  for(const pts of paths){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();}
  ctx.fillStyle="rgba(242,188,72,.20)";
  for(const [x,y] of [[355,460],[w-390,505],[360,h-365],[w-390,h-335]]){ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
async function generateCrewPdf(){
  const button=$("#downloadCrewPdfBtn");
  const message=$("#managerMessage");
  if(!activeMission)return;

  if(!window.jspdf?.jsPDF){
    setMessage(message,"PDF generator did not load. Refresh the page and try again.","error");
    return;
  }

  const oldText=button?.textContent;
  if(button){button.disabled=true;button.textContent="Generating PDF…";}
  setMessage(message,"Creating themed crew PDF…");

  try{
    if(document.fonts?.ready){
      await document.fonts.ready;
      await Promise.allSettled([
        document.fonts.load('800 44px Orbitron'),
        document.fonts.load('700 38px Orbitron'),
        document.fonts.load('600 32px Orbitron'),
        document.fonts.load('700 40px Orbitron')
      ]);
    }

    const plan=computePlan(missionPlayers,activeMission);
    const {jsPDF}=window.jspdf;
    const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a4",compress:true});

    const [brandBannerData,brandIconData]=await Promise.all([
      pdfImageData("./site-header-banner.png"),
      pdfImageData("./site-icon.png")
    ]);
    const brandBanner=await loadCanvasImage(brandBannerData).catch(()=>null);
    const brandIcon=await loadCanvasImage(brandIconData).catch(()=>null);

    const shipImageData={};
    const shipImages={};
    for(const ship of (activeMission.ships||[])){
      const url=shipBadgeUrl(ship);
      if(!url||shipImageData[url]!==undefined)continue;
      shipImageData[url]=await pdfImageData(url);
      shipImages[url]=await loadCanvasImage(shipImageData[url]).catch(()=>null);
    }

    // A4 at roughly 200 dpi. Crisp enough for printing without huge PDFs.
    const W=1654,H=2339;
    const sx=W/210,sy=H/297;
    const X=mm=>mm*sx,Y=mm=>mm*sy;
    const margin=X(12.5);

    for(let pageIndex=0;pageIndex<plan.byShip.length;pageIndex++){
      const shipPlan=plan.byShip[pageIndex];
      const ship=shipPlan.ship;
      const shipIndex=(activeMission.ships||[]).findIndex(s=>s.id===ship.id);
      const shipName=displayShip(ship,shipIndex);
      const assignedCount=shipPlan.assignments.length;
      const shipImage=shipImages[shipBadgeUrl(ship)]||null;
      const shuttleNormallyAvailable=Boolean(shipPlan.shuttleActive);
      const deploymentCode=String(activeMission.id||"").slice(0,8).toUpperCase()||"LOCAL";

      const canvas=document.createElement("canvas");
      canvas.width=W;canvas.height=H;
      const ctx=canvas.getContext("2d",{alpha:false});
      ctx.imageSmoothingEnabled=true;
      ctx.imageSmoothingQuality="high";

      // Background.
      ctx.fillStyle="#F5F8FA";ctx.fillRect(0,0,W,H);
      const paperGlow=ctx.createLinearGradient(0,0,W,H);
      paperGlow.addColorStop(0,"rgba(65,211,235,.055)");
      paperGlow.addColorStop(.48,"rgba(255,255,255,0)");
      paperGlow.addColorStop(1,"rgba(157,111,220,.045)");
      ctx.fillStyle=paperGlow;ctx.fillRect(0,0,W,H);
      drawCircuitDecoration(ctx,W,H);

      // Header field.
      const headerH=Y(58);
      const headerGrad=ctx.createLinearGradient(0,0,W,headerH);
      headerGrad.addColorStop(0,"#04101E");
      headerGrad.addColorStop(.55,"#071D31");
      headerGrad.addColorStop(1,shipName.toLowerCase()==="havock"?"#211B43":"#08253C");
      ctx.fillStyle=headerGrad;ctx.fillRect(0,0,W,headerH);
      ctx.fillStyle="#F2BC48";ctx.fillRect(0,0,X(1.5),headerH);
      ctx.fillStyle="#41D3EB";ctx.fillRect(X(1.5),0,X(.55),headerH);

      // Sci-fi grid / scanner marks in masthead.
      ctx.save();
      ctx.strokeStyle="rgba(65,211,235,.10)";ctx.lineWidth=1;
      for(let x=X(10);x<W;x+=X(14)){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,headerH);ctx.stroke();}
      for(let y=Y(8);y<headerH;y+=Y(8)){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      ctx.restore();
      drawHudCorners(ctx,X(7),Y(5),W-X(14),headerH-Y(10),"rgba(65,211,235,.55)",X(4),2);

      // Brand banner uses the app's own art.
      if(brandBanner){
        const maxW=X(116),maxH=Y(34);
        const ratio=Math.min(maxW/brandBanner.width,maxH/brandBanner.height);
        ctx.drawImage(brandBanner,X(10),Y(3.5),brandBanner.width*ratio,brandBanner.height*ratio);
      }else{
        drawCanvasText(ctx,"INTERSTELLAR",X(12),Y(17),{size:86,weight:"800",family:"Orbitron",colour:"#F7FBFE"});
        drawCanvasText(ctx,"DEPLOYMENT PLANNER",X(12),Y(26),{size:38,weight:"700",family:"Orbitron",colour:"#41D3EB"});
      }

      // Ship crest / fallback sci-fi badge.
      if(shipImage){
        const r=X(11),cx=W-X(22),cy=Y(17);
        ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.clip();
        const ratio=Math.max((r*2)/shipImage.width,(r*2)/shipImage.height);
        const dw=shipImage.width*ratio,dh=shipImage.height*ratio;
        ctx.drawImage(shipImage,cx-dw/2,cy-dh/2,dw,dh);ctx.restore();
        ctx.beginPath();ctx.arc(cx,cy,r+4,0,Math.PI*2);ctx.strokeStyle="rgba(65,211,235,.75)";ctx.lineWidth=3;ctx.stroke();
      }else{
        const initials=shipName.toLowerCase()==="takanami"?"TKN":shipName.toLowerCase()==="havock"?"HVK":"UNK";
        drawHexBadge(ctx,W-X(22),Y(17),X(10),initials,shipName.toLowerCase()==="havock"?"#9D6FDC":"#41D3EB");
      }

      drawCanvasText(ctx,`SHIP ${String(shipIndex+1).padStart(2,"0")} // ${shipName.toUpperCase()}`,W-X(10),Y(35.5),{size:46,weight:"800",family:"Orbitron",colour:"#F7FBFE",align:"right"});
      drawCanvasText(ctx,`${assignedCount} CREW ASSIGNED`,W-X(10),Y(42.5),{size:29,weight:"700",family:"Orbitron",colour:"#AFC7D8",align:"right"});
      drawCanvasText(ctx,`DEPLOYMENT ID // ${deploymentCode}`,W-X(10),Y(49.5),{size:22,weight:"700",family:"Orbitron",colour:"#688BA3",align:"right"});

      // Gold provenance line requested by organiser.
      drawCanvasText(ctx,"CREW POSITIONS OPTIMISED BY INTERSTELLAR DEPLOYMENT PLANNER",X(12.5),Y(48.8),{size:24,weight:"800",family:"Orbitron",colour:"#F2BC48"});

      const missionTitleText=missionTitle(activeMission);
      const missionSize=fitCanvasText(ctx,missionTitleText,X(140),58,36,"800","Orbitron");
      drawCanvasText(ctx,missionTitleText,X(12.5),Y(56),{size:missionSize,weight:"800",family:"Orbitron",colour:"#F8FBFD"});

      // Metadata rail.
      const metaTop=Y(58),metaH=Y(18);
      ctx.fillStyle="#E8F0F5";ctx.fillRect(0,metaTop,W,metaH);
      ctx.strokeStyle="#CBD9E3";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,metaTop+metaH);ctx.lineTo(W,metaTop+metaH);ctx.stroke();
      const metadata=[
        {x:12.5,label:"DATE",value:dateText(activeMission.date)},
        {x:65,label:"DEPLOYMENT SHIPS",value:deploymentShipSummary(activeMission)},
        {x:137,label:"TOTAL CREW",value:String(missionPlayers.length)},
        {x:170,label:"CHOICES",value:activeMission.closed?"CLOSED":"OPEN"}
      ];
      for(const item of metadata){
        drawCanvasText(ctx,item.label,X(item.x),Y(64.4),{size:22,weight:"800",family:"Orbitron",colour:"#718697"});
        drawCanvasText(ctx,item.value,X(item.x),Y(70.2),{size:31,weight:"700",family:"Orbitron",colour:item.label==="CHOICES"?(activeMission.closed?"#9B3E4A":"#287F58"):"#172531"});
      }

      // Manifest heading.
      const manifestTop=Y(82);
      drawCanvasText(ctx,`${shipName.toUpperCase()} // CREW MANIFEST`,margin,manifestTop,{size:39,weight:"800",family:"Orbitron",colour:"#071727"});
      const balancedTwo=(activeMission?.ships?.length||1)===2&&activeMission?.balanceShips!==false;
      const shuttleStatus=shuttleNormallyAvailable
        ?"FULL STATION GRID ACTIVE"
        :(balancedTwo?"SHUTTLE HELD UNTIL RESPONSE 21":"SHUTTLE ROLES GREYED UNTIL 11 CREW");
      drawCanvasText(ctx,shuttleStatus,W-margin,manifestTop,{size:21,weight:"800",family:"Orbitron",colour:shuttleNormallyAvailable?"#168CA0":"#7A8792",align:"right"});
      ctx.fillStyle="#41D3EB";ctx.fillRect(margin,manifestTop+Y(2.6),W-(margin*2),4);
      ctx.fillStyle="#F2BC48";ctx.fillRect(margin,manifestTop+Y(2.6),X(25),4);

      // Light watermark seal, based on app icon.
      if(brandIcon){
        ctx.save();ctx.globalAlpha=.035;
        const size=X(68);ctx.drawImage(brandIcon,W-X(82),Y(155),size,size);ctx.restore();
      }

      // Team blocks. All 14 stations are always drawn.
      let y=Y(91);
      const groupGap=Y(2.0),headH=Y(7.2),rowH=Y(9.0),blockW=W-(margin*2);
      for(const team of TEAMS){
        const palette=pdfTeamPalette(team.id);
        const inactiveTeam=team.id==="shuttle"&&!shuttleNormallyAvailable;
        const headerFill=inactiveTeam?"#D8E0E6":palette.fill;
        const headerText=inactiveTeam?"#697783":palette.text;

        // Outer team frame.
        const blockH=headH+(team.roles.length*rowH)+Y(2.2);
        fillRoundRect(ctx,margin,y,blockW,blockH,X(1.6),"rgba(255,255,255,.80)","#C9D8E3",2);
        drawHudCorners(ctx,margin+3,y+3,blockW-6,blockH-6,inactiveTeam?"rgba(105,119,131,.35)":"rgba(65,211,235,.28)",X(2.6),2);

        fillRoundRect(ctx,margin,y,blockW,headH,X(1.4),headerFill,null);
        drawCanvasText(ctx,team.name.toUpperCase(),margin+X(3.2),y+headH*.57,{size:27,weight:"800",family:"Orbitron",colour:headerText,baseline:"middle"});
        const teamStatus=inactiveTeam?"NOT IN USE":"STATION GROUP";
        drawCanvasText(ctx,teamStatus,W-margin-X(3.2),y+headH*.57,{size:19,weight:"800",family:"Orbitron",colour:inactiveTeam?"#697783":palette.text,align:"right",baseline:"middle"});

        y+=headH+Y(1.1);
        for(const role of team.roles){
          const assignment=assignmentForRole(shipPlan,role);
          const forcedInactiveAssignment=team.id==="shuttle"&&!shuttleNormallyAvailable&&Boolean(assignment);
          const inactiveRow=team.id==="shuttle"&&!shuttleNormallyAvailable&&!assignment;
          const rowFill=inactiveRow?"#E4E9ED":forcedInactiveAssignment?"#F4EEFC":"#F9FBFC";
          const edge=inactiveRow?"#B6C0C8":forcedInactiveAssignment?"#9D6FDC":palette.fill;
          const roleColour=inactiveRow?"#7E8A94":"#1B2B38";
          const valueColour=inactiveRow?"#8B969F":forcedInactiveAssignment?"#593B86":"#071727";
          const value=assignment?.name||(inactiveRow?"NOT IN USE":"To be decided");

          fillRoundRect(ctx,margin+X(2),y,blockW-X(4),rowH-Y(.8),X(.9),rowFill,"#D3DEE6",1.5);
          ctx.fillStyle=edge;ctx.fillRect(margin+X(2),y,X(.8),rowH-Y(.8));
          drawCanvasText(ctx,role,margin+X(5.2),y+(rowH-Y(.8))/2,{size:33,weight:"700",family:"Orbitron",colour:roleColour,baseline:"middle"});
          drawCanvasText(ctx,value,W-margin-X(5.2),y+(rowH-Y(.8))/2,{size:35,weight:assignment?"700":"600",family:"Orbitron",colour:valueColour,align:"right",baseline:"middle"});
          y+=rowH;
        }
        y+=groupGap;
      }

      // Footer / system identity.
      const footerY=H-Y(15);
      ctx.strokeStyle="#C9D8E3";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(margin,footerY);ctx.lineTo(W-margin,footerY);ctx.stroke();
      if(brandIcon){ctx.drawImage(brandIcon,margin,H-Y(12.3),X(8),X(8));}
      drawCanvasText(ctx,"INTERSTELLAR DEPLOYMENT PLANNER",margin+(brandIcon?X(10):0),H-Y(8.8),{size:22,weight:"800",family:"Orbitron",colour:"#071727"});
      drawCanvasText(ctx,"SYSTEM-GENERATED CREW MANIFEST",margin+(brandIcon?X(10):0),H-Y(5.2),{size:18,weight:"700",family:"Orbitron",colour:"#728596"});
      const generated=new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short"}).format(new Date());
      drawCanvasText(ctx,`GENERATED ${generated.toUpperCase()}`,W-margin,H-Y(8.8),{size:18,weight:"700",family:"Orbitron",colour:"#728596",align:"right"});
      drawCanvasText(ctx,`PAGE ${pageIndex+1} / ${plan.byShip.length}`,W-margin,H-Y(5.2),{size:18,weight:"700",family:"Orbitron",colour:"#728596",align:"right"});

      const img=canvas.toDataURL("image/jpeg",.94);
      if(pageIndex>0)pdf.addPage();
      pdf.addImage(img,"JPEG",0,0,210,297,undefined,"FAST");
    }

    pdf.save(deploymentPdfFilename(activeMission));
    setMessage(message,"Themed crew PDF downloaded.","success");
  }catch(ex){
    console.error("PDF generation failed",ex);
    setMessage(message,`Could not generate PDF: ${ex.message||ex}`,"error");
  }finally{
    if(button){button.disabled=false;button.textContent=oldText||"Download crew PDF";}
  }
}

function renderManagerShell(){const m=activeMission;main.innerHTML=`<div class="page-head"><div><button id="backDashboard" class="btn ghost tiny">← Dashboard</button><div class="eyebrow" style="margin-top:10px">Crew management</div><h1>${esc(missionTitle(m))}</h1><p class="sub">${esc(dateText(m.date))}</p></div><div class="actions"><button id="downloadCrewPdfBtn" class="btn primary">Download crew PDF</button><button id="editMissionBtn" class="btn ghost">Deployment setup</button><button id="closeChoicesBtn" class="btn ${m.closed?"success":"danger"}">${m.closed?"Reopen choices":"Close choices"}</button></div></div><div class="grid two"><aside><section class="panel sticky"><h2>Player link</h2><p class="sub">Send this link to everyone who should add their preferences.</p><div class="share-box"><input id="managerShareLink" readonly value="${esc(buildMissionLink(m.id))}"><button id="managerCopy" class="btn primary tiny">Copy link</button></div><div class="stat-row" id="managerStats"></div><div class="actions"><button id="addPlayerBtn" class="btn ghost">Add someone</button></div><div id="managerMessage" class="message"></div></section><section class="panel"><h2>Responses</h2><div id="responseList" class="response-list"></div></section></aside><section class="panel"><div class="eyebrow">Live suggestion</div><h2>Current crew plan</h2><p class="sub">The whole suggestion is recalculated whenever a preference changes. Fixed organiser choices are worked around automatically.</p><div id="managerPlan"></div></section></div>`;$("#backDashboard").onclick=()=>{clearUnsubs();currentRole==="admin"?renderAdminDashboard():renderOrganiserDashboard();};$("#downloadCrewPdfBtn").onclick=generateCrewPdf;$("#editMissionBtn").onclick=()=>openMissionSetup(activeMission);$("#managerCopy").onclick=()=>copyMissionLink(m.id,$("#managerCopy"));$("#closeChoicesBtn").onclick=async()=>{await updateDoc(doc(db,"missions",m.id),{closed:!activeMission.closed,updatedAt:serverTimestamp()});};$("#addPlayerBtn").onclick=()=>openOrganiserPlayerEditor();}
function renderManagerState(){if(!activeMission||!$("#managerPlan"))return;const cap=(activeMission.ships?.length||1)*MAX_PER_SHIP,plan=computePlan(missionPlayers,activeMission);$("#closeChoicesBtn").textContent=activeMission.closed?"Reopen choices":"Close choices";$("#closeChoicesBtn").className=`btn ${activeMission.closed?"success":"danger"}`;$("#managerStats").innerHTML=`<span class="stat"><b>${missionPlayers.length}</b> responses</span><span class="stat"><b>${cap}</b> places</span><span class="stat"><b>${plan.metrics.first}</b> first choices</span>${plan.metrics.avoid?`<span class="stat"><b>${plan.metrics.avoid}</b> last-resort roles</span>`:""}`;setMessage($("#managerMessage"),plan.error||"",plan.error?"error":"");$("#managerPlan").innerHTML=renderPlan(plan,activeMission,{organiser:true});$("#responseList").innerHTML=missionPlayers.length?[...missionPlayers].sort(prioritySort).map(p=>responseRow(p,plan)).join(""):`<p class="sub">No responses yet.</p>`;document.querySelectorAll("[data-edit-player]").forEach(b=>b.onclick=()=>openOrganiserPlayerEditor(missionPlayers.find(p=>p.id===b.dataset.editPlayer)));document.querySelectorAll("[data-delete-player]").forEach(b=>b.onclick=()=>deleteOrganiserPlayer(b.dataset.deletePlayer));}
function stationPreferenceChips(prefs=[]){
  const chosen=(prefs||[]).filter(Boolean);
  if(!chosen.length)return `<span class="preference-chip neutral">No station preference</span>`;
  return chosen.map((role,index)=>{
    if(role===FLEX)return `<span class="preference-chip neutral">${index+1}. No preference / fill a gap</span>`;
    const info=roleFor(role);
    return `<span class="preference-chip ${teamClass(info?.team||"command")}">${index+1}. ${esc(role)}</span>`;
  }).join("");
}
function responseRow(p,plan){
  const ov=getOverride(activeMission,p.id);
  const multiShip=(activeMission.ships||[]).length>1;
  const ship=p.shipPref?(activeMission.ships||[]).findIndex(s=>s.id===p.shipPref):-1;
  const assignment=plan?.assignments?.find(a=>a.playerId===p.id);
  const assignmentInfo=assignment?roleFor(assignment.role):null;
  const rowTeam=assignmentInfo?.team?` ${teamClass(assignmentInfo.team)}`:"";
  const assignmentShip=assignment?(activeMission.ships||[]).find(s=>s.id===assignment.shipId):null;
  const assignmentShipIndex=assignmentShip?(activeMission.ships||[]).findIndex(s=>s.id===assignment.shipId):-1;
  let lockText="";
  if(ov?.role||ov?.shipId){
    const lockedShipIndex=ov?.shipId?(activeMission.ships||[]).findIndex(s=>s.id===ov.shipId):-1;
    const lockedShip=lockedShipIndex>=0?displayShip(activeMission.ships[lockedShipIndex],lockedShipIndex):"";
    if(ov.role&&ov.shipId)lockText=`Locked: ${esc(ov.role)} · ${esc(lockedShip)}`;
    else if(ov.role)lockText=`Locked station: ${esc(ov.role)} · either ship`;
    else lockText=`Locked ship: ${esc(lockedShip)}`;
  }
  const currentText=assignment?`${multiShip&&assignmentShip?`${esc(displayShip(assignmentShip,assignmentShipIndex))} · `:""}${esc(assignment.role)}`:"Not assigned yet";
  const shipPrefLine=multiShip?`<div class="response-detail-line"><span>Ship preference</span><b>${ship>=0?esc(displayShip(activeMission.ships[ship],ship)):"No preference"}</b></div>`:"";
  return `<details class="player-list-item response-row${rowTeam}"><summary class="player-list-summary"><span class="player-list-name">${esc(p.name)}</span><span class="player-list-current">${currentText}</span><span class="player-list-chevron" aria-hidden="true"></span></summary><div class="player-list-details">${shipPrefLine}<div class="response-detail-block"><span class="response-detail-label">Station preferences</span><div class="preference-chips">${stationPreferenceChips(p.prefs||[])}</div></div>${(p.dislikes||[]).length?`<div class="response-detail-line"><span>Really don't want</span><b>${esc((p.dislikes||[]).join(", "))}</b></div>`:""}${lockText?`<div class="fixed-note">${lockText}</div>`:""}${assignment?`<div class="response-detail-line"><span>Current result</span><b>${esc(assignment.quality?.label||"Assigned")}${assignment.shipMet===false?" · different ship preference":""}</b></div>`:""}<div class="player-list-actions"><button class="btn ghost tiny" data-edit-player="${p.id}">Edit</button><button class="btn danger tiny" data-delete-player="${p.id}">Delete</button></div></div></details>`;
}
async function deleteOrganiserPlayer(id){const p=missionPlayers.find(x=>x.id===id);if(!p||!confirm(`Delete ${p.name}'s response?`))return;await runTransaction(db,async tx=>{tx.delete(doc(db,"missions",activeMission.id,"players",id));tx.delete(nameClaimRef(db,activeMission.id,p.name));});if(activeMission.overrides?.[id]){const overrides={...(activeMission.overrides||{})};delete overrides[id];await updateDoc(doc(db,"missions",activeMission.id),{overrides,updatedAt:serverTimestamp()});}}
function openOrganiserPlayerEditor(player=null){
  const ov=player?getOverride(activeMission,player.id):null;
  const multiShip=(activeMission.ships||[]).length>1;
  const shipOptions=(activeMission.ships||[]).map((s,i)=>`<option value="${s.id}"${player?.shipPref===s.id?" selected":""}>${esc(displayShip(s,i))}</option>`).join("");
  const fixedShipOptions=(activeMission.ships||[]).map((s,i)=>`<option value="${s.id}"${ov?.shipId===s.id?" selected":""}>${esc(displayShip(s,i))}</option>`).join("");
  const shipPrefField=multiShip?`<div class="field"><label>Preferred ship</label><select id="orgShip"><option value="">No preference</option>${shipOptions}</select><small>Ship preference is optional and independent. Station preferences must still be completed, or set to No preference / fill a gap.</small></div>`:"";
  const fixedShipField=multiShip?`<div class="field"><label>Locked ship</label><select id="orgFixedShip"><option value="">Either ship</option>${fixedShipOptions}</select><small>You can lock the ship without locking a station, or lock a station without locking the ship.</small></div>`:"";
  showModal(`<button class="btn ghost tiny modal-close" data-close>Close</button><div class="eyebrow">Organiser entry</div><h2>${player?`Edit ${esc(player.name)}`:"Add someone"}</h2><form id="orgPlayerForm"><div class="field"><label>Name</label><input id="orgName" value="${esc(player?.name||"")}" maxlength="60" required></div>${shipPrefField}<div class="three-fields"><div class="field"><label>1st station</label><select id="orgPref1">${roleOptions(player?.prefs?.[0]||"")}</select></div><div class="field"><label>2nd station</label><select id="orgPref2">${roleOptions(player?.prefs?.[1]||"")}</select></div><div class="field"><label>3rd station</label><select id="orgPref3">${roleOptions(player?.prefs?.[2]||"")}</select></div></div>${multiShip?`<p class="sub">Ship preference is optional. Station preferences are always required: rank stations or choose No preference / fill a gap.</p>`:""}<div class="label">Really don't want</div><div id="orgDislikes" class="checks">${checkboxes(player?.dislikes||[])}</div><hr style="border:0;border-top:1px solid var(--line);margin:15px 0"><div class="eyebrow">Optional locked assignment</div><div class="field"><label>Locked station</label><select id="orgFixedRole">${fixedRoleOptions(ov?.role||"")}</select><small>Leave this as No fixed assignment to let the planner choose the station normally.</small></div>${fixedShipField}<div class="actions"><button class="btn primary" type="submit">Save</button></div><div id="orgPlayerMessage" class="message"></div></form>`);
  setupCheckHandlers("org");
  $("#orgPlayerForm").onsubmit=async e=>{
    e.preventDefault();
    const id=player?.id||randId("org");
    const payload={name:$("#orgName").value.trim(),shipPref:$("#orgShip")?.value||"",prefs:[$("#orgPref1").value,$("#orgPref2").value,$("#orgPref3").value],dislikes:readChecks($("#orgDislikes"))};
    const fixedRole=$("#orgFixedRole").value,fixedShip=$("#orgFixedShip")?.value||"";
    const error=validatePrefs(payload,missionPlayers,player?.id||"",Boolean(fixedRole||fixedShip));if(error){setMessage($("#orgPlayerMessage"),error,"error");return;}
    if(fixedRole&&fixedShip){const clash=Object.entries(activeMission.overrides||{}).find(([pid,x])=>pid!==id&&x.role===fixedRole&&x.shipId===fixedShip);if(clash){setMessage($("#orgPlayerMessage"),"That exact ship + station is already locked to someone else.","error");return;}}
    if(fixedRole){const sameRole=Object.entries(activeMission.overrides||{}).filter(([pid,x])=>pid!==id&&x.role===fixedRole).length;if(sameRole>=(activeMission.ships?.length||1)){setMessage($("#orgPlayerMessage"),`There are only ${activeMission.ships?.length||1} copies of ${fixedRole} across this deployment. Remove another locked ${fixedRole} assignment first.`,"error");return;}}
    try{
      const playerRef=doc(db,"missions",activeMission.id,"players",id),old=player?{...player}:null;
      await runTransaction(db,async tx=>{
        const claimRef=nameClaimRef(db,activeMission.id,payload.name),claim=await tx.get(claimRef);if(claim.exists()&&claim.data()?.playerId!==id)throw new Error(duplicateNameMessage(payload.name));
        tx.set(claimRef,{playerId:id,name:payload.name,updatedAt:serverTimestamp()},{merge:true});if(old&&nameClaimId(old.name)!==nameClaimId(payload.name))tx.delete(nameClaimRef(db,activeMission.id,old.name));
        const base={...payload,source:"organiser",updatedAt:serverTimestamp()};if(old){base.createdAt=old.createdAt||serverTimestamp();base.priorityAt=preferenceChanged(old,payload)?serverTimestamp():(old.priorityAt||old.createdAt||serverTimestamp());}else{base.createdAt=serverTimestamp();base.priorityAt=serverTimestamp();}tx.set(playerRef,base,{merge:true});
      });
      const overrides={...(activeMission.overrides||{})};if(fixedRole||fixedShip)overrides[id]={role:fixedRole||"",shipId:fixedShip||""};else delete overrides[id];await updateDoc(doc(db,"missions",activeMission.id),{overrides,updatedAt:serverTimestamp()});closeModal();
    }catch(ex){setMessage($("#orgPlayerMessage"),ex.message,"error");}
  };
}
function preferenceChanged(old,p){return old.shipPref!==p.shipPref||JSON.stringify(old.prefs||[])!==JSON.stringify(p.prefs)||JSON.stringify([...(old.dislikes||[])].sort())!==JSON.stringify([...p.dislikes].sort());}

function adminQualityText(a){
  if(!a)return"Not currently assigned";
  if(a.quality?.kind==="rank")return `${a.quality.rank}${a.quality.rank===1?"st":a.quality.rank===2?"nd":"rd"} choice`;
  if(a.quality?.kind==="flex")return"Flexible / fill a gap";
  if(a.quality?.kind==="avoid")return"Really don't want";
  return"Other acceptable station";
}
function adminPlayerAssignmentRows(m){
  const players=m.adminPlayers||[],plan=m.adminPlan;
  if(!players.length)return`<p class="sub">No player responses yet.</p>`;
  return [...players].sort(prioritySort).map(p=>{
    const a=plan?.assignments?.find(x=>x.playerId===p.id),ship=a?(m.ships||[]).find(s=>s.id===a.shipId):null,shipIndex=ship?(m.ships||[]).findIndex(s=>s.id===a.shipId):-1;
    const shipName=a?displayShip(ship,shipIndex):"—",quality=adminQualityText(a),shipPref=p.shipPref?(m.ships||[]).find(s=>s.id===p.shipPref):null,shipPrefIndex=shipPref?(m.ships||[]).findIndex(s=>s.id===p.shipPref):-1;
    const assignmentTeam=a?.role?roleFor(a.role)?.team:"";
    const currentText=a?`${(m.ships||[]).length>1?`${esc(shipName)} · `:""}${esc(a.role)}`:"Not assigned yet";
    const shipPrefText=(m.ships||[]).length>1?(shipPref?esc(displayShip(shipPref,shipPrefIndex)):"No preference"):"";
    const prefs=stationPreferenceChips(p.prefs||[]);
    return `<details class="player-list-item admin-assignment-row${assignmentTeam?` ${teamClass(assignmentTeam)}`:""}"><summary class="player-list-summary"><span class="player-list-name">${esc(p.name)}</span><span class="player-list-current">${currentText}</span><span class="player-list-chevron" aria-hidden="true"></span></summary><div class="player-list-details">${(m.ships||[]).length>1?`<div class="response-detail-line"><span>Ship preference</span><b>${shipPrefText}</b></div>`:""}<div class="response-detail-block"><span class="response-detail-label">Station preferences</span><div class="preference-chips">${prefs}</div></div>${(p.dislikes||[]).length?`<div class="response-detail-line"><span>Really don't want</span><b>${esc((p.dislikes||[]).join(", "))}</b></div>`:""}<div class="response-detail-line"><span>Assignment quality</span><b class="${a?.quality?.kind==="avoid"?"avoid":""}">${esc(quality)}</b></div>${(m.ships||[]).length>1&&p.shipPref?`<div class="response-detail-line"><span>Ship preference result</span><b>${a?.shipMet?"Met":`Preferred ${shipPrefText}`}</b></div>`:""}${a?.forced?`<div class="fixed-note">Fixed by organiser</div>`:""}</div></details>`;
  }).join("");
}

function adminGlobalRoleRoster(m){
  const plan=m.adminPlan||computePlan(m.adminPlayers||[],m);
  const ships=m.ships||[];
  if(!ships.length)return `<div class="admin-global-roster-empty">No ships configured.</div>`;

  const shipBlocks=ships.map((ship,shipIndex)=>{
    const shipPlan=plan?.byShip?.find(x=>x.ship?.id===ship.id)||{assignments:[],allowed:[...MAIN10]};
    const assignmentMap=new Map((shipPlan.assignments||[]).map(a=>[a.role,a]));
    const allowed=new Set(shipPlan.allowed||[]);
    const columns=[ROLE_NAMES.slice(0,7),ROLE_NAMES.slice(7,14)];
    const roleColumns=columns.map(roles=>`<div class="admin-role-column">${roles.map(role=>{
      const a=assignmentMap.get(role);
      const info=roleFor(role);
      const inactive=!allowed.has(role)&&!a;
      const name=a?.name||(inactive?"Not in use":"To be decided");
      const detail=a?`${adminQualityText(a)}${(m.ships||[]).length>1&&!a.shipMet?" · ship preference not met":""}${a.forced?" · fixed":""}`:(inactive?"Station inactive":"Awaiting assignment");
      return `<div class="admin-role-slot ${teamClass(info?.team||"command")}${inactive?" inactive":""}${a?.quality?.kind==="avoid"?" avoid":""}"><div class="admin-role-slot-copy"><span class="admin-role-name">${esc(role)}</span><b>${esc(name)}</b></div><span class="admin-role-detail">${esc(detail)}</span></div>`;
    }).join("")}</div>`).join("");
    const badge=shipBadgeUrl(ship);
    const assigned=(shipPlan.assignments||[]).length;
    return `<section class="admin-global-ship-roster ${shipClass(ship)}"><div class="admin-global-ship-head"><div class="admin-global-ship-identity">${badge?`<img src="${esc(badge)}" alt="" class="admin-global-ship-badge">`:""}<div><span>Current assignments</span><b>${esc(displayShip(ship,shipIndex))}</b></div></div><span class="pill">${assigned}/14 filled</span></div><div class="admin-role-columns">${roleColumns}</div></section>`;
  }).join("");

  return `<div class="admin-global-roster"><div class="admin-global-ship-grid">${shipBlocks}</div></div>`;
}

function adminGlobalDeploymentRow(m){
  return `<div class="admin-global-deployment-row">${missionCard(m,true)}${adminGlobalRoleRoster(m)}</div>`;
}
async function removeOrganiserAccessFromControlCentre(uid,label){
  if(uid===ADMIN_UID){alert("The administrator account cannot be removed here.");return;}
  if(!confirm(`Remove ${label}'s organiser access and delete every deployment they own? Their Firebase Authentication login record will remain, but the planner will block that UID.`))return;
  const typed=prompt(`Type REMOVE to delete ${label}'s deployments and block their organiser access.`);
  if(typed!=="REMOVE")return;
  try{
    const ownedSnap=await getDocs(query(collection(db,"missions"),where("ownerUid","==",uid)));
    for(const missionDoc of ownedSnap.docs)await deleteMissionCascade(missionDoc.id,false);
    await setDoc(doc(db,"profiles",uid),{role:"organiser",blocked:true,blockedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
    alert(`${label}'s organiser access has been removed. ${ownedSnap.size} deployment(s) deleted. Their Firebase Auth record remains but cannot manage the planner.`);
    await renderAdminDashboard();
  }catch(ex){alert(ex?.message||"Could not remove organiser access.");}
}
async function unblockOrganiserFromControlCentre(uid,label){
  if(!confirm(`Restore organiser access for ${label}?`))return;
  try{await updateDoc(doc(db,"profiles",uid),{blocked:false,unblockedAt:serverTimestamp(),updatedAt:serverTimestamp()});await renderAdminDashboard();}
  catch(ex){alert(ex?.message||"Could not restore organiser access.");}
}
async function renderAdminDashboard(){
  clearUnsubs();
  const [missionSnap,profileSnap]=await Promise.all([getDocs(collection(db,"missions")),getDocs(collection(db,"profiles"))]);
  const profiles=profileSnap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.role==="organiser").sort((a,b)=>String(a.email||a.name||"").localeCompare(String(b.email||b.name||"")));
  let missions=missionSnap.docs.map(d=>({id:d.id,...d.data()}));
  const missionData=await Promise.all(missions.map(async m=>{try{const ps=await getDocs(collection(db,"missions",m.id,"players")),players=ps.docs.map(d=>({id:d.id,...d.data()})),plan=computePlan(players,m);return[m.id,{players,plan}];}catch{return[m.id,{players:[],plan:null}];}}));
  const dataMap=new Map(missionData),profileMap=new Map(profiles.map(p=>[p.id,p]));
  missions=missions.map(m=>{const data=dataMap.get(m.id)||{players:[],plan:null};return{...m,ownerName:m.ownerUid===ADMIN_UID?"Administrator":(profileMap.get(m.ownerUid)?.name||m.ownerName||"Organiser"),ownerEmail:profileMap.get(m.ownerUid)?.email||"",responseCount:data.players.length,adminPlayers:data.players,adminPlan:data.plan};}).sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
  const activeProfiles=profiles.filter(p=>p.blocked!==true),blockedProfiles=profiles.filter(p=>p.blocked===true);
  const renderOrganiserCard=p=>{
    const owned=missions.filter(m=>m.ownerUid===p.id),label=p.name||p.email||"Organiser",blocked=p.blocked===true;
    const deployments=owned.length?owned.map(m=>`<div class="admin-organiser-deployment"><div class="admin-organiser-deployment-main"><div><b>${esc(missionTitle(m))}</b><span>${esc(dateText(m.date))} · ${esc(deploymentShipSummary(m))}</span></div><div class="mission-meta"><span class="pill ${m.closed?"closed":"open"}">${m.closed?"Closed":"Open"}</span><span class="pill">${m.responseCount} response${m.responseCount===1?"":"s"}</span></div></div><div class="actions"><button class="btn primary tiny" data-manage="${m.id}">Manage</button><button class="btn ghost tiny" data-copy="${m.id}">Copy player link</button><button class="btn ghost tiny" data-transfer-mission="${m.id}">Change organiser</button></div><details class="admin-deployment-players"><summary>Players & assignments <span>${m.responseCount}</span></summary><div class="admin-assignment-list">${adminPlayerAssignmentRows(m)}</div></details></div>`).join(""):`<p class="sub">No deployments currently owned.</p>`;
    const accountAction=blocked
      ?`<button class="btn success tiny" data-unblock-organiser="${p.id}" data-organiser-label="${esc(label)}">Restore organiser access</button>`
      :`<button class="btn danger tiny" data-remove-organiser="${p.id}" data-organiser-label="${esc(label)}">Remove access + delete deployments</button>`;
    return `<details class="panel admin-organiser-card${blocked?" blocked-organiser":""}"><summary><div><div class="eyebrow">Organiser ${blocked?"· REMOVED":""}</div><h2>${esc(label)}</h2><div class="admin-organiser-email">${esc(p.email||"No email stored")}</div></div><div class="admin-organiser-summary-meta"><span class="stat"><b>${owned.length}</b> deployment${owned.length===1?"":"s"}</span><span class="pill ${blocked?"blocked-account":"organiser"}">${blocked?"Access removed":"Active"}</span><span class="admin-view-hint">View details</span></div></summary><div class="admin-organiser-details"><div class="admin-organiser-uid"><span>UID</span><code>${esc(p.id)}</code></div><div class="admin-organiser-account-actions">${accountAction}</div><div class="admin-organiser-deployments">${deployments}</div></div></details>`;
  };
  const activeOrganiserCards=activeProfiles.length?activeProfiles.map(renderOrganiserCard).join(""):`<section class="empty-state compact"><h2>No active organisers</h2><p>New organisers will appear here after they first sign in with Google.</p></section>`;
  const removedOrganisers=blockedProfiles.length?`<details class="panel admin-removed-organisers"><summary><div><div class="eyebrow">Archive</div><b>Removed organisers</b></div><div class="admin-removed-summary"><span class="pill blocked-account">${blockedProfiles.length}</span><span class="admin-view-hint">Show removed</span></div></summary><div class="admin-removed-body"><p class="sub">These accounts are blocked from organiser access. They stay here so the same Firebase UID cannot automatically regain access. Open an account to restore it.</p><div class="admin-organiser-list">${blockedProfiles.map(renderOrganiserCard).join("")}</div></div></details>`:"";
  main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Administrator</div><h1>Control centre</h1><p class="sub">See organiser accounts, their deployments, players and current optimised assignments.</p></div><button id="adminCreateMissionBtn" class="btn primary">Create deployment</button></div><div class="stat-row"><span class="stat"><b>${activeProfiles.length}</b> active organisers</span><span class="stat"><b>${blockedProfiles.length}</b> removed</span><span class="stat"><b>${missions.length}</b> deployments</span><span class="stat"><b>${missions.reduce((n,m)=>n+m.responseCount,0)}</b> total responses</span></div><section class="admin-section"><div class="admin-section-head"><div><div class="eyebrow">Accounts</div><h2>Organisers</h2><p class="sub">Active organisers are shown here. Removed accounts are kept separately below and stay blocked until you restore them.</p></div></div><div class="admin-organiser-list">${activeOrganiserCards}</div>${removedOrganisers}</section><section class="admin-section"><div class="admin-section-head"><div><div class="eyebrow">Global view</div><h2>All deployments</h2><p class="sub">Every deployment, including administrator-owned deployments.</p></div></div><div class="grid cards admin-global-deployment-list">${missions.length?missions.map(m=>adminGlobalDeploymentRow(m)).join(""):`<section class="empty-state"><h2>No deployments yet</h2><p>Create a deployment yourself or wait for an organiser to create one.</p></section>`}</div></section>`;
  $("#adminCreateMissionBtn").onclick=()=>openMissionSetup();
  document.querySelectorAll("[data-manage]").forEach(b=>b.onclick=()=>openMissionManager(b.dataset.manage));
  document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyMissionLink(b.dataset.copy,b));
  document.querySelectorAll("[data-transfer-mission]").forEach(b=>{b.onclick=()=>{const mission=missions.find(m=>m.id===b.dataset.transferMission);if(mission)openOwnerTransfer(mission);};});
  document.querySelectorAll("[data-remove-organiser]").forEach(b=>b.onclick=()=>removeOrganiserAccessFromControlCentre(b.dataset.removeOrganiser,b.dataset.organiserLabel||"this organiser"));
  document.querySelectorAll("[data-unblock-organiser]").forEach(b=>b.onclick=()=>unblockOrganiserFromControlCentre(b.dataset.unblockOrganiser,b.dataset.organiserLabel||"this organiser"));
  document.querySelectorAll("[data-delete-mission]").forEach(b=>{b.onclick=async()=>{if(confirm("Delete this deployment and all player responses?"))await deleteMissionCascade(b.dataset.deleteMission);};});
}

async function deleteMissionCascade(id,refresh=true){const [ps,claims]=await Promise.all([getDocs(collection(db,"missions",id,"players")),getDocs(collection(db,"missions",id,"nameClaims"))]);const batch=writeBatch(db);ps.docs.forEach(d=>batch.delete(d.ref));claims.docs.forEach(d=>batch.delete(d.ref));batch.delete(doc(db,"missions",id));await batch.commit();if(refresh)await renderAdminDashboard();}

function localProfilesKey(missionId){return `bcCrewProfiles:${missionId}`;}
function getLocalProfiles(missionId){try{return JSON.parse(localStorage.getItem(localProfilesKey(missionId))||"{}")||{};}catch{return{};}}
function saveLocalProfiles(missionId,map){localStorage.setItem(localProfilesKey(missionId),JSON.stringify(map));}
async function namedAnonymousContext(appName){let named=getApps().find(a=>a.name===appName);if(!named)named=initializeApp(firebaseConfig,appName);const a=getAuth(named),d=getFirestore(named);let user=a.currentUser;if(!user){const cred=await signInAnonymously(a);user=cred.user;}return{app:named,auth:a,db:d,user};}
async function resolveSavedPlayer(loadForm){const profiles=getLocalProfiles(activeMission.id),last=localStorage.getItem(`bcCrewLast:${activeMission.id}`);if(activePlayerProfile)return;if(last&&profiles[last])await activatePlayerProfile(profiles[last],loadForm);}
async function ensurePlayerProfile(name){const key=normalizeName(name),profiles=getLocalProfiles(activeMission.id);let profile=profiles[key];if(profile){const ctx=await namedAnonymousContext(profile.appName);profile.uid=ctx.user.uid;profiles[key]=profile;saveLocalProfiles(activeMission.id,profiles);return{profile,ctx};}const appName=`player_${activeMission.id.slice(0,8)}_${Math.random().toString(36).slice(2,10)}`;const ctx=await namedAnonymousContext(appName);profile={name,appName,uid:ctx.user.uid};profiles[key]=profile;saveLocalProfiles(activeMission.id,profiles);return{profile,ctx};}
async function activatePlayerProfile(profile,loadForm=true){const ctx=await namedAnonymousContext(profile.appName);activePlayerProfile={...profile,uid:ctx.user.uid};activePlayerContext=ctx;localStorage.setItem(`bcCrewLast:${activeMission.id}`,normalizeName(profile.name));const entry=missionPlayers.find(p=>p.id===ctx.user.uid);if(entry&&loadForm)populatePlayerForm(entry);renderPlayerIdentity(entry?"owned":"new",profile.name);renderPlayerState();}
async function bootPlayer(missionId){
  try{viewerContext=await namedAnonymousContext(`viewer_${missionId.replace(/[^a-z0-9]/gi,"_")}`);const mSnap=await getDoc(doc(viewerContext.db,"missions",missionId));if(!mSnap.exists()){renderPlayerError("That deployment link doesn't exist.");return;}activeMission={id:mSnap.id,...mSnap.data()};renderPlayerShell();missionUnsubs.push(onSnapshot(doc(viewerContext.db,"missions",missionId),s=>{if(!s.exists())return;activeMission={id:s.id,...s.data()};renderPlayerState();}));missionUnsubs.push(onSnapshot(collection(viewerContext.db,"missions",missionId,"players"),s=>{missionPlayers=s.docs.map(d=>({id:d.id,...d.data()}));renderPlayerState();resolveSavedPlayer(false);}));
  }catch(ex){renderPlayerError(ex.message||"Could not open this deployment.");}
}
function renderPlayerError(text){topActions.innerHTML="";main.innerHTML=`<section class="empty-state"><h2>Couldn't open the deployment</h2><p>${esc(text)}</p></section>`;}
function renderPlayerShell(){
  const m=activeMission;
  const multiShip=(m.ships||[]).length>1;
  const shipField=multiShip?`<div class="field"><label>Preferred ship</label><select id="shipPref"></select><small>Ship preference is optional and separate from station preference. You must still rank stations or choose No preference / fill a gap.</small></div>`:"";
  topActions.innerHTML=`<span class="pill ${m.closed?"closed":"open"}" id="playerOpenPill">${m.closed?"Choices closed":"Choices open"}</span>`;
  main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Player crew choices</div><h1>${esc(missionTitle(m))}</h1><p class="sub">${esc(dateText(m.date))}</p></div></div><div class="grid two"><aside><section class="panel"><h2>Your choices</h2><p class="sub">Tell the organiser what you'd most like to do. The crew suggestion can move around as more people reply.</p>${playerRules()}<div id="playerIdentity" class="registration-banner"><b>New crew member</b><span>Enter your name below.</span></div><div id="myChoiceSummary"></div><form id="playerForm"><div class="field"><label>Who is being registered?</label><input id="playerName" maxlength="60" autocomplete="off" required placeholder="Your name"></div>${shipField}<div class="three-fields"><div class="field"><label>1st station</label><select id="pref1">${roleOptions()}</select></div><div class="field"><label>2nd station</label><select id="pref2">${roleOptions()}</select></div><div class="field"><label>3rd station</label><select id="pref3">${roleOptions()}</select></div></div>${multiShip?`<p class="sub">Choose all three station preferences. If you do not mind which station you get, select No preference / fill a gap.</p>`:""}<div class="label">Really don't want</div><div id="dislikes" class="checks">${checkboxes()}</div><div class="actions"><button id="playerSubmit" class="btn primary" type="submit">Save my choices</button><button id="anotherPlayer" class="btn ghost hidden" type="button">Register someone else</button></div><div id="playerMessage" class="message"></div></form><div class="message warn">You can edit your choices later only from the same device and browser you used to register. If you need help from another device, contact your organiser.</div></section></aside><section class="panel"><div class="eyebrow">Current suggestion</div><h2>Crew plan so far</h2><p class="sub">This is a live suggestion, not a final booking. It may change as more preferences arrive.</p><div id="playerPlan"></div></section></div>`;
  setupCheckHandlers();
  if(multiShip){const opts=(m.ships||[]).map((s,i)=>`<option value="${s.id}">${esc(displayShip(s,i))}</option>`).join("");$("#shipPref").innerHTML=`<option value="">No preference</option>${opts}`;}
  $("#playerName").addEventListener("input",debounce(()=>resolveTypedPlayerName(),450));$("#playerForm").onsubmit=submitPlayerChoices;$("#anotherPlayer").onclick=()=>startAnotherPlayer();renderPlayerState();resolveSavedPlayer(true);
}
async function resolveTypedPlayerName(){const raw=$("#playerName")?.value.trim();if(!raw)return;const key=normalizeName(raw),profiles=getLocalProfiles(activeMission.id);if(activePlayerProfile&&normalizeName(activePlayerProfile.name)===key)return;if(profiles[key]){await activatePlayerProfile(profiles[key],true);return;}const remote=missionPlayers.find(p=>normalizeName(p.name)===key);if(remote){activePlayerProfile=null;activePlayerContext=null;renderPlayerIdentity("blocked",raw);setMessage($("#playerMessage"),duplicateNameMessage(raw),"warn");}else renderPlayerIdentity("new",raw);}
function renderPlayerIdentity(mode,name){const el=$("#playerIdentity");if(!el)return;el.className=`registration-banner${mode==="owned"?" owned":mode==="blocked"?" blocked":""}`;el.innerHTML=mode==="owned"?`<b>Editing ${esc(name)}</b><span>This device can update this person's choices.</span>`:mode==="blocked"?`<b>${esc(name)} is already registered</b><span>That name is already registered for this deployment. Use the original device or contact the organiser.</span>`:`<b>${name?esc(name):"New crew member"}</b><span>Enter preferences below.</span>`;}
function populatePlayerForm(p){$("#playerName").value=p.name;$("#playerName").readOnly=true;if($("#shipPref"))$("#shipPref").value=p.shipPref||"";$("#pref1").value=p.prefs?.[0]||"";$("#pref2").value=p.prefs?.[1]||"";$("#pref3").value=p.prefs?.[2]||"";const set=new Set(p.dislikes||[]);$("#dislikes").querySelectorAll("input[type=checkbox]").forEach(x=>x.checked=set.has(x.value));$("#anotherPlayer").classList.remove("hidden");setupCheckHandlers();}
async function submitPlayerChoices(e){e.preventDefault();if(activeMission.closed){setMessage($("#playerMessage"),"Choices are closed for this deployment. Contact the organiser if you need a change.","warn");return;}const payload={name:$("#playerName").value.trim(),shipPref:$("#shipPref")?.value||"",prefs:[$("#pref1").value,$("#pref2").value,$("#pref3").value],dislikes:readChecks($("#dislikes"))};const existingName=missionPlayers.find(p=>normalizeName(p.name)===normalizeName(payload.name));const profiles=getLocalProfiles(activeMission.id),local=profiles[normalizeName(payload.name)];if(existingName&&!local&&existingName.id!==activePlayerProfile?.uid){setMessage($("#playerMessage"),duplicateNameMessage(payload.name),"warn");return;}const err=validatePrefs(payload,missionPlayers,activePlayerProfile?.uid||"");if(err){setMessage($("#playerMessage"),err,"error");return;}try{const {profile,ctx}=await ensurePlayerProfile(payload.name);activePlayerProfile=profile;activePlayerContext=ctx;const ref=doc(ctx.db,"missions",activeMission.id,"players",ctx.user.uid),old=missionPlayers.find(p=>p.id===ctx.user.uid);const base={...payload,updatedAt:serverTimestamp(),source:"player"};if(old){base.createdAt=old.createdAt||serverTimestamp();base.priorityAt=preferenceChanged(old,payload)?serverTimestamp():(old.priorityAt||old.createdAt||serverTimestamp());}else{base.createdAt=serverTimestamp();base.priorityAt=serverTimestamp();}await runTransaction(ctx.db,async tx=>{const claimRef=nameClaimRef(ctx.db,activeMission.id,payload.name),claim=await tx.get(claimRef);if(claim.exists()&&claim.data()?.playerId!==ctx.user.uid)throw new Error(duplicateNameMessage(payload.name));tx.set(claimRef,{playerId:ctx.user.uid,name:payload.name,updatedAt:serverTimestamp()},{merge:true});if(old&&nameClaimId(old.name)!==nameClaimId(payload.name))tx.delete(nameClaimRef(ctx.db,activeMission.id,old.name));tx.set(ref,base,{merge:true});});localStorage.setItem(`bcCrewLast:${activeMission.id}`,normalizeName(payload.name));$("#playerName").readOnly=true;$("#anotherPlayer").classList.remove("hidden");renderPlayerIdentity("owned",payload.name);setMessage($("#playerMessage"),"Your choices are saved.","ok");}catch(ex){setMessage($("#playerMessage"),ex.message||"Couldn't save your choices.","error");}}
function startAnotherPlayer(){activePlayerProfile=null;activePlayerContext=null;localStorage.removeItem(`bcCrewLast:${activeMission.id}`);$("#playerForm").reset();$("#playerName").readOnly=false;if($("#shipPref"))$("#shipPref").value="";$("#dislikes").querySelectorAll("input").forEach(x=>x.checked=false);$("#anotherPlayer").classList.add("hidden");$("#myChoiceSummary").innerHTML="";setMessage($("#playerMessage"),"");renderPlayerIdentity("new","");}
function renderPlayerState(){if(!activeMission||!$("#playerPlan"))return;const plan=computePlan(missionPlayers,activeMission);$("#playerOpenPill").textContent=activeMission.closed?"Choices closed":"Choices open";$("#playerOpenPill").className=`pill ${activeMission.closed?"closed":"open"}`;$("#playerPlan").innerHTML=renderPlan(plan,activeMission,{ownId:activePlayerProfile?.uid||""});const own=missionPlayers.find(p=>p.id===activePlayerProfile?.uid);if(own){const a=plan.assignments.find(x=>x.playerId===own.id);const multiShip=(activeMission.ships||[]).length>1;const prefShipIndex=own.shipPref?(activeMission.ships||[]).findIndex(s=>s.id===own.shipPref):-1;const shipLine=multiShip&&prefShipIndex>=0?`<br><b>Preferred ship:</b> ${esc(displayShip(activeMission.ships[prefShipIndex],prefShipIndex))}`:"";$("#myChoiceSummary").innerHTML=`<div class="message ok"><b>${esc(own.name)}</b>${shipLine}<br>${esc(stationPrefsText(own.prefs||[]))}${a?`<br><b>Current suggestion:</b> ${esc(displayShip(activeMission.ships.find(s=>s.id===a.shipId),activeMission.ships.findIndex(s=>s.id===a.shipId)))} · ${esc(a.role)}`:""}</div>`;}if(activeMission.closed){$("#playerSubmit").disabled=true;setMessage($("#playerMessage"),"Choices are closed. Contact the organiser if you need a change.","warn");}else $("#playerSubmit").disabled=false;}

boot();
