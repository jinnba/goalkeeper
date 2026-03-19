// ============================================================
//  goalkeeper.js
//  Web Audio API による効果音 + ゲームロジック
// ============================================================

// ── Web Audio API セットアップ ────────────────────────────
const AudioCtx = new (window.AudioContext || window.webkitAudioContext)();
const soundBuffers = {};  // { kick, catch, goal }

/**
 * 音声ファイルを読み込んでバッファに格納する
 * @param {string} name  - 識別キー ('kick' | 'catch' | 'goal')
 * @param {string} path  - ファイルパス
 */
async function loadSound(name, path) {
  try {
    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();
    soundBuffers[name] = await AudioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    console.warn(`音声ファイルの読み込みに失敗: ${path}`, e);
  }
}

/**
 * 音声を再生する
 * AudioContext が suspended の場合は resume してから再生
 * @param {string} name - 識別キー
 */
function playSound(name) {
  if (!soundBuffers[name]) return;
  if (AudioCtx.state === 'suspended') AudioCtx.resume();
  const source = AudioCtx.createBufferSource();
  source.buffer = soundBuffers[name];
  source.connect(AudioCtx.destination);
  source.start(0);
}

// ── 音声の事前読み込み ────────────────────────────────────
Promise.all([
  loadSound('kick',  'audio/kick.mp3'),
  loadSound('catch', 'audio/catch.mp3'),
  loadSound('goal',  'audio/goal.mp3'),
]);

// ============================================================
//  Canvas セットアップ
// ============================================================
const CV = document.getElementById('gc');
const C  = CV.getContext('2d');
const W = 700, H = 394;
CV.width = W; CV.height = H;

const GL = W*.08, GR = W*.92, GT = H*.30, GB = H*.90;
const GCX = (GL+GR)/2, HORIZON = H*.26;
const KCX = GCX, KCY = GB-70;

// ── 透視投影 ─────────────────────────────────────────────
// ゴール幅 7.32m(±3.66m) → z=0 で GL,GR に対応
// コート幅 68m(±34m), 長さ 105m, 視距離 F=18m
const GOAL_HW  = 3.66;
const COURT_L  = 105;
const STR_W    = 5;
const F        = 18;
const PPM      = ((GR-GL)/2) / GOAL_HW;           // px/m (z=0基準)
const COURT_HW = (W*3/5/2) / (PPM*F/(F+COURT_L)); // 向こうゴール幅=W*3/5

function sY(z) { return HORIZON + (GB-HORIZON)*F/(F+z); }
function sX(x, z) { return GCX + x*PPM*F/(F+z); }

// ── レベル定義 ───────────────────────────────────────────
// 奇数レベル(3,5,7): キッカーが近づく (kickerYNorm 増加)
// 偶数レベル(2,4,6,8): ボール速度UP (timeLimit 短縮)
// Lv8: 人間の反応限界付近 (190ms)
const LEVELS = [
  { yn:.38, tl:.75, wu:.40, lb:'Lv1' }, // 遠・標準
  { yn:.38, tl:.52, wu:.35, lb:'Lv2' }, // 遠・速↑
  { yn:.52, tl:.52, wu:.30, lb:'Lv3' }, // 中・速同
  { yn:.52, tl:.36, wu:.26, lb:'Lv4' }, // 中・速↑
  { yn:.64, tl:.36, wu:.22, lb:'Lv5' }, // 近・速同
  { yn:.64, tl:.26, wu:.18, lb:'Lv6' }, // 近・速↑
  { yn:.74, tl:.26, wu:.15, lb:'Lv7' }, // 最近・速同
  { yn:.74, tl:.19, wu:.12, lb:'Lv8' }, // 最近・限界速
];
const NMAX    = LEVELS.length;
const MIN_GAP = 85; // キーパーとキッカーの最低距離(px)

function cfg()   { return LEVELS[Math.min(lv-1, NMAX-1)]; }
function kcY()   { return Math.min(HORIZON + (GB-HORIZON)*cfg().yn, KCY-MIN_GAP); }
function kcSc()  { const t = (kcY()-HORIZON)/(GB-HORIZON); return .28 + t*.30; }
function bStart(){ const ky=kcY(), sc=kcSc(); return { x: GCX+8*sc, y: ky+56*sc }; }

