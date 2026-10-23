
  function turnsOf(scanToken) {
    const out = [];
    let sections;
    try {
      sections = [...document.querySelectorAll(TURN_SECTION)].filter(section => {
        if (section.matches?.(SEARCH_TURN_ANCHOR) && section.closest?.(SHELL_TURN)) return false;
        return !section.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`) &&
          !onKeptPage(section);
      });
    } catch {
      return out;
    }
    // A descriptor index is valid for one scan only. Stale stamps must disappear when a
    // still-mounted section becomes unreadable, but clearing every stamp up front is not
    // harmless: these attributes are observed by the isolated-world MutationObserver, so
    // remove+restore on every scan creates a self-sustaining scan/mutation loop. Build the
    // desired stamp set first, then change only attributes whose value actually differs.
    const desiredTurnStamps = new Map();
    const desiredMessageStamps = new Map();
    // An exchange whose user slot the shell did not render (see below, `data-clf-fiber-user`).
    const desiredUserStamps = new Map();
    // A chat's first exchange while it runs without its question (see below, `data-clf-fiber-first`).
    const desiredFirstStamps = new Map();
    const desiredThoughtStamps = new Map();
    const desiredImageStamps = new Map();
    const groups = [];
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      if (section.matches?.(SEARCH_TURN_ANCHOR)) {
        const container = section.closest?.('[data-turn-key]');
        const id = str(container?.getAttribute?.('data-turn-key')) || str(section.getAttribute('data-chatgpt-search-message-ids'));
        let members = [section];
        try { if (container) members = [...container.querySelectorAll(SEARCH_TURN_UNIT)]; } catch { members = [section]; }
        if (!members.includes(section)) members.unshift(section);
        groups.push({ turnId: id, sections: members, fiberSection: section, search: true });
        continue;
      }
      const id = section.matches?.(SHELL_TURN) ? str(section.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')) : str(section.getAttribute('data-turn-id'));
      const previous = groups[groups.length - 1];
      if (id && previous && previous.turnId === id) previous.sections.push(section);
      else groups.push({ turnId: id, sections: [section], fiberSection: section, search: false });
    }
    // Keep the latest user/assistant boundary even while reading older history.
    // Visible groups share the remaining slots; no additional scan lifecycle.
    const selected = new Set();
    for (let at = Math.max(0, groups.length - 2); at < groups.length; at++) selected.add(at);
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      for (let at = groups.length - 1; at >= 0 && selected.size < MAX_TURNS; at--) {
        if (selected.has(at)) continue;
        const visible = groups[at].sections.some(section => {
          try {
            const rect = section.getBoundingClientRect();
            return [rect.top, rect.bottom, rect.left, rect.right].every(Number.isFinite) &&
              rect.bottom > rect.top && rect.right > rect.left &&
              rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
          } catch { return false; }
        });
        if (visible) selected.add(at);
      }
    }
    for (let at = groups.length - 1; at >= 0 && selected.size < MAX_TURNS; at--) selected.add(at);
    const responseBudget = { remaining: MAX_RESPONSE_TEXT };
    for (const at of [...selected].sort((a, b) => a - b)) {
      const group = groups[at];
      const section = group.fiberSection || group.sections[0];
      let entry = null;
      try {
        const fiber = fiberOf(section);
        if (!fiber) continue;
        const shell = section.matches?.(SHELL_TURN) ? shellTurnSource(fiber, section, group.turnId) : null;
        if (section.matches?.(SHELL_TURN) && !shell) continue;
        const viewTurn = group.search ? turnViewOf(fiber) : null;
        const messages = shell ? shell.messages : viewTurn ? messagesFromTurnView(viewTurn) : turnMessagesOf(fiber);
        const codeReceipts = codeModeReceipts(messages || []);
        const codeModeCalls = (messages || []).filter(message => message && message.author &&
          message.author.role === 'assistant' && message.recipient === 'functions.exec').slice(0, MAX_CALLS)
          .map(message => ({ messageId: str(message.id), requestId: str(message.metadata && message.metadata.request_id),
            answered: codeReceipts.get(message.id) === true }));
        const legacyCalls = shell ? shell.calls : callsOf(messages, codeReceipts);
        const calls = legacyCalls.length ? legacyCalls : group.search ? viewCallsOf(fiber) : legacyCalls;
        const queries = shell ? shellQueries(fiber) : [];
        const conversation = shell ? shellConversation(queries, shell.entry.conversationId, conversationEvidenceOf(fiber)) : conversationEvidenceOf(fiber);
        const shellSightings = [];
        const metadata = shell ? shellRequestMetadata(fiber, queries, shell, conversation, shellSightings) : messages;
        const requests = requestIdsOf(metadata);
        if (shell) for (const call of calls) {
          const invocation = metadata.find(message => message.id === call.messageId);
          const source = invocation?.metadata.request_id ? invocation :
            metadata.find(message => message.id === shell.callSources.get(call.messageId)?.metadataId) || invocation;
          call.requestId = source?.metadata.request_id || null;
          call.createTime = source?.create_time ?? null;
        }
        const exactAnchors = new Map();
        const exactThoughtRows = new Map();
        const exactImageNodes = new Map();
        const turnBudget = { remaining: Math.min(MAX_TURN_TEXT, responseBudget.remaining) };
        const before = turnBudget.remaining;
        const renderedMessages = renderedMessagesOf(group.sections, messages, turnBudget, exactAnchors, conversation.conversationId);
        const nativeActivities = shell ? shellPublicActivity(shell, metadata, renderedMessages, turnBudget, section, exactAnchors) : nativeActivitiesOf(group.sections, messages, exactThoughtRows);
        responseBudget.remaining -= before - turnBudget.remaining;
        const generatedImages = generatedImagesOf(group.sections, messages, exactImageNodes, shell?.images);
        const activities = nativeActivities.events;
        const endMessageId = shell ? shell.endMessageId : turnEndMessageId(messages);
        const trace = shell ? shellTurnTrace(shell) : [];
        // The shell supplies the completed final item's own exact message id,
        // without the classic thought-parent/timestamp tuple. Preserve that
        // identity for handoff capture; streaming and cancelled items stay weak.
        if (shell && !conversation.conflict && conversation.conversationId && endMessageId) {
          const terminal = renderedMessages.find(message => message.role === 'assistant' && message.rawMessageId === endMessageId);
          if (terminal) terminal.stable = true;
        }
        if (
          codeModeCalls.length === 0 && calls.length === 0 &&
          requests.length === 0 &&
          renderedMessages.length === 0 &&
          activities.length === 0 && nativeActivities.notifications.length === 0 && generatedImages.length === 0 && !endMessageId && trace.length === 0
        ) continue;
        const index = out.length;
        entry = {
          index,
          turnId: group.turnId,
          conversationId: conversation.conversationId,
          conversationConflict: conversation.conflict,
          ...(shell && !conversation.conversationId ? { requestOwnerRequired: true } : {}),
          endMessageId,
          calls,
          codeModeCalls,
          requests,
          sightings: shell ? shellSightings : sightingsOf(metadata),
          messages: renderedMessages,
          activities,
          thoughtNotifications: nativeActivities.notifications,
          images: generatedImages,
          ...(trace.length ? { trace } : {}),
          ...(shellQuestion(shell) ? { question: shellQuestion(shell) } : {})
        };
        // The isolated-world renderer needs to know which visible section this exact Fiber
        // turn descriptor came from. Remember the desired ephemeral scan index now and apply
        // it after the scan, so a stable scan produces no attribute mutation at all.
        for (let sectionAt = 0; sectionAt < group.sections.length; sectionAt++) {
          const stamped = group.sections[sectionAt];
          if (stamped) desiredTurnStamps.set(stamped, `${scanToken}:${index}`);
        }
        if (shell) {
          for (const slot of shell.slots) {
            desiredTurnStamps.set(slot.node, `${scanToken}:${index}`);
            if (!conversation.conflict) desiredMessageStamps.set(slot.node, `${scanToken}:${index}:${encodeURIComponent(slot.id)}`);
            // A slot and its inner Markdown are one native message. Publishing
            // both as placement anchors would make every shell final ambiguous.
            for (const [node, id] of exactAnchors) if (id === slot.id) exactAnchors.delete(node);
          }
          // A fresh chat can draw its first exchange with no user slot at all, while the page
          // model holds the exact user message (2026-10-02: a resumed chat, a Goal helper and a
          // Temporary Chat). Without a slot there was no user message to read, so no Send receipt
          // and no turn. Name that one exact provider id on the exchange; isolated readers accept
          // it only under this scan's turn stamp. Several user messages stay unnamed.
          const users = renderedMessages.filter(message => message.role === 'user');
          const userSlot = shell.slots.some(slot => /:user$/.test(slot.node.getAttribute('data-content-search-unit-key') || ''));
          if (!conversation.conflict && !userSlot && users.length === 1 && users[0].rawMessageId) {
            desiredUserStamps.set(section, `${scanToken}:${index}:${encodeURIComponent(users[0].rawMessageId)}`);
          }
          // A chat's first exchange can hold no user message at all while it runs (2026-10-19:
          // ChatGPT draws it under `fallback-turn-0` with only its reasoning group until the turn
          // completes). Its place is exact even so: the conversation's first exchange answers the
          // conversation's first question. Say only that; the question's id stays the app's.
          if (!conversation.conflict && !userSlot && !users.length && shell.place?.parentId === 'root' &&
              shell.entry.turn.status === 'in_progress') desiredFirstStamps.set(section, `${scanToken}:${index}`);
          // Busy hint only, never a completion receipt or a Stop action target.
          const running = shell.entry.turn.status === 'in_progress' ? location.pathname : null;
          if (running && section.getAttribute('data-clf-shell-running') !== running) section.setAttribute('data-clf-shell-running', running);
          else if (!running) section.removeAttribute('data-clf-shell-running');
          /*
           * Whether this is a temporary chat, said by the page's own state rather than read off
           * an icon.
           *
           * `temporaryChatReady()` proves the mode from the checked glyph in the toolbar, which
           * is the only evidence a document has while nothing is mounted. Once a turn exists,
           * React holds the answer directly — measured on 2026-09-25 across both kinds of chat:
           * `entry.isTemporaryChat` is true on `/c/<id>?temporary-chat=true` and false on an
           * ordinary chat, at every depth it appears. A layout that stops drawing that glyph
           * therefore stops proving the mode, while this keeps proving it.
           *
           * Stamped with the pathname for the same reason the running hint is: a stamp left on a
           * section from another route must not answer for this one. Absent state leaves no
           * stamp at all, so the glyph remains the proof where React says nothing.
           */
          const temporary = shell.entry.isTemporaryChat === true ? location.pathname : null;
          if (temporary && section.getAttribute('data-clf-temporary-chat') !== temporary) section.setAttribute('data-clf-temporary-chat', temporary);
          else if (!temporary) section.removeAttribute('data-clf-temporary-chat');
        }
        if (!conversation.conflict) for (const [node, id] of exactAnchors) {
          desiredMessageStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(id)}`);
        }
        if (!conversation.conflict) for (const [node, id] of exactThoughtRows) {
          desiredThoughtStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(id)}`);
        }
        if (!conversation.conflict) for (const [node, image] of exactImageNodes) {
          desiredImageStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(image.messageId)}:${encodeURIComponent(image.assetId)}`);
        }
      } catch {
        // One unreadable turn must not cost the others their evidence.
        entry = null;
      }
      // `data-turn-id` is presentation metadata, not transcript identity. ChatGPT's current
      // virtualized renderer can omit it from a perfectly readable assistant section while
      // the underlying turn model still exposes exact conversation/message/request ids.
      // Dropping that descriptor made opening or scrolling an old chat lose precisely those
      // messages until another render happened to restore the attribute. Keep the descriptor;
      // content.js will simply leave local turn ownership unset when the page turn id is null.
      if (entry) out.push(entry);
    }
    const cleanupSections = new Set();
    try {
      for (const section of document.querySelectorAll(`${LEGACY_TURN_SECTION}, ${SHELL_TURN}, ${SEARCH_TURN_UNIT}, [data-clf-fiber-turn]`)) cleanupSections.add(section);
    } catch { for (const section of sections) cleanupSections.add(section); }
    for (const group of groups) for (const section of group.sections) cleanupSections.add(section);
    for (const section of cleanupSections) {
      try {
        if (!section || !section.getAttribute) continue;
        for (const node of section.querySelectorAll(`[data-clf-fiber-message], [data-content-search-unit-key], [data-markdown-text-style="assistant-message"], ${MARKDOWN}`)) {
          const wantedMessage = desiredMessageStamps.get(node);
          const currentMessage = node.getAttribute('data-clf-fiber-message');
          if (wantedMessage === undefined) {
            if (currentMessage !== null) node.removeAttribute('data-clf-fiber-message');
          } else if (currentMessage !== wantedMessage) node.setAttribute('data-clf-fiber-message', wantedMessage);
        }
        for (const node of section.querySelectorAll(`${TOOL}, [data-clf-fiber-thought]`)) {
          const wantedThought = desiredThoughtStamps.get(node);
          const currentThought = node.getAttribute('data-clf-fiber-thought');
          if (wantedThought === undefined) {
            if (currentThought !== null) node.removeAttribute('data-clf-fiber-thought');
          } else if (currentThought !== wantedThought) node.setAttribute('data-clf-fiber-thought', wantedThought);
        }
        for (const node of section.querySelectorAll(`${GENERATED_IMAGE}, [data-clf-fiber-image]`)) {
          const wantedImage = desiredImageStamps.get(node);
          const currentImage = node.getAttribute('data-clf-fiber-image');
          if (wantedImage === undefined) {
            if (currentImage !== null) node.removeAttribute('data-clf-fiber-image');
          } else if (currentImage !== wantedImage) node.setAttribute('data-clf-fiber-image', wantedImage);
          const blobSource = wantedImage !== undefined && (node.currentSrc || node.src)?.startsWith('blob:')
            ? node.currentSrc || node.src : null;
          if (blobSource === null) node.removeAttribute('data-clf-fiber-image-source');
          else if (node.getAttribute('data-clf-fiber-image-source') !== blobSource)
            node.setAttribute('data-clf-fiber-image-source', blobSource);
        }
        if (!desiredTurnStamps.has(section)) {
          section.removeAttribute('data-clf-shell-running');
          section.removeAttribute('data-clf-temporary-chat');
        }
        const wantedUser = desiredUserStamps.get(section);
        const currentUser = section.getAttribute('data-clf-fiber-user');
        if (wantedUser === undefined) {
          if (currentUser !== null) section.removeAttribute('data-clf-fiber-user');
        } else if (currentUser !== wantedUser) section.setAttribute('data-clf-fiber-user', wantedUser);
        const wantedFirst = desiredFirstStamps.get(section);
        const currentFirst = section.getAttribute('data-clf-fiber-first');
        if (wantedFirst === undefined) {
          if (currentFirst !== null) section.removeAttribute('data-clf-fiber-first');
        } else if (currentFirst !== wantedFirst) section.setAttribute('data-clf-fiber-first', wantedFirst);
        for (const stamped of [section, ...section.querySelectorAll('[data-content-search-unit-key], [data-chatgpt-search-unit-key]')]) {
          const wanted = desiredTurnStamps.get(stamped);
          const current = stamped.getAttribute('data-clf-fiber-turn');
          if (wanted === undefined) {
            if (current !== null && stamped.removeAttribute) stamped.removeAttribute('data-clf-fiber-turn');
          } else if (current !== wanted && stamped.setAttribute) {
            stamped.setAttribute('data-clf-fiber-turn', wanted);
          }
        }
      } catch {
        // One hostile/stale DOM node must not cost the remaining turns their evidence.
      }
    }
    return out;
  }

  /**
   * Answers a request from the isolated world.
   *
   * The rows are stamped with their index before the reply is sent, so the two worlds
   * agree on which descriptor belongs to which row without relying on both querying the
   * DOM at the same instant — React can re-render between the two.
   */
