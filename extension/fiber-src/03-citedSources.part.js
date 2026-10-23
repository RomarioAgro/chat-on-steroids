  function citedSources(sections) {
    const byMessage = new Map();
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      let pills;
      try { pills = sections[sectionAt].querySelectorAll('a[data-testid="chatgpt-citation"]'); } catch { continue; }
      for (let at = 0; at < pills.length && at < 128; at++) {
        let fiber = null;
        try { fiber = fiberOf(pills[at]); } catch { fiber = null; }
        let sources = null, reference = null, context = null;
        for (let depth = 0; fiber && depth < 16 && !(sources && context); depth++, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          if (!sources && Array.isArray(props.sources)) sources = props.sources;
          if (!context && props.reference && props.turnContext && typeof props.turnContext === 'object') {
            reference = props.reference;
            context = props.turnContext;
          }
        }
        const list = context && Array.isArray(context.contentReferences) ? context.contentReferences : null;
        const index = list ? list.indexOf(reference) : -1;
        const messageId = context && typeof context.messageId === 'string' && context.messageId.length <= 200 ? context.messageId : null;
        if (!sources || index < 0 || !messageId) continue;
        const kept = [];
        for (const source of sources.slice(0, 8)) {
          if (!source || typeof source !== 'object') continue;
          const url = typeof source.url === 'string' && source.url.length <= 2000 && /^https?:\/\//i.test(source.url) ? source.url : null;
          if (!url) continue;
          const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
          const label = text(source.label, 80), snippet = text(source.snippet, 300);
          // ChatGPT keeps publication dates in epoch seconds.
          const date = typeof source.pubDate === 'number' && isFinite(source.pubDate) && source.pubDate > 0
            ? Math.round(source.pubDate < 1e10 ? source.pubDate * 1000 : source.pubDate) : 0;
          kept.push({ title: text(source.title, 300), url, ...(label ? { source: label } : {}),
            ...(date ? { date } : {}), ...(snippet ? { snippet } : {}) });
        }
        if (!kept.length) continue;
        const references = byMessage.get(messageId) || [];
        if (references.length < 32 && !references.some(entry => entry.index === index)) references.push({ index, sources: kept });
        byMessage.set(messageId, references);
      }
    }
    return byMessage;
  }

  function renderedMessagesOf(sections, messages, budget, exactAnchors, conversationId) {
    const assistantCandidates = authoredAssistantMessages(messages, budget);
    const userCandidates = authoredUserMessages(messages, budget);
    if (assistantCandidates.length === 0 && userCandidates.length === 0) return [];

    const blocks = [];
    const blockSections = [];
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(MARKDOWN);
      } catch {
        continue;
      }
      for (let at = 0; at < found.length; at++) {
        const block = found[at];
        if (block.closest && (block.closest(TOOL) || block.closest(OWN_SURFACES))) continue;
        const parent = block.parentElement && block.parentElement.closest ? block.parentElement.closest(MARKDOWN) : null;
        if (parent && section.contains(parent)) continue;
        blocks.push(block);
        blockSections.push(sectionAt);
      }
    }

    const used = new Set();
    const ids = [];
    for (let at = 0; at < blocks.length; at++) {
      const block = blocks[at];
      let id = null;
      try {
        const holder = block.closest && block.closest('[data-message-id]');
        id = holder ? str(holder.getAttribute('data-message-id')) : null;
        if (!id && conversationId) {
          // GPT-6's DIL wrapper may expose its owner only here, not on a
          // data-message-id parent. Match both identities, never the DOM order.
          const selected = block.closest && block.closest(
            '[data-chatgpt-selection-message-id][data-chatgpt-selection-conversation-id]');
          if (selected?.getAttribute('data-chatgpt-selection-conversation-id') === conversationId) {
            id = str(selected.getAttribute('data-chatgpt-selection-message-id'));
          }
        }
      } catch {
        id = null;
      }
      if (!id) {
        try {
          const fiber = fiberOf(block);
          if (fiber) id = messageOf(fiber, assistantCandidates, conversationId);
        } catch {
          id = null;
        }
      }
      let known = false;
      for (let c = 0; c < assistantCandidates.length; c++) if (assistantCandidates[c].id === id) known = true;
      if (!known) id = null;
      if (id) used.add(id);
      ids.push(id);
    }
    // Only direct native/Fiber identity can authorize DOM placement. The optional
    // HTML attachment fallbacks below must never become mutation anchors.
    for (let at = 0; at < ids.length; at++) {
      const id = ids[at];
      if (id && ids.filter(value => value === id).length === 1) exactAnchors.set(blocks[at], id);
    }

    const freeBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) freeBlocks.push(at);
    const freeCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) freeCandidates.push(assistantCandidates[c]);
    }

    // The live 2026-08-19 page no longer exposes a message id on authored Markdown blocks.
    // Attach HTML by exact visible text only when the equality is unique in both directions.
    for (let c = 0; c < freeCandidates.length; c++) {
      const candidate = freeCandidates[c];
      const wanted = visibleText(candidate.rawText);
      if (!wanted) continue;
      let match = -1;
      let count = 0;
      for (let b = 0; b < freeBlocks.length; b++) {
        const blockAt = freeBlocks[b];
        let text = '';
        try {
          text = visibleText(blocks[blockAt] && blocks[blockAt].textContent);
        } catch {
          text = '';
        }
        if (text !== wanted) continue;
        match = blockAt;
        count += 1;
      }
      if (count !== 1) continue;
      let candidateCount = 0;
      for (let other = 0; other < freeCandidates.length; other++) {
        if (visibleText(freeCandidates[other].rawText) === wanted) candidateCount += 1;
      }
      if (candidateCount !== 1) continue;
      ids[match] = candidate.id;
      used.add(candidate.id);
    }

    const remainingBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) remainingBlocks.push(at);
    const remainingCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) remainingCandidates.push(assistantCandidates[c]);
    }
    if (remainingBlocks.length === remainingCandidates.length) {
      for (let at = 0; at < remainingBlocks.length; at++) ids[remainingBlocks[at]] = remainingCandidates[at].id;
    }

    // One canonical record per model message whether or not HTML could be attached.
    const out = [];
    const cited = citedSources(sections);
    for (let c = 0; c < assistantCandidates.length; c++) {
      const references = cited.get(assistantCandidates[c].id);
      out.push({
        messageId: assistantCandidates[c].messageId,
        rawMessageId: assistantCandidates[c].id,
        role: 'assistant',
        stable: assistantCandidates[c].stable,
        order: assistantCandidates[c].order,
        createTime: assistantCandidates[c].createTime,
        ...(assistantCandidates[c].resolvedModel ? { resolvedModel: assistantCandidates[c].resolvedModel } : {}),
        ...(references ? { references } : {}),
        rawText: assistantCandidates[c].rawText,
        renderedHtml: ''
      });
    }
    for (let c = 0; c < userCandidates.length; c++) {
      out.push({
        messageId: userCandidates[c].messageId,
        rawMessageId: userCandidates[c].id,
        role: 'user',
        stable: true,
        order: userCandidates[c].order,
        createTime: userCandidates[c].createTime,
        rawText: userCandidates[c].rawText,
        ...(userCandidates[c].markdown ? { markdown: true } : {}),
        ...(userCandidates[c].attachments ? { attachments: userCandidates[c].attachments } : {}),
        ...(userCandidates[c].parentId ? { parentId: userCandidates[c].parentId, parentExact: userCandidates[c].parentExact === true } : {}),
        renderedHtml: ''
      });
    }
    for (let at = 0; at < blocks.length; at++) {
      const id = ids[at];
      if (!id) continue;
      let target = -1;
      for (let c = 0; c < out.length; c++) if (out[c].rawMessageId === id) target = c;
      if (target < 0 || out[target].renderedHtml) continue;
      const block = blocks[at];
      let renderedHtml = '';
      try {
        // All of the markup or none of it. Cutting HTML at a character count cuts it mid-tag,
        // and ChatGPT's code blocks carry several hundred characters of wrapper chrome around
        // a few lines of code — so a cut lands inside one often, and everything after it is
        // lost while the visible remainder ends as an unclosed box. The canonical raw text is
        // always carried beside this, so an absent capture costs presentation, never content.
        const markup = block.innerHTML;
        if (markup.length <= Math.min(MAX_RENDERED_HTML, budget.remaining)) {
          renderedHtml = budgetedText(markup, budget, MAX_RENDERED_HTML);
        } else if (out[target].role === 'assistant' && id === turnEndMessageId(messages) &&
                   exactAnchors.get(block) === id) {
          // The native model text remains the canonical answer (#1205). For a
          // uniquely owned completed answer, save its visible long-form prose too.
          // A positional/ambiguous match cannot authorize this larger capture.
          const visible = typeof block.innerText === 'string' && block.innerText.trim()
            ? block.innerText : block.textContent || '';
          const escaped = visible.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
          const compact = `<div>${escaped}</div>`;
          if (visible.trim() && compact.length <= Math.min(MAX_LARGE_FINAL_HTML, budget.remaining)) {
            renderedHtml = budgetedText(compact, budget, MAX_LARGE_FINAL_HTML);
          }
        }
      } catch {
        renderedHtml = '';
      }
      if (renderedHtml) {
        out[target].renderedHtml = renderedHtml;
        // This is rendered ownership, not model identity: the message id above came from the
        // Fiber/model join, and this ordinal says which exact sibling section supplied its
        // unique visible block. content.js uses it only as corroboration for a completed-message
        // action when end_turn is missing; no unique rendered join means null/fail closed.
        out[target].sectionIndex = blockSections[at];
      }
    }
    out.sort((left, right) => left.order - right.order);
    return out;
  }

  /**
   * Visible ChatGPT-native activity, keyed by the thought object that owns the rendered row.
   *
   * The label is display data only. React may replace the DOM row or rewrite its text from
   * "Inspecting" to "Inspected"; neither can create a new record because the identity is the
   * page-model thought `message.id`. If two simultaneously rendered rows claim one thought
   * with different labels (a transition/reparent race), that scan is ambiguous and emits
   * neither version. The next stable scan reconciles it.
   */
  function nativeActivitiesOf(sections, messages, exactThoughtRows) {
    const thoughtIds = new Set();
    const thoughtOrder = new Map();
    for (let at = 0; at < messages.length; at++) {
      if (!thoughtMessage(messages[at])) continue;
      const id = str(messages[at].id);
      if (id) {
        thoughtIds.add(id);
        thoughtOrder.set(id, at);
      }
    }
    if (thoughtIds.size === 0) return { events: [], notifications: [] };

    const held = [];
    const notificationIds = new Set();
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(TOOL);
      } catch {
        continue;
      }
      const rows = [];
      const candidates = new Set(found);
      const nestedParents = new Set();
      for (let at = 0; at < found.length; at++) {
        const row = found[at];
        let parent = row && row.parentElement;
        while (parent && parent !== section) {
          if (candidates.has(parent)) nestedParents.add(parent);
          parent = parent.parentElement;
        }
      }
      for (let at = 0; at < found.length; at++) {
        if (!nestedParents.has(found[at])) rows.push(found[at]);
      }

      for (let at = 0; at < rows.length; at++) {
        const row = rows[at];
        try {
          if (row.closest && row.closest(OWN_SURFACES)) continue;
          if ((row.querySelector && row.querySelector(CONNECTOR)) || (row.closest && row.closest(CONNECTOR))) continue;
          if (row.querySelector && row.querySelector(MARKDOWN)) continue;
        } catch {
          continue;
        }
        const label = visibleText(row.textContent).slice(0, 300);
        let activity = null;
        try {
          const fiber = fiberOf(row);
          if (fiber) activity = thoughtItemOf(fiber, thoughtIds);
        } catch {
          activity = null;
        }
        if (!activity) continue;
        // Presentation identity is independent from label stability. React can keep the same
        // typed thought item mounted twice while changing its caption; both exact DOM copies
        // remain safe suppression targets even though the recorder must refuse the conflicting
        // display text for this scan.
        exactThoughtRows.set(row, activity.messageId);
        notificationIds.add(activity.messageId);
        // The native icon/empty layout mounts before its caption. Typed identity
        // already proves what may be suppressed; only recording needs text.
        if (!label) continue;

        let prior = null;
        for (let entryAt = 0; entryAt < held.length; entryAt++) {
          if (held[entryAt].messageId === activity.messageId) prior = held[entryAt];
        }
        if (!prior) {
          held.push({
            messageId: activity.messageId,
            label,
            order: thoughtOrder.get(activity.thoughtMessageId),
            conflicted: false
          });
        } else if (prior.label !== label) {
          prior.conflicted = true;
        }
      }
    }
    const out = [];
    for (let at = 0; at < held.length; at++) {
      if (!held[at].conflicted) {
        out.push({ messageId: held[at].messageId, label: held[at].label, order: held[at].order });
      }
    }
    return {
      events: out,
      notifications: [...notificationIds].slice(0, MAX_CALLS).map(messageId => ({
        messageId,
        kind: 'thought_notification'
      }))
    };
  }

  /**
   * The connector request this row stands for, or null if `message` is not one.
   *
   * A connector request is an assistant message whose `recipient` names the API tool
   * bridge. The tool is at the front of its content, which is *nearly* JSON: the live page
   * stores the payload truncated — `Unterminated string in JSON at position 741` on a
   * routine call — so parsing it fails on most rows, and the old fallback of naming the row
   * after the recipient turned every one of those into `call_tool`, a tool this app does
   * not have. The path is read off the front of the string instead, which survives the
   * truncation because it is the first field, and nothing else in the payload is looked at.
   */