// ── ショット定義 ─────────────────────────────────────────
const SHOTS = [
  { side:'left',  x: GL+(GR-GL)*.13, y: GT+(GB-GT)*.75 },
  { side:'left',  x: GL+(GR-GL)*.13, y: GT+(GB-GT)*.48 },
  { side:'left',  x: GL+(GR-GL)*.16, y: GT+(GB-GT)*.15 },
  { side:'right', x: GL+(GR-GL)*.87, y: GT+(GB-GT)*.75 },
  { side:'right', x: GL+(GR-GL)*.87, y: GT+(GB-GT)*.48 },
  { side:'right', x: GL+(GR-GL)*.84, y: GT+(GB-GT)*.15 },
  { side:'up',    x: GCX,            y: GT+(GB-GT)*.14  },
  { side:'stay',  x: GCX,            y: GT+(GB-GT)*.60  },
];
const JUMPS = {
  left:  { dx: -(GR-GL)*.30, dy: -H*.04 },
  right: { dx:  (GR-GL)*.30, dy: -H*.04 },
  up:    { dx: 0,             dy: -(GB-GT)*.32 },
  stay:  { dx: 0,             dy: 0 },
};
function isSave(s, p) { return s === 'stay' ? p === null : p === s; }

// ── ゲーム状態 ───────────────────────────────────────────
let state = 0;  // 0:idle, 1:play, 2:win, 3:lose
let lv = 1, saved = 0, miss = 0, streak = 0, shotN = 0;
let results = [];  // 'save' | 'goal' | null の5要素
let selLv = 1;

// フェーズ: 0=wait, 1=windup, 2=shoot, 3=catch, 4=goal, 5=result
let phase = 0, shot = null, pdir = null;
let stimer = 0, ttotal = 0, wtimer = 0, wtime = 0, rtimer = 0;
let bx = 0, by = 0, bprog = 0;
let kox = 0, koy = 0, kat = 0, kph = 0, kpt = 0;
let shootT = 0, ctimer = 0;
const CDUR = .65;
let parts = [];

// ── 紙吹雪 ──────────────────────────────────────────────
const CC   = document.getElementById('cc');
const CCx  = CC.getContext('2d');
let conf = [], confOn = false;
const CCOLS = ['#FFD700','#FF6B6B','#69f0ae','#4fc3f7','#ff80ab','#fff176','#ce93d8'];

function confInit() {
  CC.width = CC.offsetWidth; CC.height = CC.offsetHeight; conf = [];
  for (let i=0; i<200; i++) conf.push({
    x: Math.random()*CC.width, y: -30 - Math.random()*400,
    w: 6+Math.random()*8, h: 3+Math.random()*4,
    vx: (Math.random()-.5)*3, vy: 2+Math.random()*4,
    rot: Math.random()*360, vr: (Math.random()-.5)*8,
    col: CCOLS[Math.floor(Math.random()*CCOLS.length)],
    ci: Math.random() < .5,
  });
  confOn = true;
}
function confTick(dt) {
  if (!confOn) return;
  CCx.clearRect(0, 0, CC.width, CC.height);
  conf.forEach(c => {
    c.x += c.vx; c.y += c.vy; c.rot += c.vr;
    c.vx += (Math.random()-.5)*.15;
    if (c.y > CC.height+20) { c.y = -20; c.x = Math.random()*CC.width; }
    CCx.save(); CCx.translate(c.x, c.y); CCx.rotate(c.rot*Math.PI/180);
    CCx.fillStyle = c.col;
    if (c.ci) { CCx.beginPath(); CCx.arc(0,0,c.w/2,0,Math.PI*2); CCx.fill(); }
    else CCx.fillRect(-c.w/2, -c.h/2, c.w, c.h);
    CCx.restore();
  });
}
function confStop() { confOn = false; CCx.clearRect(0,0,CC.width,CC.height); }

// ── UI 更新 ──────────────────────────────────────────────
function updSI() {
  const el = document.getElementById('si'); el.innerHTML = '';
  for (let i=0; i<5; i++) {
    const d = document.createElement('div'), r = results[i];
    const bg = r==='save' ? '#69f0ae' : r==='goal' ? '#ff5252' : 'rgba(255,255,255,.22)';
    d.style.cssText = `width:13px;height:13px;border-radius:50%;background:${bg};border:1.5px solid ${r?'rgba(255,255,255,.65)':'rgba(255,255,255,.38)'}`;
    el.appendChild(d);
  }
}
function updHUD() {
  document.getElementById('hs').textContent = streak;
  const c = cfg(), el = document.getElementById('lb');
  el.innerHTML = '<div class="hl">LEVEL</div>';
  const ds = document.createElement('div'); ds.className = 'dots';
  for (let i=1; i<=NMAX; i++) {
    const d = document.createElement('div');
    d.style.cssText = `width:7px;height:7px;border-radius:50%;background:${i<=lv?'#e8b43a':'#333'}`;
    ds.appendChild(d);
  }
  el.appendChild(ds);
  const v = document.createElement('div'); v.className = 'hv';
  v.style.textAlign = 'center'; v.textContent = c.lb;
  el.appendChild(v);
}
function buildLG(id) {
  const g = document.getElementById(id); g.innerHTML = '';
  LEVELS.forEach((l, i) => {
    const b = document.createElement('button');
    b.className = 'lvb' + (i===selLv-1 ? ' sel' : '');
    b.innerHTML = `<span class="lbg"></span><span class="lsh"></span><span class="lbd"></span><span class="lt">${l.lb}</span><span class="lsp">${Math.round(l.tl*1000)}ms</span>`;
    b.onclick = () => {
      selLv = i+1;
      document.querySelectorAll(`#${id} .lvb`).forEach((x,j) => x.classList.toggle('sel', j===i));
    };
    g.appendChild(b);
  });
}
buildLG('lg');

