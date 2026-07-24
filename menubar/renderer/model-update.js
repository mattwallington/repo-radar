'use strict';
(async function () {
  const view = await window.modelNotice.getNotice();
  if (!view) { window.close(); return; }
  document.getElementById('title').textContent = view.title;
  document.getElementById('body').textContent = view.body;
  const bar = document.getElementById('buttons');
  const close = document.getElementById('close');
  for (const b of view.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    btn.addEventListener('click', () => window.modelNotice.sendAction(b.action));
    bar.insertBefore(btn, close);
  }
  // The custom Close control triggers the native window close, which main finalizes conservatively.
  close.addEventListener('click', () => window.close());
})();
