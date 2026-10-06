/* 洛谷刷题本 service worker。
 *
 * 这个项目是「纯本地 + 每次保存立即改代码」，所以绝不能让缓存把旧代码或旧数据挡住。
 * 因此 SW 只做两件事：
 *   1) 满足浏览器「可安装」的条件（PWA 需要一个 fetch 处理器）
 *   2) 缓存一张「程序还没启动」的提示页 —— 关了黑窗口再点桌面图标时，显示这个而不是浏览器的报错
 *
 * 注意：只缓存 offline.html 这一个文件，页面和接口一律走网络，不做任何缓存。
 */
const OFFLINE_URL = "/offline.html";
const CACHE = "luogu-notebook-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // 清掉旧版本的离线缓存，然后立刻接管所有同源页面
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // 只在「打开页面」时兜底：连不上本地服务（程序没启动）就显示提示页
  if (req.mode !== "navigate") {
    event.respondWith(fetch(req));
    return;
  }
  event.respondWith(
    fetch(req).catch(() =>
      caches.match(OFFLINE_URL).then(
        (hit) =>
          hit ??
          new Response("程序还没启动，请先双击 start.bat（或桌面上的「洛谷刷题本」快捷方式）。", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
      )
    )
  );
});
