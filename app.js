import { firebaseConfig, ADMIN_UID } from "./firebase-config.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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
function normalizeName(s){return String(s||"").trim().toLocaleLowerCase().replace(/\s+/g," ");}
function randId(prefix="x"){return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;}
function setMessage(el,text,type=""){if(!el)return;el.textContent=text||"";el.className=`message${type?` ${type}`:""}`;}
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
function qScore(q){if(q.kind==="rank"&&q.rank===1)return 0;if(q.kind==="rank"&&q.rank===2)return 100000;if(q.kind==="rank"&&q.rank===3)return 200000;if(q.kind==="flex")return 300000;if(q.kind==="other")return 400000;return 900000000;}
function stableTie(id,ship,role){let h=2166136261;const s=`${id}|${ship}|${role}`;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return((h>>>0)%997)*1e-5;}
function hungarian(a){
  const n=a.length;if(!n)return[];const m=a[0].length;if(n>m)throw new Error("More crew than available stations.");
  const u=Array(n+1).fill(0),v=Array(m+1).fill(0),p=Array(m+1).fill(0),way=Array(m+1).fill(0);
  for(let i=1;i<=n;i++){p[0]=i;let j0=0;const minv=Array(m+1).fill(Infinity),used=Array(m+1).fill(false);do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=m;j++)if(!used[j]){const cur=a[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}for(let j=0;j<=m;j++){if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;}j0=j1;}while(p[j0]!==0);do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!==0);}
  const ans=Array(n).fill(-1);for(let j=1;j<=m;j++)if(p[j])ans[p[j]-1]=j-1;return ans;
}
function getOverride(mission,playerId){return mission?.overrides?.[playerId]||null;}
function concretePrefs(p){return (p.prefs||[]).filter(x=>x&&x!==FLEX);}
function stationAvailabilityCost(person,shipId,demand,mission,targetCount=MAX_PER_SHIP){
  const ov=getOverride(mission,person.id);if(ov?.shipId && ov.shipId!==shipId)return 100000000;
  const shuttleActive=shuttleActiveForCount(targetCount);
  const prefs=ov?.role?[ov.role]:concretePrefs(person);
  let prefCost=3500;
  for(let i=0;i<prefs.length;i++){
    const candidates=ov?.role?[prefs[i]]:rolesForPreference(prefs[i],shuttleActive);
    if(candidates.some(role=>(demand.get(`${shipId}|${role}`)||0)===0)){prefCost=i*1000;break;}
  }
  const shipPenalty=person.shipPref&&person.shipPref!==shipId?120:0;
  return prefCost+shipPenalty;
}
function makeShipTargets(n,ships,fixedCounts,players){
  const prefCount=ships.map(s=>players.filter(p=>p.shipPref===s.id).length);
  const t=ships.map((s,i)=>Math.min(MAX_PER_SHIP,fixedCounts[i]||0));let left=n-t.reduce((a,b)=>a+b,0);
  while(left>0){let best=-1;for(let i=0;i<t.length;i++){if(t[i]>=MAX_PER_SHIP)continue;if(best<0||t[i]<t[best]||(t[i]===t[best]&&prefCount[i]>prefCount[best]))best=i;}if(best<0)break;t[best]++;left--;}
  return t;
}
function allocateShips(players,mission){
  const ships=mission.ships||[];const groups=ships.map(()=>[]),fixedCounts=ships.map(()=>0),unassigned=[];
  const order=[...players].sort(prioritySort);
  for(const p of order){const ov=getOverride(mission,p.id);if(ov?.shipId){const idx=ships.findIndex(s=>s.id===ov.shipId);if(idx>=0&&fixedCounts[idx]<MAX_PER_SHIP){groups[idx].push(p);fixedCounts[idx]++;continue;}}unassigned.push(p);}
  const targets=makeShipTargets(players.length,ships,fixedCounts,players);const demand=new Map();
  function noteDemand(p,shipIndex){
    const ov=getOverride(mission,p.id);
    const raw=ov?.role||concretePrefs(p)[0];
    if(!raw)return;
    const candidates=ov?.role?[raw]:rolesForPreference(raw,shuttleActiveForCount(targets[shipIndex]));
    if(!candidates.length)return;
    const role=[...candidates].sort((a,b)=>(demand.get(`${ships[shipIndex].id}|${a}`)||0)-(demand.get(`${ships[shipIndex].id}|${b}`)||0))[0];
    demand.set(`${ships[shipIndex].id}|${role}`,(demand.get(`${ships[shipIndex].id}|${role}`)||0)+1);
  }
  for(let i=0;i<groups.length;i++)for(const p of groups[i])noteDemand(p,i);
  for(const p of unassigned){
    let choices=[];
    for(let i=0;i<ships.length;i++){
      if(groups[i].length>=targets[i])continue;
      choices.push({i,cost:stationAvailabilityCost(p,ships[i].id,demand,mission,targets[i])});
    }
    if(!choices.length){
      for(let i=0;i<ships.length;i++)if(groups[i].length<MAX_PER_SHIP)choices.push({i,cost:stationAvailabilityCost(p,ships[i].id,demand,mission,Math.max(targets[i],groups[i].length+1))+10000});
    }
    choices.sort((a,b)=>a.cost-b.cost||groups[a.i].length-groups[b.i].length||a.i-b.i);
    const pick=choices[0];if(!pick)continue;
    groups[pick.i].push(p);noteDemand(p,pick.i);
  }
  return groups;
}
function allowedRoleNames(count,forcedRoles=[]){let base=count<=10?[...MAIN10]:[...ROLE_NAMES];for(const role of forcedRoles)if(role&&!base.includes(role))base.push(role);return base;}
function allocateRolesForShip(players,ship,mission){
  const ordered=[...players].sort(prioritySort);const fixedRoles=ordered.map(p=>getOverride(mission,p.id)?.role).filter(Boolean);const allowed=allowedRoleNames(ordered.length,fixedRoles);const slots=allowed.map(name=>({...roleFor(name),shipId:ship.id}));
  if(!ordered.length)return{assignments:[],allowed};
  const shuttleActive=shuttleActiveForCount(ordered.length);
  const orderMap=new Map(ordered.map((p,i)=>[p.id,i]));
  const matrix=ordered.map(p=>slots.map(slot=>{const ov=getOverride(mission,p.id);if(ov?.role&&slot.name!==ov.role)return 1000000000;if(ov?.shipId&&ov.shipId!==ship.id)return 1000000000;const q=quality(p,slot.name,shuttleActive);const shipPenalty=p.shipPref&&p.shipPref!==ship.id?10:0;const firstCome=(orderMap.get(p.id)||0)*0.001;return qScore(q)+shipPenalty+firstCome+stableTie(p.id,ship.id,slot.name);}));
  const chosen=hungarian(matrix);const assignments=ordered.map((p,i)=>{const slot=slots[chosen[i]],q=quality(p,slot.name,shuttleActive);return{playerId:p.id,name:p.name,shipId:ship.id,role:slot.name,team:slot.team,teamName:slot.teamName,quality:q,shipMet:!p.shipPref||p.shipPref===ship.id,forced:Boolean(getOverride(mission,p.id)?.role)};});
  return{assignments,allowed};
}
function computePlan(players,mission){
  const cap=(mission.ships?.length||1)*MAX_PER_SHIP;const ordered=[...players].sort(prioritySort),eligible=ordered.slice(0,cap),overflow=Math.max(0,ordered.length-cap);const groups=allocateShips(eligible,mission);const byShip=[];let all=[];
  (mission.ships||[]).forEach((ship,i)=>{const result=allocateRolesForShip(groups[i]||[],ship,mission);byShip.push({ship,players:groups[i]||[],...result});all=all.concat(result.assignments);});
  const metrics={first:all.filter(a=>a.quality.rank===1).length,second:all.filter(a=>a.quality.rank===2).length,third:all.filter(a=>a.quality.rank===3).length,flex:all.filter(a=>a.quality.kind==="flex").length,avoid:all.filter(a=>a.quality.kind==="avoid").length,shipMet:all.filter(a=>a.shipMet).length};
  return{byShip,assignments:all,overflow,metrics};
}
function roleOptions(selected=""){return `<option value="">Choose…</option><option value="${FLEX}"${selected===FLEX?" selected":""}>${FLEX_LABEL}</option>`+TEAMS.map(t=>`<optgroup label="${esc(t.name)}">${t.roles.map(r=>`<option value="${esc(r)}"${selected===r?" selected":""}>${esc(r)}</option>`).join("")}</optgroup>`).join("");}
function fixedRoleOptions(selected=""){return `<option value="">No fixed assignment</option>`+TEAMS.map(t=>`<optgroup label="${esc(t.name)}">${t.roles.map(r=>`<option value="${esc(r)}"${selected===r?" selected":""}>${esc(r)}</option>`).join("")}</optgroup>`).join("");}
function checkboxes(values=[]){const set=new Set(values);return TEAMS.map(t=>`<div class="check-heading ${t.id}">${t.name}</div>${t.roles.map(r=>`<label class="check"><input type="checkbox" value="${esc(r)}"${set.has(r)?" checked":""}><span>${esc(r)}</span></label>`).join("")}`).join("");}
function readChecks(box){return [...box.querySelectorAll('input[type="checkbox"]:checked')].map(x=>x.value);}
function validatePrefs(p,players=[],ignoreId=""){
  if(!p.name.trim())return "Enter a name.";if(p.prefs.some(x=>!x))return "Choose all three station preferences. Use No preference if you are flexible.";
  const flexAt=p.prefs.indexOf(FLEX);if(flexAt>=0&&p.prefs.slice(flexAt).some(x=>x!==FLEX))return "After No preference, the remaining choices should also be No preference.";
  const concrete=p.prefs.filter(x=>x!==FLEX);if(new Set(concrete).size!==concrete.length)return "Choose different station roles for your ranked choices.";
  const clash=concrete.find(x=>p.dislikes.includes(x));if(clash)return `${clash} cannot be both a preference and a role you really don't want.`;
  if(players.some(x=>x.id!==ignoreId&&normalizeName(x.name)===normalizeName(p.name)))return "That name has already been registered for this deployment.";return "";
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
  const hasInactiveShuttle=plan.byShip.some(group=>group.players.length<11);
  const fallbackNote=hasInactiveShuttle?`<div class="shuttle-fallback-note"><b>Shuttle activates at 11 crew.</b> All main-ship stations, including Dock and drone, remain available. Until shuttle activates, shuttle choices are remembered and count toward equivalent main-ship roles: XO → Captain, Shuttle helm → Helm, Shuttle engineer → Engineering, Shuttle generalist → Beams or Missiles.</div>`:"";
  return `<div class="team-key">${chips}</div>${fallbackNote}<div class="crew-grid">${ships}</div>`;
}
function playerRules(){return `<div class="rules"><div class="rule"><span class="rule-num">1</span><span><b>First come, first served</b> is used only when two people are otherwise tied for the same place.</span></div><div class="rule"><span class="rule-num">2</span><span><b>The crew can move around</b> while people are still adding preferences. Every new response can change the best overall suggestion.</span></div><div class="rule"><span class="rule-num">3</span><span><b>This is a planning aid.</b> The organiser can make the final call and the suggested crew does not have to be followed.</span></div></div>`;}