// ── イージング ───────────────────────────────────────────
const eOut  = t => 1-(1-t)*(1-t);
const eOut3 = t => 1-(1-t)*(1-t)*(1-t);
const eIn   = t => t*t*t;

// ── 街並みシルエット ─────────────────────────────────────
const CITY_BUILDINGS = [
  [30,14,22],[55,20,34],[90,10,18],[140,16,28],[168,12,20],
  [210,22,38],[245,8,16],[300,18,30],[340,10,22],
  [450,12,26],[476,20,40],[512,8,18],[545,16,32],
  [575,10,20],[620,22,36],[658,14,24],[685,10,18],
];
function drawCityscape() {
  CITY_BUILDINGS.forEach(([bx2, bw, bh]) => {
    C.fillStyle = '#6a8faa';
    C.fillRect(bx2, HORIZON-bh, bw, bh);
  });
}

// ── 背景描画 ─────────────────────────────────────────────
function drawBG() {
  // 空
  const sg = C.createLinearGradient(0,0,0,HORIZON);
  sg.addColorStop(0,'#7ab8e8'); sg.addColorStop(.55,'#aed4f0'); sg.addColorStop(1,'#cce8f5');
  C.fillStyle = sg; C.fillRect(0,0,W,HORIZON);

  // 雲
  [[80,HORIZON*.35,.9,.75],[310,HORIZON*.22,.7,.6],[520,HORIZON*.4,1,.7],[630,HORIZON*.18,.55,.5]].forEach(([cx,cy,sc,a]) => {
    C.save(); C.globalAlpha = a; C.fillStyle = '#fff';
    [[0,0,22],[18,-8,16],[34,-4,18],[52,-2,14],[-16,-4,14],[14,10,12],[28,8,14]].forEach(([dx,dy,r]) => {
      C.beginPath(); C.arc(cx+dx*sc, cy+dy*sc, r*sc, 0, Math.PI*2); C.fill();
    });
    C.restore();
  });

  // 街並み（空の手前・地平線直上）
  drawCityscape();

  // 土手
  C.fillStyle = '#7ab55c';
  C.beginPath(); C.moveTo(0,HORIZON); C.lineTo(0,HORIZON*.72);
  C.bezierCurveTo(60,HORIZON*.62,200,HORIZON*.75,350,HORIZON*.76);
  C.bezierCurveTo(500,HORIZON*.77,640,HORIZON*.7,700,HORIZON*.65);
  C.lineTo(W,HORIZON); C.closePath(); C.fill();
  C.fillStyle = '#6aa34e';
  C.beginPath(); C.moveTo(0,HORIZON); C.lineTo(0,HORIZON*.78);
  C.bezierCurveTo(110,HORIZON*.77,280,HORIZON*.86,400,HORIZON*.85);
  C.bezierCurveTo(520,HORIZON*.84,680,HORIZON*.72,W,HORIZON*.68);
  C.lineTo(W,HORIZON); C.closePath(); C.fill();

  // 川
  const ry=HORIZON*.88, rh=HORIZON*.12;
  const rg = C.createLinearGradient(0,ry,0,ry+rh);
  rg.addColorStop(0,'#6aabcc'); rg.addColorStop(1,'#4a8fb0');
  C.fillStyle = rg; C.fillRect(0,ry,W,rh);
  C.fillStyle = 'rgba(255,255,255,.18)';
  for (let i=0; i<8; i++) { C.beginPath(); C.ellipse(30+i*88, ry+rh*.4, 16, 2, 0, 0, Math.PI*2); C.fill(); }

  // 対岸の木
  C.fillStyle = '#5a9440';
  for (let i=0; i<14; i++) {
    const tx=i*52+15, ty=HORIZON*.75, tr=11+Math.sin(i*1.4)*3;
    C.beginPath(); C.arc(tx,ty,tr,0,Math.PI*2); C.fill();
    C.fillRect(tx-2, ty, 4, HORIZON*.13);
  }

  // 芝ベース
  const gg = C.createLinearGradient(0,HORIZON,0,H);
  gg.addColorStop(0,'#8cc456'); gg.addColorStop(.3,'#72ab3e');
  gg.addColorStop(.65,'#5e9430'); gg.addColorStop(1,'#4a7824');
  C.fillStyle = gg; C.fillRect(0,HORIZON,W,H-HORIZON);

  // 横ストライプ（透視台形）
  // i=0: z=0〜5m（手前・下・幅広）, i=N-1: z=100〜105m（奥・上・幅W*3/5）
  const N = Math.ceil(COURT_L/STR_W);
  for (let i=0; i<N; i++) {
    if (i%2 !== 0) continue;
    const z0 = i*STR_W;
    const z1 = Math.min((i+1)*STR_W, COURT_L);
    const yB = sY(z0), yT = sY(z1);  // yB > yT（下>上）
    if (yT < HORIZON) continue;
    let xBL = sX(-COURT_HW,z0), xBR = sX(COURT_HW,z0);
    const xTL = sX(-COURT_HW,z1), xTR = sX(COURT_HW,z1);
    let dYB = yB;
    if (yB > H) {
      const t = (H-yT)/(yB-yT);
      dYB = H; xBL = xTL+(xBL-xTL)*t; xBR = xTR+(xBR-xTR)*t;
    }
    C.fillStyle = 'rgba(0,0,0,.07)';
    C.beginPath();
    C.moveTo(xBL, dYB); // 下左（広い）
    C.lineTo(xBR, dYB); // 下右
    C.lineTo(xTR, yT);  // 上右（狭い）
    C.lineTo(xTL, yT);  // 上左
    C.closePath(); C.fill();
  }

  // 電柱
  C.strokeStyle = '#8a7060'; C.lineWidth = 2.5;
  C.beginPath(); C.moveTo(620,HORIZON*.95); C.lineTo(618,HORIZON*.42); C.stroke();
  C.lineWidth = 1.2;
  C.beginPath(); C.moveTo(608,HORIZON*.52); C.lineTo(632,HORIZON*.52); C.stroke();
  C.beginPath(); C.moveTo(610,HORIZON*.56); C.lineTo(630,HORIZON*.56); C.stroke();
  C.strokeStyle = 'rgba(60,40,20,.45)'; C.lineWidth = .6;
  C.beginPath(); C.moveTo(608,HORIZON*.52); C.bezierCurveTo(550,HORIZON*.6,300,HORIZON*.58,200,HORIZON*.56); C.stroke();
}

