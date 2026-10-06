/* 洛谷刷题本 service worker。
 * 这个项目是「纯本地 + 每次保存立即改代码」，绝不能让缓存把旧代码或旧数据挡住了。
 * 所以这里的 SW 只做一件事：为了满足浏览器的“可安装”条件而存在（PWA 需要一个 fetch 处理器）。
 * 策略：所有请求原样放行、不做任何缓存；页面每个请求都走网络。
 * service worker 本身更新后，浏览器默认会用新文件替换（无需我们处理旧缓存）。 */
self.addEventListener("install", () => {
  // 安装后立刻接管，不等旧页面关闭
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  // 立即接管所有同源页面，避免旧 SW 挡一次请求
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  // 不做缓存：直接放行到网络/本地服务
  event.respondWith(fetch(event.request));
});
