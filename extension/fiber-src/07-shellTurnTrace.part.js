  function shellTurnTrace(shell) {
    const out = [], budget = { remaining: MAX_TRACE_TEXT };
    for (const item of shell.entry.turn.items) {
      // The turn's answer stands outside its rounds; naming it keeps it from reading as one more sentence.
      if (item?.type === 'assistant-message' && item.phase === 'final_answer' && str(item.messageId)) {
        out.push({ kind: 'answer', id: str(item.messageId) });
        continue;
      }
      if (item?.type !== 'chatgpt-reasoning-group' || !Array.isArray(item.items) || item.reasoningRecap?.type === 'hide_all') continue;
      for (const step of item.items) {
        if (out.length >= MAX_TRACE_ITEMS) return out;
        if (step?.type === 'assistant-message') {
          const text = shellItemText(step).trim();
          if (!text || ONLY_CONTENT_REFERENCES.test(text)) continue;
          const id = str(step.messageId), said = budgetedText(text, budget, MAX_TRACE_SAY);
          if (said) out.push({ kind: 'say', ...(id ? { id } : {}), text: said, done: step.completed === true });
        } else if (step?.type === 'reasoning' && step.isTransient !== true && typeof step.content === 'string' && step.content.trim()) {
          if (step.presentation === 'preamble') {
            const said = budgetedText(step.content.trim(), budget, MAX_TRACE_SAY);
            if (said) out.push({ kind: 'say', text: said, done: step.completed !== false });
          } else if (step.presentation === 'thought') {
            const recap = budgetedText(visibleText(step.content), budget, MAX_TRACE_RECAP);
            if (recap) out.push({ kind: 'recap', text: recap });
          }
        } else if (step?.type === 'mcp-tool-call' && ownServerName(step.invocation?.server)) {
          const id = str(step.callId), tool = toolName(step.invocation?.tool);
          if (id && tool) out.push({ kind: 'call', id, tool, done: step.completed === true });
        } else if (step?.type === 'dynamic-tool-call' && step.tool === 'exec') {
          // ChatGPT's own code mode: one item for any number of this app's calls it makes.
          const id = str(step.callId);
          if (id) out.push({ kind: 'exec', id, done: step.completed === true });
        }
      }
    }
    // What ChatGPT says the turn is doing right now ("Comparing three layouts…"): the open thought of
    // the newest group, which becomes that round's recap once it closes. Only while the turn runs.
    if (shell.entry.turn.status !== 'complete') {
      const groups = shell.entry.turn.items.filter(item => item?.type === 'chatgpt-reasoning-group' && item.reasoningRecap?.type !== 'hide_all');
      const active = groups.at(-1)?.activeReasoning;
      const now = active && active.completed !== true && active.isTransient !== true && active.presentation === 'thought' &&
        typeof active.content === 'string' ? budgetedText(visibleText(active.content), budget, MAX_TRACE_RECAP) : '';
      if (now) out.push({ kind: 'now', text: now });
    }
    return out;
  }
  /** Translate only publicly identified items in the mounted exchange. Missing item ids
   * stay missing; a stopped turn does not manufacture replies to its tool calls. */
  /**
   * Where a shell turn's question sits in ChatGPT's message tree (Edit & resubmit, #365). The shell
   * model carries no parent ids, but the thread's ordered `entries` (a few levels up) does: the
   * question follows the previous turn's last message, and the first turn follows the root. Two
   * questions after the same message are versions of one: a thread holds one question after each
   * message. "root" is weaker, since a thread list that starts later would call its first turn the
   * root too; there only ChatGPT's versions control (its handler asks the versions endpoint) proves
   * it. ChatGPT draws that control only once the page is loaded again after an edit (live 2.1.41).
   */
  function shellQuestionPlace(fiber, entry, section) {
    let entries = null, index = -1;
    for (let at = fiber, up = 0; at && up < 40; up++, at = at.return) {
      const list = at.memoizedProps?.entries;
      if (!Array.isArray(list)) continue;
      // The same entry, or the same turn re-rendered as a new object; one match only.
      const matches = list.reduce((found, item, at) => item === entry || (item?.id && item.id === entry.id) ? [...found, at] : found, []);
      if (matches.length === 1) { entries = list; index = matches[0]; break; }
    }
    if (!entries || index < 0) return null;
    const previous = index > 0 ? entries[index - 1]?.turn?.messageIds : null;
    const parentId = index === 0 ? 'root' : Array.isArray(previous) && previous.length ? str(previous[previous.length - 1]) : null;
    if (!parentId) return null;
    let versioned = false;
    for (const button of section.querySelectorAll('button')) {
      if (button.closest('[data-turn-key]') !== section) continue;
      const onClick = fiberOf(button)?.memoizedProps?.onClick;
      if (typeof onClick === 'function' && /usesVersionsEndpoint/.test(Function.prototype.toString.call(onClick))) { versioned = true; break; }
    }
    return { parentId, versioned: versioned || parentId !== 'root' };
  }

  function shellTurnSource(fiber, section, turnId) {
    let entry = null, entryFiber = null;
    for (let at = fiber, up = 0; at && up < 16; up++, at = at.return) {
      if (Array.isArray(at.memoizedProps?.entry?.turn?.items)) { entry = at.memoizedProps.entry; entryFiber = at; break; }
    }
    if (!entry || !turnId || entry.id !== turnId || entry.turn.items.length > MAX_ROWS) return null;
    const place = shellQuestionPlace(entryFiber, entry, section);
    const messages = [], calls = [], slots = [], seen = new Set(), callSources = new Map(), executionIds = [], images = new Map();
    let lastAnswer = null, previousId = null;
    const remember = id => { if (!id || seen.has(id)) return false; seen.add(id); return true; };
    // GPT-6 (2026-10-12) writes each interim sentence as an assistant message inside the working
    // group while the turn runs. A top-level item owns its id; a nested copy of it is not read twice.
    const topLevel = new Set(entry.turn.items.filter(item => item?.type === 'assistant-message').map(item => str(item.messageId)).filter(Boolean));
    let work = 0;
    for (const [index, item] of entry.turn.items.entries()) {
      if (++work > MAX_ROWS) return null;
      if (item?.type === 'user-message' || item?.type === 'assistant-message') {
        const user = item.type === 'user-message', id = str(item.messageId) || (user ? str(item.serverMessageId) : null);
        if (!id) continue;
        if (!remember(id) || (user && item.serverMessageId && item.messageId && item.serverMessageId !== item.messageId)) return null;
        const role = user ? 'user' : 'assistant', text = user ? item.message : shellItemText(item);
        const final = !user && item.phase === 'final_answer';
        if (final) lastAnswer = item;
        const completed = final && item.completed === true && entry.turn.status === 'complete';
        messages.push({ id, author: { role }, content: { content_type: 'text', parts: [typeof text === 'string' ? text : ''] },
          channel: user ? null : final ? 'final' : 'commentary', end_turn: completed,
          status: completed ? 'finished_successfully' : 'in_progress',
          // The turn's place belongs to its first message. A message sent into the running answer
          // follows the message before it in this turn; given the turn's place it read as a version
          // of the turn's question, and Edit & resubmit folded that question away (2.1.41 round).
          metadata: !user ? {} : previousId ? { parent_id: previousId, clf_parent_exact: true }
            : place ? { parent_id: place.parentId, clf_parent_exact: place.versioned } : {} });
        previousId = id;
        const key = `${turnId}:${index}:${role}`;
        const nodes = [...section.querySelectorAll('[data-content-search-unit-key]')].filter(node =>
          node.closest('[data-turn-key]') === section && node.getAttribute('data-content-search-unit-key') === key);
        if (nodes.length === 1) slots.push({ node: nodes[0], id });
      } else if (item?.type === 'generated-image') {
        lastAnswer = item;
        const id = str(item.chatGptMessageId);
        const asset = typeof item.src === 'string' && /^sediment:\/\/(file_[A-Za-z0-9_-]{8,100})$/.exec(item.src)?.[1];
        if (!id || !asset || !Array.isArray(entry.turn.messageIds) || !entry.turn.messageIds.includes(id)) continue;
        images.set(item, asset);
        // Typed generated outputs are public tool media, never assistant prose.
        // Multiple assets may share their owning provider message.
        messages.push({ id, author: { role: 'tool' }, recipient: 'all', channel: 'final',
          status: item.status === 'completed' && item.isPreview !== true ? 'finished_successfully' : 'in_progress',
          content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer',
            asset_pointer: item.src, width: item.width, height: item.height }] } });
      } else {
        const steps = item?.type === 'chatgpt-reasoning-group' && Array.isArray(item.items) ? item.items : [item];
        for (const step of steps) {
          if (++work > MAX_ROWS) return null;
          if (step?.type === 'assistant-message' && item !== step) {
            // Interim prose whatever phase it carries: only a top-level answer can end the turn.
            const id = str(step.messageId), text = shellItemText(step);
            if (!id || topLevel.has(id) || !remember(id) || !text || ONLY_CONTENT_REFERENCES.test(text)) continue;
            messages.push({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] },
              channel: 'commentary', end_turn: false, status: step.completed === true ? 'finished_successfully' : 'in_progress', metadata: {} });
            continue;
          }
          if (step?.type === 'dynamic-tool-call' && step.tool === 'exec') {
            const id = str(step.callId);
            if (!id) continue;
            if (!remember(id) || executionIds.length >= MAX_CALLS) return null;
            executionIds.push(id);
            continue;
          }
          if (step?.type !== 'mcp-tool-call' || !ownServerName(step.invocation?.server)) continue;
          const id = str(step.callId), tool = toolName(step.invocation?.tool);
          if (!id || !tool) continue;
          if (!remember(id) || calls.length >= MAX_CALLS) return null;
          calls.push({ messageId: id, tool, order: calls.length, answered: step.completed === true, requestId: null, createTime: null });
          callSources.set(id, { id: str(step.widgetStateSource?.messageId), server: step.invocation.server });
        }
      }
    }
    // Media may share a provider message with other media, never an authored row
    // or local call. Keep malformed cross-kind identities out of the whole scan.
    if ([...images.keys()].some(item => seen.has(item.chatGptMessageId))) return null;
    // Image-only answers have no assistant final item. Both the selected public
    // images and the containing turn must finish; previews/retries cannot settle it.
    const imageAnswer = lastAnswer?.type === 'generated-image';
    const imageEnd = imageAnswer && entry.turn.status === 'complete' && images.has(lastAnswer) &&
      entry.turn.items.filter(item => item?.type === 'generated-image').every(item =>
        images.has(item) && item.status === 'completed' && item.isPreview !== true)
      ? lastAnswer.chatGptMessageId : null;
    return { entry, place, messages, calls, slots, callSources, executionIds, images,
      endMessageId: imageAnswer ? imageEnd : turnEndMessageId(messages) };
  }
  /**
   * Whether a node belongs to an earlier page ChatGPT keeps mounted but undisplayed in this tab.
   * After a Project resume the tab still holds the source chat that way; its turns name the
   * source conversation and must not be read as this page's (same rule as chatgpt-dom.js).
   */
  function onKeptPage(node) {
    for (let page = node?.closest?.('[data-app-shell-page-surface]'); page;
      page = page.parentElement?.closest('[data-app-shell-page-surface]')) {
      if (getComputedStyle(page).display === 'none') return true;
    }
    return false;
  }