async function boot(){
  if(!configured){renderNeedsSetup();return;}
  app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
  if(missionParam){await bootPlayer(missionParam);return;}
  if(isSignInWithEmailLink(auth,window.location.href)){
    const savedEmail=localStorage.getItem("bcCrewOrganiserEmail");
    if(savedEmail){
      try{await finishOrganiserEmailLink(savedEmail);}
      catch(ex){renderEmailLinkCompletion(friendlyAuthError(ex));return;}
    }else{renderEmailLinkCompletion();return;}
  }
  onAuthStateChanged(auth,async user=>{
    currentUser=user;
    if(!user){currentRole="";renderAccountLanding();return;}
    currentRole=user.uid===ADMIN_UID?"admin":"organiser";
    renderTopUser();
    try{
      if(currentRole==="admin")await renderAdminDashboard();
      else await ensureOrganiserProfileAndRender();
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
    detail="Your sign-in worked, but Firestore is blocking the dashboard. Publish the firestore.rules file from this project in Firebase → Firestore Database → Rules, then refresh this page.";
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

function renderNeedsSetup(){topActions.innerHTML="";main.innerHTML=`<section class="empty-state"><div class="eyebrow">One-time setup needed</div><h2>The planner code is ready</h2><p>Create the new Firebase project, then put its config into <b>firebase-config.js</b>. The setup guide in the repo walks through it.</p></section>`;}
function renderTopUser(){topActions.innerHTML=`<span class="pill ${currentRole}">${currentRole==="admin"?"Admin":"Organiser"}</span><button id="logoutBtn" class="btn ghost tiny">Sign out</button>`;$("#logoutBtn").onclick=()=>signOut(auth);}
function organiserReturnUrl(){return `${location.origin}${location.pathname}`;}
async function sendOrganiserMagicLink(email){
  const address=String(email||"").trim();
  if(!address)throw new Error("Enter your email address.");
  await sendSignInLinkToEmail(auth,address,{url:organiserReturnUrl(),handleCodeInApp:true});
  localStorage.setItem("bcCrewOrganiserEmail",address);
}
async function finishOrganiserEmailLink(email){
  const cred=await signInWithEmailLink(auth,String(email||"").trim(),window.location.href);
  localStorage.removeItem("bcCrewOrganiserEmail");
  history.replaceState({},document.title,location.pathname);
  return cred;
}
function renderEmailLinkCompletion(errorText=""){
  topActions.innerHTML=`<span class="pill organiser">Organiser sign in</span>`;
  main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Email sign-in</div><h1>Confirm your email</h1><p class="sub">This sign-in link was opened on a different browser or device. Enter the same email address the link was sent to.</p></div></div><section class="panel" style="max-width:620px"><form id="completeEmailLinkForm"><div class="field"><label>Email address</label><input id="completeEmail" type="email" autocomplete="email" required></div><button class="btn primary" type="submit">Finish sign in</button><div id="completeEmailMessage" class="message${errorText?" error":""}">${esc(errorText)}</div></form></section>`;
  $("#completeEmailLinkForm").onsubmit=async e=>{
    e.preventDefault();
    const message=$("#completeEmailMessage");
    setMessage(message,"Confirming your email…");
    try{
      await finishOrganiserEmailLink($("#completeEmail").value);
      setMessage(message,"Signed in. Opening your missions…","ok");
      // On a different device boot() deliberately stopped here so the organiser
      // could confirm their email. Reload once after successful completion so the
      // normal Firebase auth-state listener starts and opens the dashboard.
      window.location.reload();
    }catch(ex){
      setMessage(message,friendlyAuthError(ex),"error");
    }
  };
}
function renderAccountLanding(){
  topActions.innerHTML="";
  main.innerHTML=`<section class="login-hero"><div class="login-intro"><div class="eyebrow">Interstellar Deployment Planner</div><h1>Build the right crew for every deployment</h1><p class="login-lead">Collect ranked crew preferences, balance stations across ships, and keep one live suggested deployment plan as responses change.</p></div><div class="login-layout"><div class="login-column"><section class="panel green organiser-primary"><div class="eyebrow">New or returning organiser</div><h2>Sign in with your email</h2><p class="sub">No password needed. Enter your email and we'll send a secure sign-in link. Your first sign-in automatically creates your organiser account.</p><form id="magicLinkForm"><div class="field"><label>Email address</label><input id="magicEmail" type="email" autocomplete="email" required placeholder="you@example.com"></div><button class="btn success" type="submit">Email me a sign-in link</button><div id="magicMessage" class="message"></div></form></section><section class="player-link-note"><div><b>Joining a crew?</b><span>Use the unique deployment link your organiser sent you. Players do not need an account or password.</span></div></section><details class="admin-access"><summary>Administrator sign in</summary><div class="admin-access-body"><p class="sub">Administrator access only.</p><form id="loginForm"><div class="admin-login-fields"><div class="field"><label>Email</label><input id="loginEmail" type="email" autocomplete="username" required></div><div class="field"><label>Password</label><input id="loginPassword" type="password" autocomplete="current-password" required></div><button class="btn ghost" type="submit">Admin sign in</button></div><div id="loginMessage" class="message"></div></form></div></details></div><aside class="panel feature-panel"><div class="eyebrow">Deployment control</div><h2>What the planner can do</h2><p class="sub feature-intro">Everything an organiser needs to turn a group of preferences into a workable crew plan.</p><div class="feature-list"><div class="feature-item"><span class="feature-index">01</span><div><b>Create deployments</b><span>Set the deployment date and choose the ship in use. Two-ship deployments automatically use Takanami and Havock.</span></div></div><div class="feature-item"><span class="feature-index">02</span><div><b>Send one player link</b><span>Every deployment gets its own unique link. Players open it and submit choices without creating an account.</span></div></div><div class="feature-item"><span class="feature-index">03</span><div><b>Collect real preferences</b><span>Players rank three stations, choose a preferred ship, and flag roles they really do not want.</span></div></div><div class="feature-item"><span class="feature-index">04</span><div><b>Rebalance automatically</b><span>The suggested crew is recalculated whenever preferences change, aiming to satisfy the group as a whole.</span></div></div><div class="feature-item"><span class="feature-index">05</span><div><b>Adapt to crew size</b><span>All stations stay visible. Shuttle stays inactive at 10 crew or fewer and shuttle choices map to useful main-ship equivalents.</span></div></div><div class="feature-item"><span class="feature-index">06</span><div><b>Stay in control</b><span>Add or edit players, close choices, and lock a person to a specific station or ship when the deployment needs it.</span></div></div></div></aside></div></section>`;
  $("#magicLinkForm").onsubmit=async e=>{e.preventDefault();const email=$("#magicEmail").value.trim();setMessage($("#magicMessage"),"Sending your sign-in link…");try{await sendOrganiserMagicLink(email);setMessage($("#magicMessage"),`Sign-in link sent to ${email}. Check your inbox and junk folder.`,"ok");}catch(ex){setMessage($("#magicMessage"),friendlyAuthError(ex),"error");}};
  $("#loginForm").onsubmit=async e=>{
    e.preventDefault();
    setMessage($("#loginMessage"),"Signing in…");
    try{
      const cred=await signInWithEmailAndPassword(auth,$("#loginEmail").value.trim(),$("#loginPassword").value);
      if(cred.user.uid!==ADMIN_UID){
        await signOut(auth);
        setMessage($("#loginMessage"),"That account is not the administrator account for this planner.","error");
        return;
      }
      setMessage($("#loginMessage"),"Signed in. Loading dashboard…","ok");
    }catch(ex){setMessage($("#loginMessage"),friendlyAuthError(ex),"error");}
  };
}
function friendlyAuthError(ex){const code=ex?.code||"";if(code.includes("invalid-credential"))return "That email or password wasn't recognised.";if(code.includes("invalid-email"))return "Check the email address.";if(code.includes("expired-action-code"))return "That sign-in link has expired. Request a new one.";if(code.includes("invalid-action-code"))return "That sign-in link is no longer valid. Request a new one.";if(code.includes("unauthorized-domain"))return "This website domain is not yet authorised in Firebase Authentication.";if(code.includes("operation-not-allowed"))return "Email-link sign in is not enabled in Firebase yet.";return ex?.message||"Something went wrong. Please try again.";}
async function ensureOrganiserProfileAndRender(){const ref=doc(db,"profiles",currentUser.uid),snap=await getDoc(ref);if(!snap.exists())await setDoc(ref,{name:currentUser.email?.split("@")[0]||"Organiser",email:currentUser.email||"",role:"organiser",createdAt:serverTimestamp()});await renderOrganiserDashboard();}
async function renderOrganiserDashboard(){clearUnsubs();const q=query(collection(db,"missions"),where("ownerUid","==",currentUser.uid));const snap=await getDocs(q);const missions=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Organiser dashboard</div><h1>My deployments</h1><p class="sub">Create a deployment, share its player link, then manage the crew as preferences arrive.</p></div><button id="createMissionBtn" class="btn primary">Create deployment</button></div><div id="missionCards" class="grid cards">${missions.length?missions.map(m=>missionCard(m,false)).join(""):`<section class="empty-state"><h2>No deployments yet</h2><p>Create your first deployment to get a player preference link.</p></section>`}</div>`;$("#createMissionBtn").onclick=()=>openMissionSetup();document.querySelectorAll("[data-manage]").forEach(b=>b.onclick=()=>openMissionManager(b.dataset.manage));document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyMissionLink(b.dataset.copy,b));}
function missionCard(m,admin){return `<section class="panel mission-card"><div class="mission-date">${esc(dateText(m.date))}</div><h2>${esc(missionTitle(m))}</h2><p class="sub">${esc(deploymentShipSummary(m))}${Number.isFinite(m.responseCount)?` · ${m.responseCount} response${m.responseCount===1?"":"s"}`:""}</p><div class="mission-meta"><span class="pill ${m.closed?"closed":"open"}">${m.closed?"Choices closed":"Choices open"}</span>${admin?`<span class="pill organiser">${esc(m.ownerName||"Organiser")}</span>`:""}</div><div class="share-box"><input readonly value="${esc(buildMissionLink(m.id))}" aria-label="Player link"><button class="btn ghost tiny" data-copy="${m.id}">Copy link</button></div><div class="actions"><button class="btn primary" data-manage="${m.id}">Manage crew</button>${admin?`<button class="btn danger" data-delete-mission="${m.id}">Delete</button>`:""}</div></section>`;}
function buildMissionLink(id){return `${location.origin}${location.pathname}?m=${encodeURIComponent(id)}`;}
async function copyMissionLink(id,button){const text=buildMissionLink(id);try{await navigator.clipboard.writeText(text);const old=button.textContent;button.textContent="Copied";setTimeout(()=>button.textContent=old,1500);}catch{prompt("Copy this player link:",text);}}
function openMissionSetup(existing=null){
  const initialCount=Math.max(1,Math.min(2,existing?.ships?.length||1));
  const existingSingle=existing?.ships?.[0]?.name;
  let singleShip=["Takanami","Havock","Unknown"].includes(existingSingle)?existingSingle:"Unknown";
  showModal(`<button class="btn ghost tiny modal-close" data-close>Close</button><div class="setup-heading"><div><div class="eyebrow">Deployment setup</div><h2>${existing?"Edit deployment":"Create deployment"}</h2><p class="sub">Set the event details and choose the ship or ships running this deployment.</p></div></div><form id="missionSetupForm" class="deployment-setup-form"><div class="setup-main-fields"><div class="field"><label>Deployment / event name</label><input id="missionName" maxlength="100" value="${esc(existing?.title||"")}" placeholder="e.g. Saturday evening crew"></div><div class="field"><label>Deployment date</label><input id="missionDate" type="date" value="${esc(existing?.date||"")}" required></div></div><div class="setup-section"><div class="setup-section-head"><div><div class="label">How many ships?</div><p class="sub">Choose one ship, or run Takanami and Havock together.</p></div></div><div class="ship-count-choice" role="group" aria-label="Number of ships"><button class="ship-count-card${initialCount===1?" selected":""}" type="button" data-ship-count="1"><b>1</b><span>One ship</span></button><button class="ship-count-card${initialCount===2?" selected":""}" type="button" data-ship-count="2"><b>2</b><span>Takanami + Havock</span></button></div><input id="shipCount" type="hidden" value="${initialCount}"></div><div class="setup-section"><div class="setup-section-head"><div><div class="label">Ships in use</div><p id="shipChoiceHelp" class="sub"></p></div></div><div id="shipVisualPicker" class="ship-visual-picker"></div></div><div class="setup-lock-note"><div class="lock-symbol">◆</div><div><b>Need to guarantee a station?</b><span>After players respond, the organiser can lock anyone to a station, or to an exact ship + station. Locked assignments are treated as hard constraints by the crew planner.</span></div></div><div class="actions setup-actions"><button class="btn primary" type="submit">${existing?"Save deployment":"Create deployment"}</button></div><div id="missionSetupMessage" class="message"></div></form>`);
  const countEl=$("#shipCount");
  const picker=$("#shipVisualPicker");
  const help=$("#shipChoiceHelp");
  function shipTile(name,selected=false,locked=false){const badge=shipBadgeUrl(name);return `<button type="button" class="visual-ship-card ${shipClass({name})}${selected?" selected":""}${locked?" locked":""}" data-ship-choice="${esc(name)}"${locked?" disabled":""}>${badge?`<img src="${esc(badge)}" alt="">`:`<span class="unknown-ship-icon">?</span>`}<span class="visual-ship-name">${esc(name)}</span>${locked?`<small>Included</small>`:""}</button>`;}
  function drawShips(){
    const count=Number(countEl.value)||1;
    document.querySelectorAll("[data-ship-count]").forEach(btn=>btn.classList.toggle("selected",Number(btn.dataset.shipCount)===count));
    if(count===2){
      help.textContent="Two-ship deployments automatically use both ships.";
      picker.innerHTML=shipTile("Takanami",true,true)+shipTile("Havock",true,true);
    }else{
      help.textContent="Tap the ship being used. Choose Unknown if it has not been confirmed yet.";
      picker.innerHTML=["Takanami","Havock","Unknown"].map(name=>shipTile(name,name===singleShip,false)).join("");
      picker.querySelectorAll("[data-ship-choice]").forEach(btn=>btn.onclick=()=>{singleShip=btn.dataset.shipChoice;drawShips();});
    }
  }
  document.querySelectorAll("[data-ship-count]").forEach(btn=>btn.onclick=()=>{countEl.value=btn.dataset.shipCount;if(Number(btn.dataset.shipCount)===1&&existing?.ships?.length===1){const old=existing.ships[0]?.name;if(["Takanami","Havock","Unknown"].includes(old))singleShip=old;}drawShips();});
  drawShips();
  $("#missionSetupForm").onsubmit=async e=>{
    e.preventDefault();
    const n=Number(countEl.value)||1;
    const names=n===2?["Takanami","Havock"]:[singleShip||"Unknown"];
    const ships=names.map((name,i)=>({id:existing?.ships?.[i]?.id||`ship_${i+1}`,name}));
    const payload={title:$("#missionName").value.trim(),date:$("#missionDate").value,shipCount:n,ships,closed:existing?.closed||false,overrides:existing?.overrides||{},updatedAt:serverTimestamp()};
    try{
      if(existing)await updateDoc(doc(db,"missions",existing.id),payload);
      else{Object.assign(payload,{ownerUid:currentUser.uid,ownerName:currentRole==="admin"?"Administrator":(currentUser.email||"Organiser"),createdAt:serverTimestamp()});await addDoc(collection(db,"missions"),payload);}
      closeModal();currentRole==="admin"?renderAdminDashboard():renderOrganiserDashboard();
    }catch(ex){setMessage($("#missionSetupMessage"),ex.message,"error");}
  };
}
function showModal(content){document.body.insertAdjacentHTML("beforeend",`<div id="modalBackdrop" class="modal-backdrop"><div class="modal">${content}</div></div>`);$("#modalBackdrop").addEventListener("click",e=>{if(e.target.id==="modalBackdrop"||e.target.closest("[data-close]"))closeModal();});}
function closeModal(){$("#modalBackdrop")?.remove();}

async function openMissionManager(id){clearUnsubs();const ref=doc(db,"missions",id),snap=await getDoc(ref);if(!snap.exists()){alert("Deployment not found.");return;}const mission={id:snap.id,...snap.data()};if(currentRole!=="admin"&&mission.ownerUid!==currentUser.uid){alert("You don't have access to manage this deployment.");return;}activeMission=mission;renderManagerShell();const playerRef=collection(db,"missions",id,"players");missionUnsubs.push(onSnapshot(ref,s=>{if(!s.exists())return;activeMission={id:s.id,...s.data()};renderManagerState();}));missionUnsubs.push(onSnapshot(playerRef,s=>{missionPlayers=s.docs.map(d=>({id:d.id,...d.data()}));renderManagerState();}));}
function renderManagerShell(){const m=activeMission;main.innerHTML=`<div class="page-head"><div><button id="backDashboard" class="btn ghost tiny">← Dashboard</button><div class="eyebrow" style="margin-top:10px">Crew management</div><h1>${esc(missionTitle(m))}</h1><p class="sub">${esc(dateText(m.date))}</p></div><div class="actions"><button id="editMissionBtn" class="btn ghost">Deployment setup</button><button id="closeChoicesBtn" class="btn ${m.closed?"success":"danger"}">${m.closed?"Reopen choices":"Close choices"}</button></div></div><div class="grid two"><aside><section class="panel sticky"><h2>Player link</h2><p class="sub">Send this link to everyone who should add their preferences.</p><div class="share-box"><input id="managerShareLink" readonly value="${esc(buildMissionLink(m.id))}"><button id="managerCopy" class="btn primary tiny">Copy link</button></div><div class="stat-row" id="managerStats"></div><div class="actions"><button id="addPlayerBtn" class="btn ghost">Add someone</button></div><div id="managerMessage" class="message"></div></section><section class="panel"><h2>Responses</h2><div id="responseList" class="response-list"></div></section></aside><section class="panel"><div class="eyebrow">Live suggestion</div><h2>Current crew plan</h2><p class="sub">The whole suggestion is recalculated whenever a preference changes. Fixed organiser choices are worked around automatically.</p><div id="managerPlan"></div></section></div>`;$("#backDashboard").onclick=()=>{clearUnsubs();currentRole==="admin"?renderAdminDashboard():renderOrganiserDashboard();};$("#editMissionBtn").onclick=()=>openMissionSetup(activeMission);$("#managerCopy").onclick=()=>copyMissionLink(m.id,$("#managerCopy"));$("#closeChoicesBtn").onclick=async()=>{await updateDoc(doc(db,"missions",m.id),{closed:!activeMission.closed,updatedAt:serverTimestamp()});};$("#addPlayerBtn").onclick=()=>openOrganiserPlayerEditor();}
function renderManagerState(){if(!activeMission||!$("#managerPlan"))return;const cap=(activeMission.ships?.length||1)*MAX_PER_SHIP,plan=computePlan(missionPlayers,activeMission);$("#closeChoicesBtn").textContent=activeMission.closed?"Reopen choices":"Close choices";$("#closeChoicesBtn").className=`btn ${activeMission.closed?"success":"danger"}`;$("#managerStats").innerHTML=`<span class="stat"><b>${missionPlayers.length}</b> responses</span><span class="stat"><b>${cap}</b> places</span><span class="stat"><b>${plan.metrics.first}</b> first choices</span>${plan.metrics.avoid?`<span class="stat"><b>${plan.metrics.avoid}</b> last-resort roles</span>`:""}`;$("#managerPlan").innerHTML=renderPlan(plan,activeMission,{organiser:true});$("#responseList").innerHTML=missionPlayers.length?[...missionPlayers].sort(prioritySort).map(p=>responseRow(p)).join(""):`<p class="sub">No responses yet.</p>`;document.querySelectorAll("[data-edit-player]").forEach(b=>b.onclick=()=>openOrganiserPlayerEditor(missionPlayers.find(p=>p.id===b.dataset.editPlayer)));document.querySelectorAll("[data-delete-player]").forEach(b=>b.onclick=()=>deleteOrganiserPlayer(b.dataset.deletePlayer));}
function responseRow(p){const ov=getOverride(activeMission,p.id);const pref=(p.prefs||[]).map(x=>x===FLEX?"No preference":x).join(" → ");const ship=p.shipPref?(activeMission.ships||[]).findIndex(s=>s.id===p.shipPref):-1;return `<div class="response-row"><div class="response-top"><div><div class="response-name">${esc(p.name)}</div><div class="response-meta">${ship>=0?`Ship: ${esc(displayShip(activeMission.ships[ship],ship))}`:"Ship: no preference"}<br>${esc(pref)}</div>${ov?.role?`<div class="fixed-note">Locked: ${esc(ov.role)}${ov.shipId?` · ${esc(displayShip(activeMission.ships.find(s=>s.id===ov.shipId),activeMission.ships.findIndex(s=>s.id===ov.shipId)))}`:" · either ship"}</div>`:""}</div><div class="actions"><button class="btn ghost tiny" data-edit-player="${p.id}">Edit</button><button class="btn danger tiny" data-delete-player="${p.id}">Delete</button></div></div></div>`;}
async function deleteOrganiserPlayer(id){const p=missionPlayers.find(x=>x.id===id);if(!p||!confirm(`Delete ${p.name}'s response?`))return;await deleteDoc(doc(db,"missions",activeMission.id,"players",id));if(activeMission.overrides?.[id]){const overrides={...(activeMission.overrides||{})};delete overrides[id];await updateDoc(doc(db,"missions",activeMission.id),{overrides,updatedAt:serverTimestamp()});}}
function openOrganiserPlayerEditor(player=null){const ov=player?getOverride(activeMission,player.id):null;const shipOptions=(activeMission.ships||[]).map((s,i)=>`<option value="${s.id}"${player?.shipPref===s.id?" selected":""}>${esc(displayShip(s,i))}</option>`).join("");const fixedShipOptions=(activeMission.ships||[]).map((s,i)=>`<option value="${s.id}"${ov?.shipId===s.id?" selected":""}>${esc(displayShip(s,i))}</option>`).join("");showModal(`<button class="btn ghost tiny modal-close" data-close>Close</button><div class="eyebrow">Organiser entry</div><h2>${player?`Edit ${esc(player.name)}`:"Add someone"}</h2><form id="orgPlayerForm"><div class="field"><label>Name</label><input id="orgName" value="${esc(player?.name||"")}" maxlength="60" required></div><div class="field"><label>Preferred ship</label><select id="orgShip"><option value="">No preference</option>${shipOptions}</select></div><div class="three-fields"><div class="field"><label>1st station</label><select id="orgPref1">${roleOptions(player?.prefs?.[0]||"")}</select></div><div class="field"><label>2nd station</label><select id="orgPref2">${roleOptions(player?.prefs?.[1]||"")}</select></div><div class="field"><label>3rd station</label><select id="orgPref3">${roleOptions(player?.prefs?.[2]||"")}</select></div></div><div class="label">Really don't want</div><div id="orgDislikes" class="checks">${checkboxes(player?.dislikes||[])}</div><hr style="border:0;border-top:1px solid var(--line);margin:15px 0"><div class="eyebrow">Optional locked assignment</div><div class="field"><label>Locked station</label><select id="orgFixedRole">${fixedRoleOptions(ov?.role||"")}</select><small>Leave this as No fixed assignment to let the planner decide normally. A locked station is a hard constraint.</small></div><div class="field"><label>Locked ship</label><select id="orgFixedShip"><option value="">Either ship</option>${fixedShipOptions}</select></div><div class="actions"><button class="btn primary" type="submit">Save</button></div><div id="orgPlayerMessage" class="message"></div></form>`);setupCheckHandlers("org");$("#orgPlayerForm").onsubmit=async e=>{e.preventDefault();const id=player?.id||randId("org");const payload={name:$("#orgName").value.trim(),shipPref:$("#orgShip").value,prefs:[$("#orgPref1").value,$("#orgPref2").value,$("#orgPref3").value],dislikes:readChecks($("#orgDislikes"))};const error=validatePrefs(payload,missionPlayers,player?.id||"");if(error){setMessage($("#orgPlayerMessage"),error,"error");return;}const fixedRole=$("#orgFixedRole").value,fixedShip=$("#orgFixedShip").value;if(fixedShip&&!fixedRole){setMessage($("#orgPlayerMessage"),"Choose a locked station before choosing a locked ship.","error");return;}if(fixedRole&&fixedShip){const clash=Object.entries(activeMission.overrides||{}).find(([pid,x])=>pid!==id&&x.role===fixedRole&&x.shipId===fixedShip);if(clash){setMessage($("#orgPlayerMessage"),"That exact ship + station is already locked to someone else.","error");return;}}
    if(fixedRole){const sameRole=Object.entries(activeMission.overrides||{}).filter(([pid,x])=>pid!==id&&x.role===fixedRole).length;if(sameRole>=(activeMission.ships?.length||1)){setMessage($("#orgPlayerMessage"),`There are only ${activeMission.ships?.length||1} copies of ${fixedRole} across this deployment. Remove another locked ${fixedRole} assignment first.`,"error");return;}}
    try{const ref=doc(db,"missions",activeMission.id,"players",id);if(player)await setDoc(ref,{...payload,updatedAt:serverTimestamp(),priorityAt:preferenceChanged(player,payload)?serverTimestamp():(player.priorityAt||player.createdAt||serverTimestamp()),createdAt:player.createdAt||serverTimestamp()},{merge:true});else await setDoc(ref,{...payload,source:"organiser",createdAt:serverTimestamp(),priorityAt:serverTimestamp(),updatedAt:serverTimestamp()});const overrides={...(activeMission.overrides||{})};if(fixedRole)overrides[id]={role:fixedRole,shipId:fixedShip||""};else delete overrides[id];await updateDoc(doc(db,"missions",activeMission.id),{overrides,updatedAt:serverTimestamp()});closeModal();}catch(ex){setMessage($("#orgPlayerMessage"),ex.message,"error");}};}
function preferenceChanged(old,p){return old.shipPref!==p.shipPref||JSON.stringify(old.prefs||[])!==JSON.stringify(p.prefs)||JSON.stringify([...(old.dislikes||[])].sort())!==JSON.stringify([...p.dislikes].sort());}

async function renderAdminDashboard(){
  clearUnsubs();

  const [missionSnap,profileSnap]=await Promise.all([
    getDocs(collection(db,"missions")),
    getDocs(collection(db,"profiles"))
  ]);

  const profiles=profileSnap.docs
    .map(d=>({id:d.id,...d.data()}))
    .filter(p=>p.role==="organiser")
    .sort((a,b)=>String(a.email||a.name||"").localeCompare(String(b.email||b.name||"")));

  let missions=missionSnap.docs.map(d=>({id:d.id,...d.data()}));

  // Admin use is low-volume, so fetching response counts here keeps the
  // dashboard immediately useful without changing the stored deployment shape.
  const responseCounts=await Promise.all(
    missions.map(async m=>{
      try{
        const ps=await getDocs(collection(db,"missions",m.id,"players"));
        return [m.id,ps.size];
      }catch{
        return [m.id,null];
      }
    })
  );
  const countMap=new Map(responseCounts);

  const profileMap=new Map(profiles.map(p=>[p.id,p]));
  missions=missions.map(m=>({
    ...m,
    ownerName:profileMap.get(m.ownerUid)?.name||m.ownerName||"Organiser",
    ownerEmail:profileMap.get(m.ownerUid)?.email||"",
    responseCount:countMap.get(m.id)
  })).sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));

  const organiserCards=profiles.length
    ?profiles.map(p=>{
      const owned=missions.filter(m=>m.ownerUid===p.id);
      const label=p.name||p.email||"Organiser";
      const deployments=owned.length
        ?owned.map(m=>`
          <div class="admin-organiser-deployment">
            <div class="admin-organiser-deployment-main">
              <div>
                <b>${esc(missionTitle(m))}</b>
                <span>${esc(dateText(m.date))} · ${esc(deploymentShipSummary(m))}</span>
              </div>
              <div class="mission-meta">
                <span class="pill ${m.closed?"closed":"open"}">${m.closed?"Closed":"Open"}</span>
                <span class="pill">${m.responseCount??"?"} response${m.responseCount===1?"":"s"}</span>
              </div>
            </div>
            <div class="actions">
              <button class="btn primary tiny" data-manage="${m.id}">Manage</button>
              <button class="btn ghost tiny" data-copy="${m.id}">Copy player link</button>
            </div>
          </div>`).join("")
        :`<p class="sub">No deployments created yet.</p>`;

      return `
        <details class="panel admin-organiser-card">
          <summary>
            <div>
              <div class="eyebrow">Organiser</div>
              <h2>${esc(label)}</h2>
              <div class="admin-organiser-email">${esc(p.email||"No email stored")}</div>
            </div>
            <div class="admin-organiser-summary-meta">
              <span class="stat"><b>${owned.length}</b> deployment${owned.length===1?"":"s"}</span>
              <span class="admin-view-hint">View deployments</span>
            </div>
          </summary>
          <div class="admin-organiser-details">
            <div class="admin-organiser-uid"><span>UID</span><code>${esc(p.id)}</code></div>
            <div class="admin-organiser-deployments">${deployments}</div>
          </div>
        </details>`;
    }).join("")
    :`<section class="empty-state"><h2>No organisers yet</h2><p>Organisers will appear here after they first sign in with a magic link.</p></section>`;

  main.innerHTML=`
    <div class="page-head">
      <div>
        <div class="eyebrow">Administrator</div>
        <h1>Control centre</h1>
        <p class="sub">See organiser accounts, their deployments, and every deployment across the planner.</p>
      </div>
      <button id="adminCreateMissionBtn" class="btn primary">Create deployment</button>
    </div>

    <div class="stat-row">
      <span class="stat"><b>${profiles.length}</b> organisers</span>
      <span class="stat"><b>${missions.length}</b> deployments</span>
      <span class="stat"><b>${missions.reduce((n,m)=>n+(Number.isFinite(m.responseCount)?m.responseCount:0),0)}</b> total responses</span>
    </div>

    <section class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="eyebrow">Accounts</div>
          <h2>Organisers</h2>
          <p class="sub">Open an organiser to see the deployments attached to their account.</p>
        </div>
      </div>
      <div class="admin-organiser-list">${organiserCards}</div>
    </section>

    <section class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="eyebrow">Global view</div>
          <h2>All deployments</h2>
          <p class="sub">Every deployment, including ones created by the administrator.</p>
        </div>
      </div>
      <div class="grid cards">
        ${missions.length?missions.map(m=>missionCard(m,true)).join(""):`<section class="empty-state"><h2>No deployments yet</h2><p>Create a deployment yourself or wait for an organiser to create one.</p></section>`}
      </div>
    </section>`;

  $("#adminCreateMissionBtn").onclick=()=>openMissionSetup();

  document.querySelectorAll("[data-manage]").forEach(b=>{
    b.onclick=()=>openMissionManager(b.dataset.manage);
  });
  document.querySelectorAll("[data-copy]").forEach(b=>{
    b.onclick=()=>copyMissionLink(b.dataset.copy,b);
  });
  document.querySelectorAll("[data-delete-mission]").forEach(b=>{
    b.onclick=async()=>{
      if(confirm("Delete this deployment and all player responses?")){
        await deleteMissionCascade(b.dataset.deleteMission);
      }
    };
  });
}
async function deleteMissionCascade(id){const ps=await getDocs(collection(db,"missions",id,"players"));const batch=writeBatch(db);ps.docs.forEach(d=>batch.delete(d.ref));batch.delete(doc(db,"missions",id));await batch.commit();renderAdminDashboard();}

function localProfilesKey(missionId){return `bcCrewProfiles:${missionId}`;}
function getLocalProfiles(missionId){try{return JSON.parse(localStorage.getItem(localProfilesKey(missionId))||"{}")||{};}catch{return{};}}
function saveLocalProfiles(missionId,map){localStorage.setItem(localProfilesKey(missionId),JSON.stringify(map));}
async function namedAnonymousContext(appName){let named=getApps().find(a=>a.name===appName);if(!named)named=initializeApp(firebaseConfig,appName);const a=getAuth(named),d=getFirestore(named);let user=a.currentUser;if(!user){const cred=await signInAnonymously(a);user=cred.user;}return{app:named,auth:a,db:d,user};}
async function bootPlayer(missionId){
  try{viewerContext=await namedAnonymousContext(`viewer_${missionId.replace(/[^a-z0-9]/gi,"_")}`);const mSnap=await getDoc(doc(viewerContext.db,"missions",missionId));if(!mSnap.exists()){renderPlayerError("That deployment link doesn't exist.");return;}activeMission={id:mSnap.id,...mSnap.data()};renderPlayerShell();missionUnsubs.push(onSnapshot(doc(viewerContext.db,"missions",missionId),s=>{if(!s.exists())return;activeMission={id:s.id,...s.data()};renderPlayerState();}));missionUnsubs.push(onSnapshot(collection(viewerContext.db,"missions",missionId,"players"),s=>{missionPlayers=s.docs.map(d=>({id:d.id,...d.data()}));renderPlayerState();resolveSavedPlayer(false);}));
  }catch(ex){renderPlayerError(ex.message||"Could not open this deployment.");}
}
function renderPlayerError(text){topActions.innerHTML="";main.innerHTML=`<section class="empty-state"><h2>Couldn't open the deployment</h2><p>${esc(text)}</p></section>`;}
function renderPlayerShell(){const m=activeMission;topActions.innerHTML=`<span class="pill ${m.closed?"closed":"open"}" id="playerOpenPill">${m.closed?"Choices closed":"Choices open"}</span>`;main.innerHTML=`<div class="page-head"><div><div class="eyebrow">Player crew choices</div><h1>${esc(missionTitle(m))}</h1><p class="sub">${esc(dateText(m.date))}</p></div></div><div class="grid two"><aside><section class="panel"><h2>Your choices</h2><p class="sub">Tell the organiser what you'd most like to do. The crew suggestion can move around as more people reply.</p>${playerRules()}<div id="playerIdentity" class="registration-banner"><b>New crew member</b><span>Enter your name below.</span></div><div id="myChoiceSummary"></div><form id="playerForm"><div class="field"><label>Who is being registered?</label><input id="playerName" maxlength="60" autocomplete="off" required placeholder="Your name"></div><div class="field"><label>Preferred ship</label><select id="shipPref"></select></div><div class="three-fields"><div class="field"><label>1st station</label><select id="pref1">${roleOptions()}</select></div><div class="field"><label>2nd station</label><select id="pref2">${roleOptions()}</select></div><div class="field"><label>3rd station</label><select id="pref3">${roleOptions()}</select></div></div><div class="label">Really don't want</div><div id="dislikes" class="checks">${checkboxes()}</div><div class="actions"><button id="playerSubmit" class="btn primary" type="submit">Save my choices</button><button id="anotherPlayer" class="btn ghost hidden" type="button">Register someone else</button></div><div id="playerMessage" class="message"></div></form><div class="message warn">You can edit your choices later only from the same device and browser you used to register. If you need help from another device, contact your organiser.</div></section></aside><section class="panel"><div class="eyebrow">Current suggestion</div><h2>Crew plan so far</h2><p class="sub">This is a live suggestion, not a final booking. It may change as more preferences arrive.</p><div id="playerPlan"></div></section></div>`;setupCheckHandlers();const opts=(m.ships||[]).map((s,i)=>`<option value="${s.id}">${esc(displayShip(s,i))}</option>`).join("");$("#shipPref").innerHTML=`<option value="">No preference</option>${opts}`;$("#playerName").addEventListener("input",debounce(()=>resolveTypedPlayerName(),450));$("#playerForm").onsubmit=submitPlayerChoices;$("#anotherPlayer").onclick=()=>startAnotherPlayer();renderPlayerState();resolveSavedPlayer(true);}
function debounce(fn,ms){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),ms);};}
async function resolveSavedPlayer(loadForm){const profiles=getLocalProfiles(activeMission.id),last=localStorage.getItem(`bcCrewLast:${activeMission.id}`);if(activePlayerProfile)return;if(last&&profiles[last])await activatePlayerProfile(profiles[last],loadForm);}
async function ensurePlayerProfile(name){const key=normalizeName(name),profiles=getLocalProfiles(activeMission.id);let profile=profiles[key];if(profile){const ctx=await namedAnonymousContext(profile.appName);profile.uid=ctx.user.uid;profiles[key]=profile;saveLocalProfiles(activeMission.id,profiles);return{profile,ctx};}const appName=`player_${activeMission.id.slice(0,8)}_${Math.random().toString(36).slice(2,10)}`;const ctx=await namedAnonymousContext(appName);profile={name,appName,uid:ctx.user.uid};profiles[key]=profile;saveLocalProfiles(activeMission.id,profiles);return{profile,ctx};}
async function activatePlayerProfile(profile,loadForm=true){const ctx=await namedAnonymousContext(profile.appName);activePlayerProfile={...profile,uid:ctx.user.uid};activePlayerContext=ctx;localStorage.setItem(`bcCrewLast:${activeMission.id}`,normalizeName(profile.name));const entry=missionPlayers.find(p=>p.id===ctx.user.uid);if(entry&&loadForm)populatePlayerForm(entry);renderPlayerIdentity(entry?"owned":"new",profile.name);renderPlayerState();}
async function resolveTypedPlayerName(){const raw=$("#playerName")?.value.trim();if(!raw)return;const key=normalizeName(raw),profiles=getLocalProfiles(activeMission.id);if(activePlayerProfile&&normalizeName(activePlayerProfile.name)===key)return;if(profiles[key]){await activatePlayerProfile(profiles[key],true);return;}const remote=missionPlayers.find(p=>normalizeName(p.name)===key);if(remote){activePlayerProfile=null;activePlayerContext=null;renderPlayerIdentity("blocked",raw);setMessage($("#playerMessage"),"That name is already registered on another device. Contact the organiser if it needs changing.","warn");}else renderPlayerIdentity("new",raw);}
function renderPlayerIdentity(mode,name){const el=$("#playerIdentity");if(!el)return;el.className=`registration-banner${mode==="owned"?" owned":mode==="blocked"?" blocked":""}`;el.innerHTML=mode==="owned"?`<b>Editing ${esc(name)}</b><span>This device can update this person's choices.</span>`:mode==="blocked"?`<b>${esc(name)} is already registered</b><span>Use the original device or contact the organiser.</span>`:`<b>${name?esc(name):"New crew member"}</b><span>Enter preferences below.</span>`;}
function populatePlayerForm(p){$("#playerName").value=p.name;$("#playerName").readOnly=true;$("#shipPref").value=p.shipPref||"";$("#pref1").value=p.prefs?.[0]||"";$("#pref2").value=p.prefs?.[1]||"";$("#pref3").value=p.prefs?.[2]||"";const set=new Set(p.dislikes||[]);$("#dislikes").querySelectorAll("input[type=checkbox]").forEach(x=>x.checked=set.has(x.value));$("#anotherPlayer").classList.remove("hidden");setupCheckHandlers();}
async function submitPlayerChoices(e){e.preventDefault();if(activeMission.closed){setMessage($("#playerMessage"),"Choices are closed for this deployment. Contact the organiser if you need a change.","warn");return;}const payload={name:$("#playerName").value.trim(),shipPref:$("#shipPref").value,prefs:[$("#pref1").value,$("#pref2").value,$("#pref3").value],dislikes:readChecks($("#dislikes"))};const existingName=missionPlayers.find(p=>normalizeName(p.name)===normalizeName(payload.name));const profiles=getLocalProfiles(activeMission.id),local=profiles[normalizeName(payload.name)];if(existingName&&!local&&existingName.id!==activePlayerProfile?.uid){setMessage($("#playerMessage"),"That name is already registered on another device. Contact the organiser if it needs changing.","warn");return;}const err=validatePrefs(payload,missionPlayers,activePlayerProfile?.uid||"");if(err){setMessage($("#playerMessage"),err,"error");return;}try{const {profile,ctx}=await ensurePlayerProfile(payload.name);activePlayerProfile=profile;activePlayerContext=ctx;const ref=doc(ctx.db,"missions",activeMission.id,"players",ctx.user.uid),old=missionPlayers.find(p=>p.id===ctx.user.uid);const base={...payload,updatedAt:serverTimestamp(),source:"player"};if(old){base.createdAt=old.createdAt||serverTimestamp();base.priorityAt=preferenceChanged(old,payload)?serverTimestamp():(old.priorityAt||old.createdAt||serverTimestamp());}else{base.createdAt=serverTimestamp();base.priorityAt=serverTimestamp();}await setDoc(ref,base,{merge:true});localStorage.setItem(`bcCrewLast:${activeMission.id}`,normalizeName(payload.name));$("#playerName").readOnly=true;$("#anotherPlayer").classList.remove("hidden");renderPlayerIdentity("owned",payload.name);setMessage($("#playerMessage"),"Your choices are saved.","ok");}catch(ex){setMessage($("#playerMessage"),ex.message||"Couldn't save your choices.","error");}}
function startAnotherPlayer(){activePlayerProfile=null;activePlayerContext=null;localStorage.removeItem(`bcCrewLast:${activeMission.id}`);$("#playerForm").reset();$("#playerName").readOnly=false;$("#shipPref").value="";$("#dislikes").querySelectorAll("input").forEach(x=>x.checked=false);$("#anotherPlayer").classList.add("hidden");$("#myChoiceSummary").innerHTML="";setMessage($("#playerMessage"),"");renderPlayerIdentity("new","");}
function renderPlayerState(){if(!activeMission||!$("#playerPlan"))return;const plan=computePlan(missionPlayers,activeMission);$("#playerOpenPill").textContent=activeMission.closed?"Choices closed":"Choices open";$("#playerOpenPill").className=`pill ${activeMission.closed?"closed":"open"}`;$("#playerPlan").innerHTML=renderPlan(plan,activeMission,{ownId:activePlayerProfile?.uid||""});const own=missionPlayers.find(p=>p.id===activePlayerProfile?.uid);if(own){const a=plan.assignments.find(x=>x.playerId===own.id);$("#myChoiceSummary").innerHTML=`<div class="message ok"><b>${esc(own.name)}</b><br>${own.prefs.map(x=>x===FLEX?"No preference":esc(x)).join(" → ")}${a?`<br><b>Current suggestion:</b> ${esc(displayShip(activeMission.ships.find(s=>s.id===a.shipId),activeMission.ships.findIndex(s=>s.id===a.shipId)))} · ${esc(a.role)}`:""}</div>`;}if(activeMission.closed){$("#playerSubmit").disabled=true;setMessage($("#playerMessage"),"Choices are closed. Contact the organiser if you need a change.","warn");}else $("#playerSubmit").disabled=false;}

boot();
