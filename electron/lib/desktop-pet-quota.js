/* 桌宠账户 HUD：复用主窗余额展示快照，只呈现数值，不读取账户配置。 */
(function () {
  'use strict';
  var key='';
  var compact=document.getElementById('pet-balance');
  var value=document.getElementById('pet-balance-value');
  var total=document.getElementById('pet-wallet-total');
  var accounts=document.getElementById('pet-wallet-accounts');

  /** 展示主窗筛选后的当前大脑额度；快照仅含其所属厂商，保留积分和百分比原单位。 */
  function paint(snapshot) {
    accounts.textContent='';
    if (!snapshot) {
      value.textContent='暂无余额数据';
      total.textContent='暂无余额数据';
      compact.title='展开账户额度与对话';
      return;
    }
    var summary=snapshot.totals.length?snapshot.totals.join(' · '):snapshot.accounts[0].value;
    value.textContent=summary;
    total.textContent=summary;
    compact.title=snapshot.title+'\n点击展开账户额度与对话';
    for(var i=0;i<snapshot.accounts.length;i++) {
      var one=snapshot.accounts[i];
      var row=document.createElement('div');row.className='pet-account';
      var heading=document.createElement('div');heading.className='pet-account-heading';
      var name=document.createElement('span');name.textContent=one.name;
      var source=document.createElement('small');source.textContent=one.source;
      var amount=document.createElement('strong');amount.textContent=one.value;
      heading.appendChild(name);heading.appendChild(source);
      row.appendChild(heading);row.appendChild(amount);accounts.appendChild(row);
    }
  }

  /** 跟随会话绑定切换，拒绝其他窗口或标签页的余额推送，历史不回放旧快照。 */
  function receive(ev) {
    if(ev.kind==='history') { key=ev.sessionKey;paint(null);return; }
    if(ev.kind==='quota'&&ev.sessionKey===key)paint(ev.snapshot);
  }
  /** 点击余额展开现有聊天面板，不新建独立窗口。 */
  function expand() { window.desktopPet.call('expand',true); }
  compact.addEventListener('click',expand);
  window.floatBar.onEvent(receive);
})();
