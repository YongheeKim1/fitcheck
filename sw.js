// 앱 파일을 캐시해 오프라인에서도 열리게 한다.
// 파일을 수정했으면 CACHE 버전을 올려야 사용자 기기에 새 버전이 반영된다.
const CACHE = 'fitcheck-v56';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'parse.js',
  'body.js',
  'garment.js',
  'tryon.js',
  'models.js',
  'avatar.js',
  'avatar3d.js',
  'wardrobe.js',
  'garmentsource.js',
  'color.js',
  'colorui.js',
  'config.js',
  'sync.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크 우선, 실패하면 캐시 (개발 중 수정 사항이 바로 보이도록)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 외부(CDN) 요청은 건드리지 않는다: OCR 언어 데이터는 Tesseract가 IndexedDB에 따로 캐시한다
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: 브라우저 HTTP 캐시에 남은 옛 파일 대신 항상 서버에 새 버전이 있는지 확인
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