function drawNet() {
  const d = H*.12; C.save(); C.strokeStyle = 'rgba(220,220,210,.22)'; C.lineWidth = .6;
  for (let i=0; i<=12; i++) { const t=i/12, bx2=GL+(GR-GL)*t, tx=GCX+(bx2-GCX)*.5; C.beginPath(); C.moveTo(bx2,GT); C.lineTo(tx,GT-d); C.stroke(); }
  for (let j=0; j<=8; j++) { const t=j/8, lx=GL+(GCX-GL)*t*.5, rx=GR-(GR-GCX)*t*.5, ny=GT-d*t; C.beginPath(); C.moveTo(lx,ny); C.lineTo(rx,ny); C.stroke(); }
  C.restore();
}
function drawPosts() {
  C.save();
  C.fillStyle = 'rgba(0,0,0,.1)'; C.fillRect(GL-4,GT,7,GB-GT); C.fillRect(GR-3,GT,7,GB-GT);
  C.strokeStyle = '#f2f2f2'; C.lineWidth = 9; C.lineCap = 'round';
  C.beginPath(); C.moveTo(GL,GB); C.lineTo(GL,GT); C.lineTo(GR,GT); C.lineTo(GR,GB); C.stroke();
  C.strokeStyle = 'rgba(255,255,255,.65)'; C.lineWidth = 2.5;
  C.beginPath(); C.moveTo(GL+2,GB); C.lineTo(GL+2,GT); C.lineTo(GR-2,GT); C.lineTo(GR-2,GB); C.stroke();
  C.restore();
}

