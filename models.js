'use strict';

// ---------- AI 보정(기기 안에서만): 빈 배경판(MI-GAN) + 입체 명암(Depth Anything V2 Small) ----------
// 모델 파일은 이 사이트(models/)에서, 실행기(onnxruntime-web)는 jsDelivr에서 받는다. 사진은 기기 밖으로 나가지 않는다.
// 처음 한 번 약 65MB(모델 55MB + 실행기 11MB)를 받고, 이후엔 브라우저 캐시를 쓴다.
const AIModels = (() => {
  const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  const MIGAN = 'models/migan_pipeline_v2.onnx';
  const DEPTH = 'models/depth_anything_v2_small_int8.onnx';
  let ortReady = null;
  const sessions = {};

  function loadOrt() {
    if (ortReady) return ortReady;
    ortReady = new Promise((resolve, reject) => {
      if (window.ort) { resolve(window.ort); return; }
      const s = document.createElement('script');
      s.src = ORT_URL + 'ort.wasm.min.js';
      s.onload = () => {
        ort.env.wasm.wasmPaths = ORT_URL;
        ort.env.wasm.numThreads = 1; // GitHub Pages는 교차 출처 격리가 없어 멀티스레드를 못 쓴다
        ort.env.wasm.proxy = true;   // 계산을 백그라운드 작업자(Web Worker)에서: 그동안 화면이 멈추지 않는다
        resolve(ort);
      };
      s.onerror = () => { ortReady = null; reject(new Error('AI 실행기를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); };
      document.head.append(s);
    });
    return ortReady;
  }

  async function session(path) {
    if (!sessions[path]) {
      sessions[path] = loadOrt().then((o) => o.InferenceSession.create(path, { executionProviders: ['wasm'] }))
        .catch((err) => { delete sessions[path]; throw err; });
    }
    return sessions[path];
  }

  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // 드러난 자리 메우기: 원본 사진에서 상자(box)만 잘라 MI-GAN으로 holeMask(1 = 메울 곳) 자리를 채운다.
  // 긴 변 384px 이하로 줄여 돌리고 결과 상자를 돌려준다(메울 곳만 골라 쓰는 건 garment.js)
  async function inpaintHole(canvas, holeMask0, box) {
    const W = canvas.width;
    const { x0, y0, x1, y1 } = box;
    // 메울 곳을 몇 px 넓힌다: 분할이 놓친 원래 옷 테두리를 AI가 참고하면 그 색이 구멍 안으로 번진다
    const holeMask = new Uint8Array(holeMask0.length);
    const rr = Math.max(3, Math.round(W / 150));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!holeMask0[y * W + x]) continue;
      for (let dy = -rr; dy <= rr; dy += 1) {
        const yy = y + dy; if (yy < y0 || yy > y1) continue;
        for (let dx = -rr; dx <= rr; dx += rr) { const xx = x + dx; if (xx >= x0 && xx <= x1) holeMask[yy * W + xx] = 1; }
      }
    }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const k = Math.min(1, 384 / Math.max(cw, ch)); // 메울 곳은 배경이라 이 정도면 충분하고, 폰에서 시간이 절반 가까이 준다
    const sw = Math.max(8, Math.round(cw * k)), sh = Math.max(8, Math.round(ch * k));
    const small = canvasOf(sw, sh);
    const sg = small.getContext('2d', { willReadFrequently: true });
    sg.drawImage(canvas, x0, y0, cw, ch, 0, 0, sw, sh);
    const px = sg.getImageData(0, 0, sw, sh).data;
    const img = new Uint8Array(3 * sw * sh), mask = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const j2 = y * sw + x, i2 = j2 * 4;
      img[j2] = px[i2]; img[sw * sh + j2] = px[i2 + 1]; img[2 * sw * sh + j2] = px[i2 + 2];
      // 줄인 픽셀 하나가 덮는 원본 칸 중 하나라도 메울 곳이면 메운다
      const ox0 = x0 + Math.floor(x / k), oy0 = y0 + Math.floor(y / k);
      const ox1 = Math.min(x1, x0 + Math.floor((x + 1) / k)), oy1 = Math.min(y1, y0 + Math.floor((y + 1) / k));
      let h = 0;
      for (let oy = oy0; oy <= oy1 && !h; oy++) for (let ox = ox0; ox <= ox1; ox++) if (holeMask[oy * W + ox]) { h = 1; break; }
      mask[j2] = h ? 0 : 255; // MI-GAN: 255 = 아는 곳, 0 = 메울 곳
    }
    const s2 = await session(MIGAN);
    const out = await s2.run({ image: new ort.Tensor('uint8', img, [1, 3, sh, sw]), mask: new ort.Tensor('uint8', mask, [1, 1, sh, sw]) });
    const res = out.result.data;
    const outImg = sg.createImageData(sw, sh);
    for (let q = 0; q < sw * sh; q++) {
      outImg.data[q * 4] = res[q]; outImg.data[q * 4 + 1] = res[sw * sh + q]; outImg.data[q * 4 + 2] = res[2 * sw * sh + q]; outImg.data[q * 4 + 3] = 255;
    }
    sg.putImageData(outImg, 0, 0);
    const patch = canvasOf(cw, ch);
    const pg = patch.getContext('2d');
    pg.imageSmoothingEnabled = true;
    pg.imageSmoothingQuality = 'high';
    pg.drawImage(small, 0, 0, cw, ch);
    return patch;
  }

  // 입체 명암: 깊이 → 표면 기울기 → 빛 방향과의 각도로 밝고 어두움(128 = 그대로). 사람 영역 밖은 128
  async function depthShade(canvas, scene) {
    const W = canvas.width, H = canvas.height;
    const S = 266; // 14의 배수. 518보다 약 4배 빠르다(몸 전체 굴곡만 쓰므로 이 정도면 충분)
    const c = canvasOf(S, S);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data;
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const inp = new Float32Array(3 * S * S);
    for (let j = 0; j < S * S; j++) for (let ch = 0; ch < 3; ch++) inp[ch * S * S + j] = (px[j * 4 + ch] / 255 - mean[ch]) / std[ch];
    const s = await session(DEPTH);
    const out = await s.run({ pixel_values: new ort.Tensor('float32', inp, [1, 3, S, S]) });
    const D0 = out.predicted_depth.data; // 클수록 가깝다(상대값)
    // 원래 옷의 잔주름까지 잡히면 새 옷이 울퉁불퉁해진다 → 크게 흐려 몸 전체의 굴곡만 남긴다(상자 흐림 두 번)
    const boxBlur = (src, r) => {
      const tmp = new Float32Array(S * S), dst = new Float32Array(S * S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let a = 0, n = 0;
        for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < S) { a += src[y * S + xx]; n++; } }
        tmp[y * S + x] = a / n;
      }
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let a = 0, n = 0;
        for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < S) { a += tmp[yy * S + x]; n++; } }
        dst[y * S + x] = a / n;
      }
      return dst;
    };
    const D = boxBlur(boxBlur(D0, 5), 5);
    const { cat, w, h } = scene;
    // 몸(피부·옷)만: 얼굴·머리와 배경은 깊이가 갑자기 바뀌어 옷에 얼룩 같은 명암이 생긴다
    const person = (x, y) => { const c2 = cat[Math.floor((y / S) * h) * w + Math.floor((x / S) * w)]; return c2 === 2 || c2 === 4; };
    // 기울기(중앙 차분)와 그 크기의 중앙값으로 정규화
    const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
    const mags = [];
    for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
      const j = y * S + x;
      if (!person(x, y)) continue;
      // 좌우 굴곡만 쓴다(몸은 세로로 선 원통에 가깝다). 위아래 기울기는 턱·목 경계에서 얼룩을 만든다.
      // 이웃이 몸 밖이면 그 경계는 건너뛴다(배경·얼굴과의 깊이 차이가 명암으로 들어오지 않게)
      if (!person(x - 1, y) || !person(x + 1, y)) continue;
      gx[j] = (D[j + 1] - D[j - 1]) / 2; gy[j] = 0;
      mags.push(Math.hypot(gx[j], gy[j]));
    }
    if (mags.length < 100) return null;
    mags.sort((a, b) => a - b);
    const scale = 0.6 / Math.max(1e-6, mags[Math.floor(mags.length * 0.5)]);
    // 경계(팔과 몸통 사이 등)의 급격한 기울기는 잘라 낸다(중앙값의 3배까지)
    const cap = mags[Math.floor(mags.length * 0.5)] * 3;
    for (let j = 0; j < S * S; j++) {
      const m = Math.hypot(gx[j], gy[j]);
      if (m > cap) { gx[j] *= cap / m; gy[j] *= cap / m; }
    }
    // 빛: 위쪽 앞에서, 좌우는 사진에서 잰 기울기(tilt<0이면 왼쪽이 밝다 → 빛이 왼쪽에서)
    const lx = Math.max(-0.7, Math.min(0.7, (scene.tilt || 0) * 1.5));
    const L = [lx, -0.45, 0.8];
    const ln = Math.hypot(...L);
    const shade = new Float32Array(S * S);
    let sum = 0, n = 0;
    for (let j = 0; j < S * S; j++) {
      const x = j % S, y = (j / S) | 0;
      if (!person(x, y)) { shade[j] = NaN; continue; }
      // 깊이가 가까울수록 크므로 표면 법선은 기울기의 반대 방향
      const nx = -gx[j] * scale, ny = -gy[j] * scale;
      const nl = Math.hypot(nx, ny, 1);
      const v = (nx * L[0] + ny * L[1] + 1 * L[2]) / (nl * ln);
      shade[j] = v; sum += v; n++;
    }
    const avg = sum / n;
    const out2 = g.createImageData(S, S);
    for (let j = 0; j < S * S; j++) {
      const v = Number.isNaN(shade[j]) ? 128 : 128 + Math.max(-30, Math.min(30, (shade[j] - avg) * 130));
      out2.data[j * 4] = out2.data[j * 4 + 1] = out2.data[j * 4 + 2] = v;
      out2.data[j * 4 + 3] = 255;
    }
    g.putImageData(out2, 0, 0);
    const big = canvasOf(W, H);
    const bg = big.getContext('2d');
    bg.imageSmoothingEnabled = true;
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(c, 0, 0, W, H);
    return big;
  }

  return { loadOrt, inpaintHole, depthShade };
})();
