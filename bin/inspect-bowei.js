(() => {
  const head = document.querySelector('[data-qa^="channel_sidebar__section_heading_label__L086AD6NLHZ"]');
  if (!head) return { err: 'no bowei heading' };
  const item = head.closest('[data-qa="virtual-list-item"]');
  const out = [];
  let cur = item;
  let stopped = false;
  for (let i = 0; i < 30 && cur && !stopped; i++) {
    const headEl = cur.querySelector('[data-qa^="channel_sidebar__section_heading_label__"]');
    const isHead = !!headEl && !cur.querySelector('[data-qa="channel-sidebar-channel"]');
    const nameEl = cur.querySelector('[data-qa^="channel_sidebar_name_"]');
    out.push({
      i,
      isHead,
      headId: headEl ? headEl.getAttribute('data-qa') : null,
      chanName: nameEl ? nameEl.getAttribute('data-qa') : null,
      text: (cur.innerText || '').trim().slice(0, 30),
      transform: getComputedStyle(cur).transform,
      top: cur.style.top || getComputedStyle(cur).top,
      height: cur.offsetHeight,
      role: cur.getAttribute('role'),
      aria: cur.getAttribute('aria-label'),
      itemId: cur.getAttribute('data-qa'),
    });
    cur = cur.nextElementSibling;
    if (i > 0 && isHead) stopped = true; // next section heading
  }
  // Also describe the list container
  const list = item && item.parentElement;
  return {
    sectionItemQa: item && item.getAttribute('data-qa'),
    listQa: list && list.getAttribute('data-qa'),
    listCls: list && (list.className || '').slice(0, 70),
    listPosition: list && getComputedStyle(list).position,
    items: out,
  };
})();