function drawKeeper(ox, oy, dir, at, catching, cp) {
  const kx=KCX+ox, ky=KCY+oy;
  const dL=dir==='left', dR=dir==='right', div=dL||dR, up=dir==='up';
  const rot = dL?-at*1.3 : dR?at*1.3 : up?-at*.15 : 0;
  const lift = div ? Math.sin(at*Math.PI)*18 : 0;
  C.save(); C.translate(kx, ky-lift); C.rotate(rot);
  const h=88, w=34;
  if (div) {
    const d=dL?-1:1, t=at;
    C.save(); C.translate(d*(-10+t*5),h*.15+t*8); C.rotate(d*(.3+t*.5));
    C.fillStyle='#0d47a1'; C.beginPath(); C.roundRect(-5,0,10,26,3); C.fill();
    C.fillStyle='#fff'; C.fillRect(-5,20,10,6); C.fillStyle='#111'; C.beginPath(); C.roundRect(-6,24,12,7,3); C.fill(); C.restore();
    C.save(); C.translate(d*(8+t*8),h*.22+t*5); C.rotate(d*(.1-t*.7));
    C.fillStyle='#0d47a1'; C.beginPath(); C.roundRect(-5,0,10,26,3); C.fill();
    C.fillStyle='#fff'; C.fillRect(-5,20,10,6); C.fillStyle='#111'; C.beginPath(); C.roundRect(-6,24,12,7,3); C.fill(); C.restore();
    C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-w/2,-h*.05+t*4,w,h*.42,5); C.fill();
    C.fillStyle='rgba(0,0,0,.4)'; C.font='bold 14px Oswald,sans-serif'; C.textAlign='center'; C.fillText('1',0,h*.20);
    C.strokeStyle='rgba(0,0,0,.12)'; C.lineWidth=1.5;
    C.beginPath(); C.moveTo(-w/2+5,-h*.03); C.lineTo(-w/2+5,h*.33); C.stroke();
    C.beginPath(); C.moveTo(w/2-5,-h*.03); C.lineTo(w/2-5,h*.33); C.stroke();
    const ar = catching ? eOut3(Math.min(1,cp*3)) : t;
    C.save(); C.translate(d*(w/2-2),h*.04); C.rotate(d*(.3+ar*1.1));
    C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.28,4); C.fill();
    C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.fill();
    C.strokeStyle='#aaa'; C.lineWidth=.8; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.stroke(); C.restore();
    C.save(); C.translate(d*(-w/2+2),h*.04); C.rotate(d*(-.2-t*.4));
    C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.22,4); C.fill();
    C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.24,6,8,0,0,Math.PI*2); C.fill(); C.restore();
    C.fillStyle='#c8956a'; C.beginPath(); C.roundRect(-5,-h*.11,10,h*.08,2); C.fill();
    C.fillStyle='#3e2000'; C.beginPath(); C.arc(0,-h*.15,15,0,Math.PI*2); C.fill();
    C.fillStyle='#5a3010'; C.beginPath(); C.arc(d*(-3),-(h*.15+3),9,0,Math.PI*2); C.fill();
  } else {
    C.rotate(up ? -at*.12 : 0);
    C.fillStyle='#fff'; C.fillRect(-w/2+3,h*.6,8,10); C.fillRect(3,h*.6,8,10);
    C.fillStyle='#111'; C.beginPath(); C.roundRect(-w/2+1,h*.68,13,9,3); C.fill(); C.beginPath(); C.roundRect(1,h*.68,13,9,3); C.fill();
    C.fillStyle='#0d47a1'; C.beginPath(); C.roundRect(-w/2+2,h*.38,w/2-3,h*.31,3); C.fill(); C.beginPath(); C.roundRect(0,h*.38,w/2-3,h*.31,3); C.fill();
    C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-w/2,-h*.07,w,h*.47,5); C.fill();
    C.fillStyle='rgba(0,0,0,.45)'; C.font='bold 15px Oswald,sans-serif'; C.textAlign='center'; C.fillText('1',0,h*.18);
    C.strokeStyle='rgba(0,0,0,.15)'; C.lineWidth=1.5;
    C.beginPath(); C.moveTo(-w/2+6,-h*.05); C.lineTo(-w/2+6,h*.36); C.stroke();
    C.beginPath(); C.moveTo(w/2-6,-h*.05); C.lineTo(w/2-6,h*.36); C.stroke();
    const ua = up ? -at*.9 : 0;
    if (catching && cp > 0) {
      const p = eOut3(Math.min(1,cp*2.5));
      C.save(); C.translate(-w/2+2,h*.08); C.rotate(-.5+p*(-.9));
      C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.28,4); C.fill();
      C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.fill();
      C.strokeStyle='#aaa'; C.lineWidth=.8; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.stroke(); C.restore();
      C.save(); C.translate(w/2-2,h*.08); C.rotate(.5+p*.9);
      C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.28,4); C.fill();
      C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.fill();
      C.strokeStyle='#aaa'; C.lineWidth=.8; C.beginPath(); C.ellipse(0,h*.3,7,9,0,0,Math.PI*2); C.stroke(); C.restore();
    } else {
      C.save(); C.translate(-w/2,h*.05); C.rotate(.45+ua);
      C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.25,4); C.fill();
      C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.27,7,9,0,0,Math.PI*2); C.fill();
      C.strokeStyle='#aaa'; C.lineWidth=.8; C.beginPath(); C.ellipse(0,h*.27,7,9,0,0,Math.PI*2); C.stroke(); C.restore();
      C.save(); C.translate(w/2,h*.05); C.rotate(-.45+ua);
      C.fillStyle='#f9a825'; C.beginPath(); C.roundRect(-5,0,10,h*.25,4); C.fill();
      C.fillStyle='#ddd'; C.beginPath(); C.ellipse(0,h*.27,7,9,0,0,Math.PI*2); C.fill();
      C.strokeStyle='#aaa'; C.lineWidth=.8; C.beginPath(); C.ellipse(0,h*.27,7,9,0,0,Math.PI*2); C.stroke(); C.restore();
    }
    C.fillStyle='#c8956a'; C.beginPath(); C.roundRect(-5,-h*.12,10,h*.08,2); C.fill();
    C.fillStyle='#3e2000'; C.beginPath(); C.arc(0,-h*.16,15,0,Math.PI*2); C.fill();
    C.fillStyle='#5a3010'; C.beginPath(); C.arc(-3,-h*.19,9,0,Math.PI*2); C.fill();
  }
  C.restore();
}

