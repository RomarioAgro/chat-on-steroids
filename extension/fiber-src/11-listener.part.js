
  const listener = (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || ![ASK, 'clf-picker-ask', 'clf-plugin-ask', 'clf-branch-ask', 'clf-edit-ask'].includes(data.source)) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    adoptAppNames(data.apps);
    adoptAppIds(data.appIds);
    const previousPaths = currentPaths;
    currentPaths = new WeakMap();
    try {
    if (data.source === 'clf-branch-ask') {
      let marked = 0;
      try { marked = markBranchNewChat(nonce); } catch { /* An unknown menu shape marks nothing. */ }
      post({ source: 'clf-branch-reply', nonce, v: 1, marked }, location.origin);
      return;
    }
    if (data.source === 'clf-edit-ask') {
      let marked = 0;
      try { marked = markQuestionEdit(nonce, data.messageId); } catch { /* An unknown turn shape marks nothing. */ }
      post({ source: 'clf-edit-reply', nonce, v: 1, marked }, location.origin);
      return;
    }
    if (data.source === 'clf-plugin-ask') {
      let plugin = null;
      try { plugin = pluginSnapshot(); } catch { /* Unrecognized installed settings. */ }
      post({ source: 'clf-plugin-reply', nonce, v: 1, plugin }, location.origin);
      return;
    }
    if (data.source === 'clf-picker-ask') {
      let picker = null;
      try { picker = pickerSnapshot(); } catch { /* Unknown provider shape fails closed. */ }
      post({ source: 'clf-picker-reply', nonce, v: 1, picker }, location.origin);
      return;
    }
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk: false, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out and keeps ChatGPT's labels.
      }
    }
    } finally { currentPaths = previousPaths; }
  };
  // Re-execution is a repair, not a marker check. A stale primitive marker could survive
  // while its listener did not, so keep the actual listener and always replace it.
  const prior = window[ACTIVE_HELPER];
  if (prior && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Installing the replacement below is still the only useful recovery action.
    }
  }
  window.addEventListener('message', listener);
  window[ACTIVE_HELPER] = { version: VERSION, listener };
})();
