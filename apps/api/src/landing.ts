// The public marketing and download page served at the backend root. It is a
// single self-contained HTML page: brand, a short pitch, a Download for Windows
// button, and working Create account / Sign in forms that post to the existing
// auth endpoints. No provider or vendor names appear anywhere.

// The WorkCrew app icon as inline vector, so it renders crisply at any size and
// matches the desktop icon exactly: a purple quatrefoil with a plus-shaped
// cutout on a dark rounded tile. Ids are suffixed so two marks could coexist.
function brandMark(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex:0 0 auto">
<defs>
<linearGradient id="bmTile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#221F2E"/><stop offset="1" stop-color="#17151E"/></linearGradient>
<linearGradient id="bmMark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="0.55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>
<mask id="bmPlus"><rect width="512" height="512" fill="white"/><rect x="222" y="150" width="68" height="212" rx="34" fill="black"/><rect x="150" y="222" width="212" height="68" rx="34" fill="black"/></mask>
</defs>
<rect x="0" y="0" width="512" height="512" rx="116" fill="url(#bmTile)"/>
<g mask="url(#bmPlus)" fill="url(#bmMark)" transform="translate(256 256) scale(2.05) translate(-50 -50)">
<circle cx="50" cy="28" r="22"/><circle cx="50" cy="72" r="22"/><circle cx="28" cy="50" r="22"/><circle cx="72" cy="50" r="22"/><rect x="28" y="28" width="44" height="44" rx="14"/>
</g>
</svg>`;
}

export function landingPage(downloadUrl: string): string {
  const download = downloadUrl && downloadUrl.length > 0 ? downloadUrl : "";
  const downloadAttr = download ? `href="${download}"` : `href="#" data-missing="1"`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkCrew — Put routine work on autopilot</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(brandMark(512))}">
<link rel="apple-touch-icon" href="data:image/svg+xml,${encodeURIComponent(brandMark(512))}">
<style>
:root{--bg:#1f1e1d;--panel:#262523;--panel2:#2d2b29;--line:#3a3836;--text:#e8e6e3;--muted:#a8a39d;--accent:#8b5cf6;--accent2:#a78bfa}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font-family:Segoe UI,Arial,sans-serif;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:0 22px}
header{display:flex;align-items:center;justify-content:space-between;padding:22px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px}
.navbtn{background:none;border:1px solid var(--line);color:var(--text);padding:9px 16px;border-radius:10px;cursor:pointer;font-size:14px;margin-left:8px}
.navbtn:hover{border-color:var(--accent)}
.hero{text-align:center;padding:64px 0 28px}
.hero h1{font-size:44px;line-height:1.12;margin:0 0 16px;font-weight:800}
.hero p{font-size:18px;color:var(--muted);max-width:620px;margin:0 auto 28px}
.cta{display:inline-flex;gap:12px;flex-wrap:wrap;justify-content:center}
.primary{background:var(--accent);color:#fff;border:0;padding:14px 26px;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
.primary:hover{background:var(--accent2)}
.ghost{background:var(--panel);color:var(--text);border:1px solid var(--line);padding:14px 22px;border-radius:12px;font-weight:600;font-size:15px;cursor:pointer}
.note{color:var(--muted);font-size:13px;margin-top:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:30px 0 60px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px}
.card h3{margin:0 0 8px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:14px}
footer{border-top:1px solid var(--line);padding:22px 0;color:var(--muted);font-size:13px;text-align:center}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;place-items:center;padding:18px}
.modal.open{display:grid}
.sheet{width:min(400px,94vw);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px}
.sheet h2{margin:0 0 4px;font-size:20px}.sheet p.sub{margin:0 0 14px;color:var(--muted);font-size:14px}
.sheet input{width:100%;margin:8px 0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font-size:14px}
.sheet .row{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.link{background:none;border:0;color:var(--accent2);cursor:pointer;font-size:13px}
.msg{font-size:13px;margin-top:10px;min-height:18px}.ok{color:#4caf7d}.err{color:#d98a93}
.x{float:right;background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer}
</style></head><body>
<div class="wrap">
  <header>
    <div class="brand">${brandMark(28)} WorkCrew</div>
    <nav>
      <button class="navbtn" onclick="openAuth('signin')">Sign in</button>
      <button class="navbtn" onclick="openAuth('signup')">Sign up</button>
    </nav>
  </header>
  <section class="hero">
    <h1>Put routine work on autopilot</h1>
    <p>WorkCrew is a secure Windows app that does real tasks in your browser and your apps, with your permission, every step of the way.</p>
    <div class="cta">
      <a class="primary" id="dl" ${downloadAttr}>Download for Windows</a>
      <button class="ghost" onclick="openAuth('signup')">Create an account</button>
    </div>
    <p class="note" id="dlnote"></p>
  </section>
  <section class="grid">
    <div class="card"><h3>Works in your browser</h3><p>It acts in a real browser window using your own signed-in accounts, and asks before anything changes.</p></div>
    <div class="card"><h3>Controls your apps</h3><p>It can read and operate Windows applications to finish everyday tasks for you.</p></div>
    <div class="card"><h3>You stay in control</h3><p>Every change is shown first. Passwords, payments, and deletions always need your approval.</p></div>
  </section>
</div>
<footer>WorkCrew. Secure Windows automation.</footer>

<div class="modal" id="modal">
  <div class="sheet">
    <button class="x" onclick="closeAuth()" aria-label="Close">×</button>
    <h2 id="title">Create your account</h2>
    <p class="sub" id="subtitle">Sign up, then download the app and sign in.</p>
    <input id="email" type="email" placeholder="Email address" autocomplete="email">
    <input id="password" type="password" placeholder="Password (at least 10 characters)" autocomplete="current-password">
    <button class="primary" style="width:100%;margin-top:8px" id="submit" onclick="submitAuth()">Continue</button>
    <p class="msg" id="msg"></p>
    <div class="row">
      <button class="link" id="toggle" onclick="toggleMode()">Already have an account? Sign in</button>
    </div>
  </div>
</div>
<script>
var mode='signup';
var dlMissing=document.getElementById('dl').getAttribute('data-missing')==='1';
if(dlMissing){document.getElementById('dlnote').textContent='The Windows installer link is not set yet.';document.getElementById('dl').addEventListener('click',function(e){e.preventDefault();});}
function openAuth(m){mode=m;render();document.getElementById('modal').classList.add('open');}
function closeAuth(){document.getElementById('modal').classList.remove('open');document.getElementById('msg').textContent='';}
function toggleMode(){mode=(mode==='signup')?'signin':'signup';render();}
function render(){
  document.getElementById('title').textContent=(mode==='signup')?'Create your account':'Sign in';
  document.getElementById('subtitle').textContent=(mode==='signup')?'Sign up, then download the app and sign in.':'Sign in to your WorkCrew account.';
  document.getElementById('toggle').textContent=(mode==='signup')?'Already have an account? Sign in':'Need an account? Sign up';
  document.getElementById('msg').textContent='';
}
async function submitAuth(){
  var email=document.getElementById('email').value.trim();
  var password=document.getElementById('password').value;
  var msg=document.getElementById('msg');
  if(!email||password.length<10){msg.className='msg err';msg.textContent='Enter an email and a password of at least 10 characters.';return;}
  var btn=document.getElementById('submit');btn.disabled=true;msg.className='msg';msg.textContent='Please wait...';
  try{
    var path=(mode==='signup')?'/v1/auth/sign-up':'/v1/auth/sign-in';
    var r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email,password:password})});
    var d=await r.json().catch(function(){return {};});
    if(r.ok){
      msg.className='msg ok';
      msg.textContent=(mode==='signup')?'Account created. Check your email for a verification link, then download the app and sign in.':'Signed in. Download the app to get started.';
    }else{msg.className='msg err';msg.textContent=(d&&d.error)||'Something went wrong. Please try again.';}
  }catch(e){msg.className='msg err';msg.textContent='Could not reach the server. Please try again.';}
  finally{btn.disabled=false;}
}
</script>
</body></html>`;
}