function drawKicker(kp, kt) {
  const ky=kcY(), sc=kcSc();
  C.save(); C.translate(GCX,ky); C.scale(sc,sc);
  C.fillStyle='rgba(0,0,0,.10)'; C.beginPath(); C.ellipse(0,47,20,5,0,0,Math.PI*2); C.fill();
  let rL=0, lL=0, bT=0, aL=0, aR=0;
  if (kp===1) { rL=-1.3*kt; lL=.15*kt; bT=-.12*kt; aL=.5*kt; aR=-.3*kt; }
  else if (kp===2) { rL=-1.3*(1-kt)+1.5*kt; lL=-.1; bT=.1; aL=-.2; aR=.25; }
  else if (kp===3) { rL=1.5-.5*kt; lL=-.15; bT=.15; aL=-.2; aR=.3; }
  C.save(); C.rotate(bT); C.fillStyle='#c62828'; C.beginPath(); C.roundRect(-17,-4,34,38,4); C.fill();
  C.fillStyle='rgba(255,255,255,.5)'; C.font='bold 11px Oswald,sans-serif'; C.textAlign='center'; C.fillText('9',0,16);
  C.save(); C.translate(-6,34); C.rotate(lL); C.fillStyle='#7f0000'; C.beginPath(); C.roundRect(-5,0,10,28,3); C.fill(); C.fillStyle='#fff'; C.fillRect(-5,22,10,7); C.fillStyle='#111'; C.beginPath(); C.roundRect(-6,27,12,8,3); C.fill(); C.restore();
  C.save(); C.translate(6,34); C.rotate(rL); C.fillStyle='#7f0000'; C.beginPath(); C.roundRect(-5,0,10,28,3); C.fill(); C.fillStyle='#fff'; C.fillRect(-5,22,10,7); C.fillStyle='#111'; C.beginPath(); C.roundRect(-6,27,12,8,3); C.fill(); C.restore();
  C.save(); C.translate(-17,4); C.rotate(-.4+aL); C.fillStyle='#c62828'; C.beginPath(); C.roundRect(-4,0,8,22,3); C.fill(); C.restore();
  C.save(); C.translate(17,4); C.rotate(.4+aR); C.fillStyle='#c62828'; C.beginPath(); C.roundRect(-4,0,8,22,3); C.fill(); C.restore();
  C.fillStyle='#8D5524'; C.beginPath(); C.arc(0,-14,11,0,Math.PI*2); C.fill();
  C.fillStyle='#3e1500'; C.beginPath(); C.arc(0,-17,11,Math.PI*1.1,Math.PI*1.9); C.fill();
  C.fillStyle='#222'; C.beginPath(); C.arc(-4,-14,2,0,Math.PI*2); C.fill(); C.beginPath(); C.arc(4,-14,2,0,Math.PI*2); C.fill();
  C.restore(); C.restore();
}

function drawBall(x, y, prog, still, caught, cp) {
  if (caught) {
    const sc2=1-cp*.18, r=10*sc2, wv=Math.sin(cp*Math.PI*6)*2*(1-cp*.8);
    C.save(); C.translate(x+wv,y); C.scale(sc2,sc2);
    const ga = Math.max(0,.4*(1-cp*1.5));
    if (ga > 0) { C.fillStyle=`rgba(255,230,100,${ga})`; C.beginPath(); C.arc(0,0,r*2.5,0,Math.PI*2); C.fill(); }
    C.fillStyle='#f5f5f5'; C.beginPath(); C.arc(0,0,r,0,Math.PI*2); C.fill();
    C.strokeStyle='#333'; C.lineWidth=r*.09; C.beginPath(); C.arc(0,0,r,0,Math.PI*2); C.stroke();
    C.beginPath(); C.moveTo(-r*.3,-r*.5); C.lineTo(r*.25,-r*.62); C.lineTo(r*.62,0); C.lineTo(r*.25,r*.52); C.lineTo(-r*.3,r*.48); C.closePath(); C.stroke();
    C.restore(); return;
  }
  const sc2=kcSc(), base=3+sc2*7, r=still?base:base+prog*prog*18, spin=prog*Math.PI*10;
  C.fillStyle='rgba(0,0,0,.1)'; C.beginPath(); C.ellipse(x,GB,r*.7,r*.2,0,0,Math.PI*2); C.fill();
  C.save(); C.translate(x,y); C.rotate(spin);
  C.fillStyle='#f5f5f5'; C.beginPath(); C.arc(0,0,r,0,Math.PI*2); C.fill();
  C.strokeStyle='#333'; C.lineWidth=Math.max(.4,r*.09); C.beginPath(); C.arc(0,0,r,0,Math.PI*2); C.stroke();
  if (r > 3) { C.beginPath(); C.moveTo(-r*.3,-r*.5); C.lineTo(r*.25,-r*.62); C.lineTo(r*.62,0); C.lineTo(r*.25,r*.52); C.lineTo(-r*.3,r*.48); C.closePath(); C.stroke(); }
  C.restore();
}

