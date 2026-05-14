/* Floating skulls + bats, injects on every page */
(function () {
  function spawn() {
    let host = document.querySelector('.skull-floaters');
    if (!host) { host = document.createElement('div'); host.className = 'skull-floaters'; host.setAttribute('aria-hidden','true'); document.body.appendChild(host); }
    if (host.children.length) return;
    const SYMBOLS = ['💀', '🦇'];
    for (let i=0; i<10; i++) {
      const el = document.createElement('span');
      el.className = 'skull-float';
      el.textContent = SYMBOLS[Math.floor(Math.random()*SYMBOLS.length)];
      el.style.setProperty('--x',     Math.floor(Math.random()*100)+'%');
      el.style.setProperty('--dur',   (14+Math.random()*16).toFixed(1)+'s');
      el.style.setProperty('--delay', (-1*Math.random()*10).toFixed(1)+'s');
      el.style.fontSize = (10+Math.random()*20)+'px';
      el.style.opacity = '0.13';
      host.appendChild(el);
    }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', spawn);
  else spawn();
})();
