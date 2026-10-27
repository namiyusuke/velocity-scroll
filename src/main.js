import * as THREE from 'three';
import GUI from 'lil-gui';
import imageUrl from './sample.png';

// =====================================================================
//  構成：CPUでバネ物理を計算する
//   各頂点の「速度」と「現在位置」をJS配列で保持し、毎フレーム
//   力を積分して geometry の頂点位置を書き換える。
//   頂点を動かしても画像UVは元のまま貼られるので、絵が歪む。
// =====================================================================

// ── Three.js のセットアップ ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

// ピクセル単位・画面中心原点の正射影カメラ
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
const scene = new THREE.Scene();

// ── パラメータ（lil-gui で調整。物理ループが毎フレーム .v を読む） ──
const params = {
  uSpringK:              { v: 0.05,  min: 0.005, max: 0.2,  step: 0.005 },
  uDamping:              { v: 0.10,  min: 0,     max: 0.5,  step: 0.01 },
  uFriction:             { v: 0.90,  min: 0.6,   max: 1.0,  step: 0.01 },
  uForceIntensity:       { v: 0.05,  min: 0,     max: 0.2,  step: 0.005 },
  uMouseForce:           { v: 1.0,   min: 0,     max: 3,    step: 0.05 },
  uDistanceOfReaction:   { v: 180,   min: 20,    max: 500,  step: 5 },
  uMaxVelocity:          { v: 20,    min: 1,     max: 60,   step: 1 },
  uScrollForceIntensity: { v: 0.04,  min: 0,     max: 0.1,  step: 0.002 },
  uScrollForce:          { v: 1.0,   min: 0,     max: 3,    step: 0.05 },
};

// ── 画像 ──
const material = new THREE.MeshBasicMaterial();
let imageAspect = 1.5;

// cover 相当：Plane と画像の縦横比の差だけ UV を中心基準で縮める
function updateCover() {
  const tex = material.map;
  if (!tex) return;
  const pa = planeW / planeH;
  const [sx, sy] = pa > imageAspect
    ? [1, imageAspect / pa]  // Plane が横長 → 上下をトリミング
    : [pa / imageAspect, 1]; // Plane が縦長 → 左右をトリミング
  tex.center.set(0.5, 0.5);
  tex.repeat.set(sx, sy);
}

function setImage(tex) {
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const old = material.map;
  material.map = tex;
  material.needsUpdate = true;
  if (old && old !== tex) old.dispose();
  imageAspect = tex.image.width / tex.image.height;
  updateCover();
}

const loader = new THREE.TextureLoader();
loader.load(imageUrl, setImage);

// ── メッシュと物理状態（リサイズ時に作り直す） ──
let mesh;              // 表示メッシュ
let geoPos;           // geometry.attributes.position（現在位置 x,y,z）
let base;             // 各頂点の元の位置 (x,y) ×頂点数
let vel;              // 各頂点の速度 (x,y) ×頂点数
let planeW = 0, planeH = 0;

function build() {
  const W = innerWidth, H = innerHeight;
  const margin = W < 600 ? 16 : 64;
  planeW = W - margin * 2;
  planeH = H - margin * 2;

  camera.left = -W / 2; camera.right = W / 2;
  camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(W, H);

  // 約16pxごとに頂点を置く（細かいほど滑らかだがCPU負荷が上がる）
  const segX = Math.max(8, Math.round(planeW / 16));
  const segY = Math.max(8, Math.round(planeH / 16));

  if (mesh) { mesh.geometry.dispose(); scene.remove(mesh); }

  const geo = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
  const count = geo.attributes.position.count;
  const pos = geo.attributes.position.array;
  base = new Float32Array(count * 2);
  vel = new Float32Array(count * 2); // 速度は0から
  for (let i = 0; i < count; i++) {
    base[i * 2] = pos[i * 3];       // 元の x
    base[i * 2 + 1] = pos[i * 3 + 1]; // 元の y
  }
  geoPos = geo.attributes.position;

  mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);
  updateCover(); // Plane の縦横比が変わったので cover 倍率も更新
}
build();