function spawnP(x, y) {
  parts = [];
  for (let i=0; i<18; i++) {
    const a=Math.random()*Math.PI*2, sp=60+Math.random()*80;
    parts.push({ x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, life:1, ml:.5+Math.random()*.3, r:3+Math.random()*4, col:Math.random()<.5?'#f9a825':'#fff' });
  }
}
function tickP(dt) { parts = parts.filter(p=>p.life>0); parts.forEach(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=120*dt;p.life-=dt/p.ml;}); }
function drawP()   { parts.forEach(p=>{C.save();C.globalAlpha=Math.max(0,p.life);C.fillStyle=p.col;C.beginPath();C.arc(p.x,p.y,p.r*Math.max(0,p.life),0,Math.PI*2);C.fill();C.restore();}); }

// ── レンダリング ─────────────────────────────────────────
function render() {
  C.clearRect(0,0,W,H);
  drawBG(); drawNet(); drawKicker(kph,kpt);
  const cat=phase===3, cp=cat?Math.min(1,ctimer/CDUR):0;
  drawBall(bx,by,bprog,(phase===0||phase===1),cat&&cp>.2,cp);
  drawPosts(); drawKeeper(kox,koy,pdir,kat,cat,cp); drawP();
  document.getElementById('il').textContent = cfg().lb;
}

// ── ゲームループ ─────────────────────────────────────────
let raf = null, prevT = 0;

function tick(ts) {
  raf = requestAnimationFrame(tick);
  const dt = Math.min((ts-prevT)/1000, .05); prevT = ts;
  confTick(dt);
  if (state !== 1) { render(); return; }
  tickP(dt);

  if (phase === 0) {
    rtimer += dt;
    if (rtimer >= .6) {
      shot = SHOTS[Math.floor(Math.random()*SHOTS.length)];
      wtimer=0; wtime=cfg().wu; phase=1; kph=1; kpt=0;
      const bs=bStart(); bx=bs.x; by=bs.y; bprog=0; ctimer=0;
    }
  } else if (phase === 1) {
    wtimer += dt; kpt=Math.min(1,wtimer/wtime); kph=1;
    const bs=bStart(); bx=bs.x; by=bs.y;
    if (wtimer >= wtime) {
      // ── キック音 ──
      playSound('kick');
      phase=2; stimer=0; ttotal=cfg().tl; bprog=0; kph=2; kpt=0; shootT=performance.now();
    }
  } else if (phase === 2) {
    stimer += dt;
    const rp=Math.min(1,stimer/ttotal); bprog=eIn(rp);
    kph=rp<.2?2:3; kpt=rp<.2?rp/.2:(rp-.2)/.8;
    const bs=bStart(); bx=bs.x+(shot.x-bs.x)*bprog; by=bs.y+(shot.y-bs.y)*bprog;
    if (pdir) { kat=Math.min(1,kat+dt*4.5); kox=JUMPS[pdir].dx*eOut(kat); koy=JUMPS[pdir].dy*eOut(kat); }
    if (stimer >= ttotal) resolve();
  } else if (phase === 3) {
    ctimer += dt;
    const cp2=Math.min(1,ctimer/CDUR);
    const ax=KCX+kox, ay=KCY+koy-20;
    if (cp2 < .4) { const t=eOut3(cp2/.4); bx=shot.x+(ax-shot.x)*t; by=shot.y+(ay-shot.y)*t; }
    else { bx=ax; by=ay; }
    if (cp2 >= 1) { phase=5; stimer=0; }
  } else if (phase === 4) {
    stimer += dt; if (stimer >= .6) { phase=5; stimer=0; }
  } else if (phase === 5) {
    stimer += dt; if (stimer >= .5) nextRound();
  }
  render();
}

