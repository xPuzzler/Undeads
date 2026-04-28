/* ──────────────────────────────────────────────────────────
   Floating skulls - creates its own container if missing and
   auto-injects drifting skulls on every page.
   ────────────────────────────────────────────────────────── */
(function () {
  function spawn () {
    // Create container if the page doesn't have one
    let host = document.querySelector('.skull-floaters');
    if (!host) {
      host = document.createElement('div');
      host.className = 'skull-floaters';
      host.setAttribute('aria-hidden', 'true');
      document.body.appendChild(host);
    }
    if (host.children.length) return;

    // Skulls + bats - universal emoji, no rendering issues
    const SYMBOLS = ['💀', '🦇'  ];
    const COUNT   = 10;
    for (let i = 0; i < COUNT; i++) {
      const el = document.createElement('span');
      el.className = 'skull-float';
      el.textContent = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      el.style.setProperty('--x',     Math.floor(Math.random() * 100) + '%');
      el.style.setProperty('--dur',   (14 + Math.random() * 16).toFixed(1) + 's');
      el.style.setProperty('--delay', (-1 * Math.random() * 10).toFixed(1) + 's');
      el.style.fontSize = (10 + Math.random() * 20) + 'px';
      el.style.opacity  = '0.13';
      host.appendChild(el);
    }
    // sit below every page element but still visible
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', spawn);
  } else {
    spawn();
  }
})();