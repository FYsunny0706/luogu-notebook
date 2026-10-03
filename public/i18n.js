/* 多语言运行时
   字典放在 locales.js（由 tools/build-i18n.mjs 从 locales/*.json 生成，先于本文件加载）。
   用法：
     t("key")               取当前语言的文案
     t("key", {n: 3})        替换 {n} 之类的占位符
     applyI18n(root)         把 [data-i18n] / [data-i18n-ph] / [data-i18n-title] 刷成当前语言
     setLang("en")           切换语言（会写进 <html lang>）
*/
(function () {
  var DICT = (window.__I18N_DICT__ || {});
  var FALLBACK = "zh-CN";
  var LANGS = [
    { id: "zh-CN", label: "简体中文", short: "简" },
    { id: "zh-TW", label: "繁體中文", short: "繁" },
    { id: "en", label: "English", short: "EN" },
  ];
  var current = FALLBACK;

  window.LANGS = LANGS;
  window.I18N_LANGS = LANGS;

  window.getLang = function () { return current; };

  window.setLang = function (id) {
    var ok = LANGS.some(function (l) { return l.id === id; });
    current = ok ? id : FALLBACK;
    try { document.documentElement.lang = current; } catch (e) {}
    try { localStorage.setItem("uiLang", current); } catch (e) {}
    return current;
  };

  /* 首屏语言：先读浏览器里存的那份。
     app.js 在脚本求值阶段就会调用 t()（例如默认笔记本名），
     所以必须在这里、也就是 app.js 之前把语言定下来，否则会闪一下默认语言。 */
  try {
    var saved = localStorage.getItem("uiLang");
    if (saved && LANGS.some(function (l) { return l.id === saved; })) {
      current = saved;
      document.documentElement.lang = current;
    }
  } catch (e) {}

  window.t = function (key, vars) {
    var table = DICT[current] || {};
    var s = table[key];
    if (s === undefined) s = (DICT[FALLBACK] || {})[key];
    if (s === undefined) return key;
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] === undefined || vars[k] === null ? m : String(vars[k]);
      });
    }
    return s;
  };

  /** 把静态文案刷新成当前语言 */
  window.applyI18n = function (root) {
    root = root || document;
    var each = function (sel, apply) {
      var list = root.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) apply(list[i]);
    };
    each("[data-i18n]", function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    each("[data-i18n-ph]", function (el) { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
    each("[data-i18n-title]", function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
    return root;
  };

  /** 语言下拉框 */
  window.renderLangSelect = function (sel, onChange) {
    sel.innerHTML = LANGS.map(function (l) {
      return '<option value="' + l.id + '">' + l.label + "</option>";
    }).join("");
    sel.value = current;
    sel.onchange = function () {
      setLang(sel.value);
      if (onChange) onChange(current);
    };
  };
})();