function resolve() {
  const ok = isSave(shot.side, pdir);
  const idx = shotN; shotN++;
  const rd = document.getElementById('rd');
  if (pdir && pdir !== 'stay' && shootT > 0) {
    const ms = Math.round(performance.now()-shootT);
    rd.textContent = `反応 ${ms}ms`;
    setTimeout(() => { rd.textContent = ''; }, 1400);
  }
  const fl=document.getElementById('rf'), rt=document.getElementById('rt');
  if (ok) {
    saved++; streak++; results[idx] = 'save';
    rt.textContent='SAVE!'; rt.style.color='#69f0ae';
    fl.style.background='rgba(105,240,174,.08)';
    fl.classList.add('show'); setTimeout(()=>fl.classList.remove('show'), 500);
    spawnP(shot.x, shot.y); ctimer=0; phase=3;
    // ── キャッチ音 ──
    playSound('catch');
  } else {
    miss++; streak=0; results[idx] = 'goal';
    rt.textContent='GOAL!'; rt.style.color='#ff5252';
    fl.style.background='rgba(255,82,82,.10)';
    fl.classList.add('show'); setTimeout(()=>fl.classList.remove('show'), 650);
    phase=4; stimer=0;
    // ── ゴール音（ネット音） ──
    playSound('goal');
  }
  updHUD(); updSI();
  if (saved >= 3) setTimeout(doWin, 800);
  else if (miss >= 3) setTimeout(doLose, 600);
}

function nextRound() {
  if (state !== 1) return;
  phase=0; rtimer=0; shot=null; pdir=null; ctimer=0;
  kox=0; koy=0; kat=0; kph=0; kpt=0;
  const bs=bStart(); bx=bs.x; by=bs.y;
  bprog=0; shootT=0; parts=[];
}

function doWin()  { state=2; document.getElementById('wo').classList.add('show'); CC.width=CC.offsetWidth; CC.height=CC.offsetHeight; confInit(); }
function doLose() { state=3; buildLG('lgr'); document.getElementById('go').style.display='flex'; }

function startGame(l) {
  confStop();
  lv=l||selLv; saved=0; miss=0; streak=0; shotN=0; results=Array(5).fill(null);
  phase=0; rtimer=0; shot=null; pdir=null; ctimer=0;
  kox=0; koy=0; kat=0; kph=0; kpt=0; bprog=0; shootT=0; parts=[];
  const bs=bStart(); bx=bs.x; by=bs.y;
  document.getElementById('rd').textContent = '';
  document.getElementById('to').style.display = 'none';
  document.getElementById('go').style.display = 'none';
  document.getElementById('wo').classList.remove('show');
  document.getElementById('il').textContent = cfg().lb;
  updHUD(); updSI(); state=1;
  if (!raf) { prevT=performance.now(); requestAnimationFrame(t=>{prevT=t; tick(t);}); }
}

function goTitle() {
  confStop();
  document.getElementById('wo').classList.remove('show');
  document.getElementById('go').style.display = 'none';
  document.getElementById('to').style.display = 'flex';
  state = 0;
}

function input(d) {
  if (state !== 1) return;
  if (phase !== 1 && phase !== 2) return;
  if (pdir) return;
  pdir = d;
  if (phase === 1) {
    // ウィンドアップ中に入力 → 即シュート開始
    playSound('kick');
    phase=2; stimer=0; ttotal=cfg().tl; bprog=0; kph=2; kpt=0; shootT=performance.now();
  }
  document.querySelectorAll('.cb').forEach(b => {
    if (b.dataset.d === d) { b.classList.add('pr'); setTimeout(()=>b.classList.remove('pr'), 180); }
  });
}

// ── イベントリスナー ─────────────────────────────────────
document.querySelectorAll('.cb').forEach(b => b.addEventListener('pointerdown', () => input(b.dataset.d)));
document.addEventListener('keydown', e => {
  const map = {
    'ArrowLeft':'left', 'ArrowRight':'right', 'ArrowUp':'up',
    'a':'left', 'd':'right', 'w':'up',
    'A':'left', 'D':'right', 'W':'up',
  };
  if (map[e.key]) { e.preventDefault(); input(map[e.key]); }
});

// AudioContext の resume（ユーザー操作契機）
document.getElementById('stb').onclick = () => { AudioCtx.resume(); startGame(selLv); };
document.getElementById('reb').onclick = () => { AudioCtx.resume(); startGame(selLv); };
document.getElementById('wb').onclick  = goTitle;

// ── 初期描画 ─────────────────────────────────────────────
(() => {
  const bs=bStart(); bx=bs.x; by=bs.y;
  C.clearRect(0,0,W,H); drawBG(); drawNet(); drawKicker(0,0);
  drawBall(bx,by,0,true,false,0); drawPosts(); drawKeeper(0,0,null,0,false,0);
})();
updHUD(); updSI();
