// The public marketing and download page served at the backend root. It is a
// single self-contained HTML page: brand, a short pitch, a Download for Windows
// button, a Help section (support and billing), and working Create account /
// Sign in forms that post to the existing auth endpoints. The auth modal closes
// itself after a successful sign in or sign up. No provider or vendor names
// appear anywhere.

import { SUPPORT_EMAIL } from "@workcrew/contracts";

// The WorkCrew app icon as inline vector: just the purple quatrefoil mark
// (no background), so it's clean and matches the brand everywhere. Ids are
// suffixed so multiple marks could coexist on the same page.
// Matches apps/desktop/resources/icon.svg exactly: the dark rounded tile with the
// bold cropped quatrefoil, so the website header and favicon look identical to
// the app icon and the taskbar icon.
function brandMark(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex:0 0 auto">
<defs>
<linearGradient id="bmTile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#221F2E"/><stop offset="1" stop-color="#17151E"/></linearGradient>
<linearGradient id="bmMark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>
<mask id="bmPlus"><rect width="100" height="100" fill="white"/><rect x="41" y="29" width="18" height="42" rx="9" fill="black"/><rect x="29" y="41" width="42" height="18" rx="9" fill="black"/></mask>
</defs>
<rect x="0" y="0" width="512" height="512" rx="116" fill="url(#bmTile)"/>
<g transform="translate(256 256) scale(4.6) translate(-50 -50)">
<g mask="url(#bmPlus)" fill="url(#bmMark)"><circle cx="50" cy="28" r="22"/><circle cx="50" cy="72" r="22"/><circle cx="28" cy="50" r="22"/><circle cx="72" cy="50" r="22"/><rect x="28" y="28" width="44" height="44" rx="14"/></g>
</g>
</svg>`;
}

// The bare quatrefoil mark with no dark tile, exactly matching the in-app logo
// (apps/desktop .../App.tsx LogoMark). Used in the page header so the website
// brand looks identical to the app brand; the tiled brandMark above stays for
// the favicon and touch icon, where a tile reads better.
function brandGlyph(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex:0 0 auto">
<defs>
<linearGradient id="bmgMark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>
<mask id="bmgPlus"><rect width="100" height="100" fill="white"/><rect x="41" y="29" width="18" height="42" rx="9" fill="black"/><rect x="29" y="41" width="42" height="18" rx="9" fill="black"/></mask>
</defs>
<g mask="url(#bmgPlus)" fill="url(#bmgMark)"><circle cx="50" cy="28" r="22"/><circle cx="50" cy="72" r="22"/><circle cx="28" cy="50" r="22"/><circle cx="72" cy="50" r="22"/><rect x="28" y="28" width="44" height="44" rx="14"/></g>
</svg>`;
}