// ── 入力：マウス（画面中心原点・上が+Y。画面外は遠くに飛ばす） ──
const mouse = { x: 1e5, y: 1e5 };
addEventListener('pointermove', e => {
  mouse.x = e.clientX - innerWidth / 2;
  mouse.y = innerHeight / 2 - e.clientY;
});
addEventListener('pointerleave', () => { mouse.x = 1e5; mouse.y = 1e5; });
document.documentElement.addEventListener('mouseleave', () => { mouse.x = 1e5; mouse.y = 1e5; });

// ── 入力：スクロール（ホイール量を擬似的に使う） ──
let scrollTarget = 0, scrollMag = 0;
addEventListener('wheel', e => {
  scrollTarget = Math.min(120, scrollTarget + Math.abs(e.deltaY) * 0.25);
}, { passive: true });

// ── UI（lil-gui） ──
const gui = new GUI({ title: 'Uniforms' });
for (const [k, p] of Object.entries(params)) {
  gui.add(p, 'v', p.min, p.max, p.step).name(k);
}

// ── アニメーションループ（CPUでバネ物理を計算） ──
function tick() {
  // スクロール量：ホイールで足された分を減衰させ、実際の値はなめらかに追従
  scrollTarget *= 0.92;
  scrollMag += (scrollTarget - scrollMag) * 0.12;

  // パラメータをフレーム頭でローカルに取り出す
  const springK = params.uSpringK.v;
  const damping = params.uDamping.v;
  const friction = params.uFriction.v;
  const forceI = params.uForceIntensity.v;
  const mouseF = params.uMouseForce.v;
  const R = params.uDistanceOfReaction.v;
  const maxV = params.uMaxVelocity.v;
  const scrollFI = params.uScrollForceIntensity.v;
  const scrollF = params.uScrollForce.v;

  const mx = mouse.x, my = mouse.y;
  const eps = 0.0001;
  const pos = geoPos.array;
  const n = base.length / 2;

  // スクロール波：Plane中央の縦ラインを巨大な円が下から上へ移動する
  const waveActive = scrollMag > 0.01;
  const waveY = -planeH + planeH * 1.5 * (scrollMag / 100);
  const waveR = planeH * 0.43;

  for (let i = 0; i < n; i++) {
    const ox = base[i * 2], oy = base[i * 2 + 1];
    let cx = pos[i * 3], cy = pos[i * 3 + 1];
    let vx = vel[i * 2], vy = vel[i * 2 + 1];

    // 復元力（バネ）＋ 減衰力
    let fx = (ox - cx) * springK - vx * damping;
    let fy = (oy - cy) * springK - vy * damping;

    // マウス反発：d(R-d)/R のドーナツ型分布で外向きに押す
    const dx = cx - mx, dy = cy - my;
    const d = Math.hypot(dx, dy);
    if (d < R) {
      const inv = 1 / (d + eps);
      const s = d * forceI * (R - d) / R * mouseF;
      fx += dx * inv * s;
      fy += dy * inv * s;
    }

    // スクロール波：波の中心円の中にいる頂点を外向きに押す
    if (waveActive) {
      const sx = cx, sy = cy - waveY;
      const sd = Math.hypot(sx, sy);
      if (sd < waveR) {
        const inv = 1 / (sd + eps);
        const s = sd * scrollFI * (waveR - sd) / waveR * scrollF;
        fx += sx * inv * s;
        fy += sy * inv * s;
      }
    }

    // 積分：v += F → 摩擦 → 上限クランプ
    vx = (vx + fx) * friction;
    vy = (vy + fy) * friction;
    const sp = Math.hypot(vx, vy);
    if (sp > maxV) { const k = maxV / sp; vx *= k; vy *= k; }

    // 位置を進めて書き戻す
    pos[i * 3] = cx + vx;
    pos[i * 3 + 1] = cy + vy;
    vel[i * 2] = vx;
    vel[i * 2 + 1] = vy;
  }
  geoPos.needsUpdate = true;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

// ── リサイズ対応 ──
let rt;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(build, 150); });
