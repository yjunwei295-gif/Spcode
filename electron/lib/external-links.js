'use strict';

/** 网页及邮件链接交给系统默认程序，保留应用窗口和本地作品的当前页面。 */
const { shell } = require('electron');

/**
 * 判断链接是否应交给系统默认浏览器或邮件程序。
 * @param {string} url Electron 提供的完整目标地址。
 * @returns {boolean} HTTP、HTTPS 和原有邮件链接为 true；本地文件及页内导航不在此处分流。
 */
function isExternalLink(url) {
  return /^(https?:|mailto:)/i.test(url);
}

/**
 * 将网页新窗请求交给系统默认程序，不创建内置浏览器窗口。
 * @param {{url:string}} details Electron 的新窗请求，保留原 URL 的查询参数和片段。
 * @returns {{action:string}} 外部链接返回 deny；其他新窗请求保留 Electron 原有行为。
 * 系统调用的失败沿用主进程未处理拒绝诊断，不改为内置浏览器。
 */
function openExternalPopup(details) {
  if (!isExternalLink(details.url)) return { action: 'allow' };
  void shell.openExternal(details.url);
  return { action: 'deny' };
}

/**
 * 为应用页面接入默认浏览器的新窗与当前页导航处理。
 * @param {Electron.WebContents} contents 刚创建的主窗、小窗或可见作品页面。
 * @returns {void} 只登记事件，不加载页面；file/about 页面、片段和子资源继续在原页面使用。
 */
function bindExternalLinks(contents) {
  contents.setWindowOpenHandler(openExternalPopup);
  contents.on('will-navigate', openExternalNavigation);

  /** 当前页打开网页时先取消导航，再调用系统浏览器，避免替换聊天或作品页面。 */
  function openExternalNavigation(event, url) {
    if (!isExternalLink(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  }
}

module.exports = { bindExternalLinks, openExternalPopup };