export function landingPage(downloadUrl: string): string {
  const download = downloadUrl && downloadUrl.length > 0 ? downloadUrl : "";
  // The download URL is operator-configured, but escape it for the HTML attribute
  // context anyway so a stray quote or angle bracket can never break out of the
  // href and inject markup. Defense in depth on an admin-controlled value.
  const escapeAttr = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const downloadAttr = download ? `href="${escapeAttr(download)}"` : `href="#" data-missing="1"`;
  const mailHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("WorkCrew support")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkCrew: Put routine work on autopilot</title>
<meta name="description" content="WorkCrew is a secure Windows app that does real tasks in your browser and your apps, with your permission, every step of the way.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(brandMark(512))}">
<link rel="apple-touch-icon" href="data:image/svg+xml,${encodeURIComponent(brandMark(512))}">
<style>
:root{
  --bg:#1b1a19;--bg2:#211f1e;--panel:#262523;--panel2:#2d2b29;--line:#393634;--line2:#46423f;
  --text:#f1efec;--muted:#a8a39d;--muted2:#8c8782;--accent:#8b5cf6;--accent2:#a78bfa;--ok:#5cc18d;--err:#e08a92;
  --shadow:0 24px 60px -20px rgba(0,0,0,.6);--radius:16px
}
*{box-sizing:border-box}html{scroll-behavior:smooth}html,body{margin:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',-apple-system,system-ui,Arial,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 22px}
/* ambient glow behind the hero */
.glow{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.glow:before,.glow:after{content:"";position:absolute;width:620px;height:620px;border-radius:50%;filter:blur(120px);opacity:.20}
.glow:before{background:#7c3aed;top:-220px;left:50%;transform:translateX(-60%)}
.glow:after{background:#5b21b6;top:60px;right:-160px;opacity:.14}
/* header */
header{position:sticky;top:0;z-index:30;backdrop-filter:saturate(140%) blur(10px);background:rgba(27,26,25,.72);border-bottom:1px solid transparent;transition:border-color .2s}
header.scrolled{border-bottom:1px solid var(--line)}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:14px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:.2px}
nav{display:flex;align-items:center;gap:6px}
.navlink{background:none;border:0;color:var(--muted);padding:9px 12px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;text-decoration:none}
.navlink:hover{color:var(--text);background:var(--panel)}
.navbtn{background:none;border:1px solid var(--line2);color:var(--text);padding:9px 16px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;margin-left:4px}
.navbtn:hover{border-color:var(--accent)}
.navbtn.solid{background:var(--accent);border-color:var(--accent);color:#fff}
.navbtn.solid:hover{background:var(--accent2);border-color:var(--accent2)}
/* hero */
.hero{text-align:center;padding:78px 0 26px}
.eyebrow{display:inline-block;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--accent2);font-weight:700;border:1px solid var(--line2);background:var(--panel);padding:6px 12px;border-radius:999px;margin-bottom:22px}
.hero h1{font-size:clamp(34px,6vw,52px);line-height:1.08;margin:0 0 18px;font-weight:800;letter-spacing:-.5px;background:linear-gradient(180deg,#fff, #d6cff0);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p.lead{font-size:19px;color:var(--muted);max-width:640px;margin:0 auto 30px}
.cta{display:inline-flex;gap:12px;flex-wrap:wrap;justify-content:center}
.btn{border:0;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:9px;padding:14px 24px;transition:transform .06s ease,background .2s,border-color .2s}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--accent);color:#fff;box-shadow:0 10px 24px -10px rgba(139,92,246,.8)}
.btn.primary:hover{background:var(--accent2)}
.btn.ghost{background:var(--panel);color:var(--text);border:1px solid var(--line2)}
.btn.ghost:hover{border-color:var(--accent)}
.note{color:var(--muted2);font-size:13px;margin-top:14px;min-height:18px}
/* app window mock */
.mock{margin:46px auto 0;max-width:880px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,var(--bg2),#1c1b1a);box-shadow:var(--shadow);overflow:hidden}
.mock .bar{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.dot{width:11px;height:11px;border-radius:50%;background:#403d3a}
.mock .body{display:grid;grid-template-columns:180px 1fr;min-height:230px}
.mock .side{border-right:1px solid var(--line);padding:16px 14px;background:rgba(255,255,255,.012)}
.mock .pill{height:30px;border-radius:9px;background:var(--panel2);margin-bottom:10px}
.mock .pill.accent{background:linear-gradient(90deg,rgba(139,92,246,.5),rgba(139,92,246,.18));width:100%}
.mock .pane{padding:26px 26px;display:flex;flex-direction:column;gap:14px}
.mock .line{height:13px;border-radius:7px;background:var(--panel2)}
.mock .bubble{align-self:flex-end;max-width:62%;background:linear-gradient(90deg,#7c3aed,#8b5cf6);height:40px;border-radius:14px 14px 4px 14px}
.mock .compose{margin-top:auto;height:46px;border:1px solid var(--line2);border-radius:12px;background:var(--bg)}
/* sections */
.section{padding:62px 0 8px}
.section h2{font-size:28px;margin:0 0 8px;font-weight:800;letter-spacing:-.3px}
.section .sub{color:var(--muted);margin:0 0 26px;font-size:15px;max-width:620px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;transition:transform .12s ease,border-color .2s}
.card:hover{transform:translateY(-3px);border-color:var(--line2)}
.card .ic{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:rgba(139,92,246,.14);color:var(--accent2);margin-bottom:13px}
.card h3{margin:0 0 6px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:14px}
/* steps */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;counter-reset:step}
.step{position:relative;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--bg2)}
.step:before{counter-increment:step;content:counter(step);display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-weight:800;font-size:14px;margin-bottom:12px}
.step h3{margin:0 0 5px;font-size:16px}.step p{margin:0;color:var(--muted);font-size:14px}
/* help */
.help-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.help-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
.help-card h3{margin:0 0 6px;font-size:17px}
.help-card p{margin:0 0 16px;color:var(--muted);font-size:14px}
.help-card .addr{color:var(--accent2);font-weight:600}
footer{border-top:1px solid var(--line);margin-top:64px;padding:30px 0;color:var(--muted2);font-size:13px}
.frow{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.flinks{display:flex;gap:18px}.flinks a,.flinks button{color:var(--muted);text-decoration:none;background:none;border:0;cursor:pointer;font-size:13px}
.flinks a:hover,.flinks button:hover{color:var(--text)}
/* modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;place-items:center;padding:18px;z-index:50;animation:fade .15s ease}
.modal.open{display:grid}
@keyframes fade{from{opacity:0}to{opacity:1}}
.sheet{width:min(412px,94vw);background:var(--panel);border:1px solid var(--line2);border-radius:18px;padding:26px;box-shadow:var(--shadow);position:relative;animation:pop .16s ease}
@keyframes pop{from{transform:translateY(8px) scale(.98);opacity:.6}to{transform:none;opacity:1}}
.sheet .glyph{display:flex;justify-content:center;margin-bottom:12px}
.sheet h2{margin:0 0 4px;font-size:21px;text-align:center}
.sheet p.sub{margin:0 0 16px;color:var(--muted);font-size:14px;text-align:center}
.field{margin:9px 0}
.sheet input{width:100%;padding:12px 14px;border:1px solid var(--line2);border-radius:11px;background:var(--bg);color:var(--text);font-size:14px}
.sheet input:focus{outline:none;border-color:var(--accent)}
.pwrap{position:relative}
.peye{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;padding:6px 8px;border-radius:8px}
.peye:hover{color:var(--text);background:var(--panel2)}
.sheet .go{width:100%;margin-top:10px;justify-content:center}
.msg{font-size:13px;margin-top:12px;min-height:18px;text-align:center}.ok{color:var(--ok)}.err{color:var(--err)}
.trow{margin-top:14px;text-align:center}
.link{background:none;border:0;color:var(--accent2);cursor:pointer;font-size:13px;font-weight:600}
.link:hover{text-decoration:underline}
.x{position:absolute;right:14px;top:12px;background:none;border:0;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.x:hover{color:var(--text)}
/* toast */
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:var(--panel2);border:1px solid var(--line2);color:var(--text);padding:12px 18px;border-radius:12px;font-size:14px;box-shadow:var(--shadow);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:60;max-width:90vw}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.err{border-color:var(--err);color:var(--err)}
@media(max-width:640px){.mock .body{grid-template-columns:1fr}.mock .side{display:none}.hero{padding:54px 0 18px}}
</style></head><body>
<div class="glow"></div>
<header id="hdr"><div class="wrap hrow">
  <div class="brand">${brandGlyph(28)} WorkCrew</div>
  <nav>
    <a class="navlink" href="#features">Features</a>
    <a class="navlink" href="#help">Help</a>
    <button class="navbtn" onclick="openAuth('signin')">Sign in</button>
    <button class="navbtn solid" onclick="openAuth('signup')">Sign up</button>
  </nav>
</div></header>

<div class="wrap">
  <section class="hero">
    <span class="eyebrow">Secure Windows automation</span>
    <h1>Put routine work on autopilot</h1>
    <p class="lead">WorkCrew is a secure Windows app that does real tasks in your browser and your apps, with your permission, every step of the way.</p>
    <div class="cta">
      <a class="btn primary" id="dl" ${downloadAttr}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>
        Download for Windows
      </a>
      <button class="btn ghost" onclick="openAuth('signup')">Create an account</button>
    </div>
    <p class="note" id="dlnote"></p>

    <div class="mock" aria-hidden="true">
      <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      <div class="body">
        <div class="side"><div class="pill accent"></div><div class="pill"></div><div class="pill"></div><div class="pill"></div></div>
        <div class="pane">
          <div class="line" style="width:70%"></div>
          <div class="bubble"></div>
          <div class="line" style="width:90%"></div>
          <div class="line" style="width:55%"></div>
          <div class="compose"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="features">
    <h2>What WorkCrew does</h2>
    <p class="sub">Real work in real apps, always with your approval before anything changes.</p>
    <div class="grid">
      <div class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg></div>
        <h3>Works in your browser</h3><p>It acts in a real browser window using your own signed-in accounts, and asks before anything changes.</p>
      </div>
      <div class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></div>
        <h3>Controls your apps</h3><p>It can read and operate Windows applications to finish everyday tasks for you.</p>
      </div>
      <div class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg></div>
        <h3>You stay in control</h3><p>Every change is shown first. Passwords, payments, and deletions always need your approval.</p>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>Get started in minutes</h2>
    <p class="sub">Three steps and your crew is working.</p>
    <div class="steps">
      <div class="step"><h3>Download</h3><p>Install the secure Windows app. It runs on your own computer.</p></div>
      <div class="step"><h3>Create an account</h3><p>Sign up, verify your email, and choose a plan that fits.</p></div>
      <div class="step"><h3>Tell it what to do</h3><p>Type a task in plain words and approve each change as it works.</p></div>
    </div>
  </section>

  <section class="section" id="help">
    <h2>Help and billing</h2>
    <p class="sub">Reach the team, manage your payment method, or cancel your subscription.</p>
    <div class="help-grid">
      <div class="help-card">
        <h3>Contact support</h3>
        <p>Questions or a problem? Email the WorkCrew team and we will help you out. <br><span class="addr">${SUPPORT_EMAIL}</span></p>
        <a class="btn ghost" href="${mailHref}">Email support</a>
      </div>
      <div class="help-card">
        <h3>Manage billing</h3>
        <p>Update your payment method, see invoices, or cancel your subscription. Sign in to open your secure billing page.</p>
        <button class="btn primary" onclick="manageBilling()">Manage billing</button>
      </div>
    </div>
  </section>
</div>

<footer><div class="wrap frow">
  <span>WorkCrew. Secure Windows automation.</span>
  <span class="flinks">
    <a href="#features">Features</a>
    <a href="#help">Help</a>
    <button onclick="manageBilling()">Manage billing</button>
    <button onclick="openAuth('signin')">Sign in</button>
  </span>
</div></footer>

<div class="modal" id="modal" onclick="if(event.target===this)closeAuth()">
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="title">
    <button class="x" onclick="closeAuth()" aria-label="Close">×</button>
    <div class="glyph">${brandGlyph(40)}</div>
    <h2 id="title">Create your account</h2>
    <p class="sub" id="subtitle">Create an account, then download the app and sign in.</p>
    <div class="field"><input id="email" type="email" placeholder="Email address" autocomplete="email"></div>
    <div class="field pwrap">
      <input id="password" type="password" placeholder="Password (at least 10 characters)" autocomplete="current-password">
      <button class="peye" id="peye" type="button" onclick="togglePw()" aria-pressed="false" aria-label="Show password">Show</button>
    </div>
    <button class="btn primary go" id="submit" onclick="submitAuth()">Create account</button>
    <p class="msg" id="msg"></p>
    <div class="trow"><button class="link" id="toggle" onclick="toggleMode()">Already have an account? Sign in</button></div>
  </div>
</div>
<div id="toast" role="status"></div>

<script>
var mode='signup';      // 'signup' | 'signin'
var intent='';          // '' | 'billing' (after sign-in, open billing portal)
var token='';
try{token=sessionStorage.getItem('wc_at')||'';}catch(e){}
var dlEl=document.getElementById('dl');
var dlMissing=dlEl.getAttribute('data-missing')==='1';
if(dlMissing){document.getElementById('dlnote').textContent='The Windows installer link is not set yet.';dlEl.addEventListener('click',function(e){e.preventDefault();});}

var hdr=document.getElementById('hdr');
window.addEventListener('scroll',function(){if(window.scrollY>6)hdr.classList.add('scrolled');else hdr.classList.remove('scrolled');});

function setMsg(t,c){var m=document.getElementById('msg');m.textContent=t;m.className='msg'+(c?(' '+c):'');}
var toastTimer;
function showToast(t,isErr){var el=document.getElementById('toast');el.textContent=t;el.className='show'+(isErr?' err':'');clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.className='';},isErr?5000:3000);}
function hideToast(){var el=document.getElementById('toast');el.className='';}

function openAuth(m,i){mode=m;intent=i||'';render();var mo=document.getElementById('modal');mo.classList.add('open');setTimeout(function(){document.getElementById('email').focus();},40);}
function closeAuth(){document.getElementById('modal').classList.remove('open');setMsg('','');}
function toggleMode(){mode=(mode==='signup')?'signin':'signup';render();}
function togglePw(){var p=document.getElementById('password'),b=document.getElementById('peye');if(p.type==='password'){p.type='text';b.textContent='Hide';b.setAttribute('aria-pressed','true');b.setAttribute('aria-label','Hide password');}else{p.type='password';b.textContent='Show';b.setAttribute('aria-pressed','false');b.setAttribute('aria-label','Show password');}}
function render(){
  document.getElementById('title').textContent=(mode==='signup')?'Create your account':'Welcome back';
  document.getElementById('subtitle').textContent=(mode==='signup')?'Create an account, then download the app and sign in.':(intent==='billing'?'Sign in to open your billing page.':'Sign in to your WorkCrew account.');
  document.getElementById('submit').textContent=(mode==='signup')?'Create account':'Sign in';
  document.getElementById('toggle').textContent=(mode==='signup')?'Already have an account? Sign in':'Need an account? Create one';
  setMsg('','');
}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeAuth();});
document.getElementById('password').addEventListener('keydown',function(e){if(e.key==='Enter')submitAuth();});
document.getElementById('email').addEventListener('keydown',function(e){if(e.key==='Enter')submitAuth();});

function manageBilling(){if(token){openPortal();}else{openAuth('signin','billing');}}
async function openPortal(){
  showToast('Opening your billing...');
  try{
    var r=await fetch('/v1/billing/portal',{method:'POST',headers:{'authorization':'Bearer '+token}});
    if(r.status===401){token='';try{sessionStorage.removeItem('wc_at');}catch(e){}hideToast();openAuth('signin','billing');setMsg('Please sign in again.','err');return;}
    if(r.ok){var d=await r.json().catch(function(){return {};});if(d&&d.url){window.location.href=d.url;return;}showToast('Billing is not available right now. Please try again.',true);return;}
    if(r.status===404){showToast('You do not have a billing account yet. Subscribe in the app first.',true);return;}
    var e2=await r.json().catch(function(){return {};});
    showToast((e2&&e2.error)||'Billing is not available right now. Please try again.',true);
  }catch(e){showToast('Could not reach the server. Please try again.',true);}
}

async function submitAuth(){
  var email=document.getElementById('email').value.trim();
  var password=document.getElementById('password').value;
  if(!email||password.length<10){setMsg('Enter an email and a password of at least 10 characters.','err');return;}
  var btn=document.getElementById('submit');btn.disabled=true;setMsg('Please wait...','');
  try{
    var path=(mode==='signup')?'/v1/auth/sign-up':'/v1/auth/sign-in';
    var r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email,password:password})});
    var d=await r.json().catch(function(){return {};});
    if(r.ok){
      if(mode==='signup'){
        setMsg('Account created. Check your email for a verification link.','ok');
        setTimeout(closeAuth,2000);
      }else{
        if(d&&d.session&&d.session.accessToken){token=d.session.accessToken;try{sessionStorage.setItem('wc_at',token);}catch(e){}}
        if(intent==='billing'){closeAuth();openPortal();}
        else{setMsg('Signed in. Download the app to get started.','ok');setTimeout(closeAuth,1600);}
      }
    }else{setMsg((d&&d.error)||'Something went wrong. Please try again.','err');}
  }catch(e){setMsg('Could not reach the server. Please try again.','err');}
  finally{btn.disabled=false;}
}
</script>
</body></html>`;
}
