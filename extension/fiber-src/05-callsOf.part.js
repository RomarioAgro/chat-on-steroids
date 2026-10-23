
  function callsOf(messages, codeReceipts) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    const answered = new Set();
    const resultParents = resultParentsOf(messages);
    // Results first, so a request can say whether its own answer has arrived. `parent_id`
    // is what pairs them; position does not, and pairing by position is how a row came to
    // sit over another tool's output.
    for (let at = 0; at < messages.length && answered.size < MAX_CALLS; at++) {
      const message = messages[at];
      const result = resultOf(message);
      if (!result || !ownResult(result)) continue;
      const parent = resultParents.get(message);
      if (parent) answered.add(parent);
    }

    const duplicated = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const request = requestOf(messages[at]);
      const completed = request ? null : completedCallOf(messages[at]);
      if ((!request || !ownRequestPath(request.path)) && !completed) continue;
      const tool = completed ? completed.tool : toolName(request.path);
      const id = completed ? completed.messageId : request.messageId;
      if (!tool || !id) continue;
      // An id reported twice is an ambiguity, not a second call, and it is dropped on
      // *both* sides: keeping the first would still hand the app one identity standing
      // for two different requests, which is the same piece of evidence spent twice.
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
      const hasResult = codeReceipts.has(id) ? codeReceipts.get(id) : Boolean(completed) || answered.has(id);
      out.push({
        messageId: id,
        tool,
        order: 0,
        answered: hasResult,
        // ChatGPT's own id for the request, and its own timestamp for when the request was
        // created. The app's existing stamp is when the *extension* observed the row, which
        // is a poll tick and jitters per tab; these are the only values on either side that
        // say which request this is and when it was actually issued.
        requestId: (completed || request).requestId || null,
        createTime: (completed || request).createTime
      });
    }

    const kept = [];
    for (let at = 0; at < out.length; at++) {
      if (duplicated.has(out[at].messageId)) continue;
      out[at].order = kept.length;
      kept.push(out[at]);
    }
    return kept;
  }

  /**
   * The per-turn call evidence for the assistant turns currently on screen.
   *
   * Read from the turn sections rather than from the connector rows, because the case this
   * exists for is the turn that rendered *no* row: climbing from a row cannot reach a turn
   * that has none, which is exactly the turn whose calls went missing.
   */
  /** Read the currently mounted query owner; never retain a client across navigation. */
  function shellQueries(fiber) {
    try {
      for (let at = fiber, up = 0; at && up < MAX_ROOT_DEPTH; up++, at = at.return) {
        const client = at.memoizedProps?.client;
        if (typeof client?.getQueryCache !== 'function') continue;
        const queries = client.getQueryCache()?.getAll();
        return Array.isArray(queries) && queries.length <= 512 ? queries : [];
      }
    } catch { /* Optional metadata must not cost the mounted transcript. */ }
    return [];
  }

  /** The September 2026 search-unit `turn.items[]` view model on this Fiber branch. */
  function turnViewOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.items)) return turn;
    }
    return null;
  }

  /** Projects only public user/final assistant bytes from the typed search-unit turn model. */
  function messagesFromTurnView(turn) {
    if (!turn || typeof turn !== 'object' || !Array.isArray(turn.items)) return null;
    const out = [], seen = new Set();
    for (const item of turn.items) {
      if (!item || typeof item !== 'object' || out.length >= MAX_CALLS) continue;
      if (item.type === 'user-message') {
        const id = str(item.messageId) || str(item.serverMessageId);
        const body = typeof item.message === 'string' ? item.message.slice(0, MAX_RENDERED_TEXT) : '';
        if (!id || seen.has(id) || !body) continue;
        seen.add(id);
        out.push({
          id, author: { role: 'user' }, recipient: 'all',
          ...(num(item.sentAtMs) !== null ? { create_time: item.sentAtMs / 1000 } : {}),
          content: { content_type: 'text', parts: [body] }, metadata: {}
        });
        continue;
      }
      if (item.type !== 'assistant-message') continue;
      const id = str(item.messageId) || str(item.latestMessageId);
      if (!id || seen.has(id)) continue;
      const body = typeof item.content === 'string' ? item.content.slice(0, MAX_RENDERED_TEXT) : '';
      const phase = str(item.phase), complete = item.completed === true;
      const terminal = complete && phase === 'final_answer' && turn.status === 'complete';
      const exchange = str(item.turnExchangeId);
      seen.add(id);
      out.push({
        id, author: { role: 'assistant' }, recipient: 'all',
        ...(phase === 'final_answer' ? { channel: 'final' } : {}),
        ...(num(item.sentAtMs) !== null ? { create_time: item.sentAtMs / 1000 } : {}),
        status: complete ? 'finished_successfully' : 'in_progress', end_turn: terminal,
        content: { content_type: 'text', parts: body ? [body] : [] },
        metadata: { message_type: 'next', ...(exchange ? { turn_exchange_id: exchange } : {}) }
      });
    }
    return out;
  }

  /**
   * Reads only allowlisted MCP call identity from the typed search-unit view.
   * Invocation arguments/results never cross the MAIN-world boundary.
   */
  function viewCallsOf(fiber) {
    const turn = turnViewOf(fiber);
    if (!turn) return [];
    const out = [], seen = new Set(), duplicated = new Set();
    const visit = items => {
      if (!Array.isArray(items) || out.length >= MAX_CALLS) return;
      for (const item of items) {
        if (!item || typeof item !== 'object' || out.length >= MAX_CALLS) continue;
        if (item.type === 'chatgpt-reasoning-group') { visit(item.items); continue; }
        if (item.type !== 'mcp-tool-call') continue;
        const invocation = item.invocation && typeof item.invocation === 'object' ? item.invocation : null;
        const app = invocation ? str(invocation.server) : null;
        const tool = invocation ? toolName(str(invocation.tool)) : null;
        const id = str(item.callId);
        if (!app || !ownServerName(app) || !tool || !id) continue;
        if (seen.has(id)) duplicated.add(id);
        seen.add(id);
        out.push({
          messageId: id,
          tool,
          order: out.length,
          answered: turn.status === 'complete',
          requestId: null,
          createTime: null
        });
      }
    };
    visit(turn.items);
    const kept = duplicated.size ? out.filter(call => !duplicated.has(call.messageId)) : out;
    for (let at = 0; at < kept.length; at++) kept[at].order = at;
    return kept;
  }
  /** Exact local/server pair only; a route or the latest cached chat is not a join. */
  function shellConversation(queries, localId, evidence) {
    if (evidence.conflict || !localId?.startsWith('local-chatgpt:')) return evidence;
    let found = evidence.conversationId;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'chatgpt-conversation-details' || key[1]?.clientConversationId !== localId) continue;
      const server = key[1].serverConversationId;
      if (typeof server !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server)) continue;
      if (found && found !== server) return { conversationId: null, conflict: true };
      found = server;
    }
    return { conversationId: found, conflict: false };
  }
  /** The native shell subscribes to its live mapping independently of the history
   * query (144961 / QH.C). Read published React values, never invoke store actions
   * or enumerate cached branches. The mounted owner and exact user id fence this
   * optional source before any message metadata can leave the helper. */
  function shellLiveMapping(fiber, entry) {
    const user = entry.turn.items.find(item => item?.type === 'user-message');
    const userId = str(user?.messageId) || str(user?.serverMessageId);
    if (!userId) return null;
    const snapshots = new Map();
    const inspected = new WeakSet();
    const value = (object, key) => object && typeof object === 'object'
      ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    let conflict = false;
    const inspect = candidate => {
      if (!candidate || typeof candidate !== 'object' || inspected.has(candidate)) return;
      inspected.add(candidate);
      const conversation = value(candidate, 'renderedConversation'), turns = value(candidate, 'renderedTurns');
      const mapping = value(conversation, 'mapping');
      if (!mapping || !Array.isArray(turns) || turns.length > 4096 ||
          turns.filter(turn => turn?.id === entry.id && turn.turn === entry.turn).length !== 1) return;
      const node = value(mapping, userId), message = value(node, 'message');
      if (value(node, 'id') !== userId || value(message, 'id') !== userId || message.author?.role !== 'user') return;
      const prior = snapshots.get(mapping);
      if (prior && prior.renderedConversation.current_node !== conversation.current_node) conflict = true;
      snapshots.set(mapping, candidate);
    };
    let remaining = 2048;
    for (let at = fiber, up = 0; at && up < MAX_CLIMB && remaining > 0; up++, at = at.return) {
      if (at.memoizedProps?.conversationId !== entry.conversationId) continue;
      for (let hook = at.memoizedState; hook && remaining-- > 0; hook = hook.next) {
        const state = value(hook, 'memoizedState');
        inspect(state); if (Array.isArray(state)) inspect(state[0]);
      }
      const data = at.updateQueue?.memoCache?.data;
      if (!Array.isArray(data) || data.length > 32) continue;
      for (const row of data) {
        if (!Array.isArray(row) || row.length > 1024) continue;
        for (const item of row) { if (--remaining < 0) break; inspect(item); }
      }
    }
    return conflict || snapshots.size > 1 || remaining <= 0 ? false : snapshots.values().next().value || null;
  }
  /** The renderer publishes its chosen current_node together with the very same
   * turn object. Follow parent links back to that turn's actual user, never pick
   * a child or import another branch. Untyped early messages contribute ids only. */
  function shellCurrentPath(snapshot, entry) {
    if (snapshot?.renderedTurns.at(-1)?.turn !== entry.turn) return [];
    const mapping = snapshot.renderedConversation.mapping, ids = [], seen = new Set();
    let id = snapshot.renderedConversation.current_node;
    for (let at = 0; at < MAX_ROWS && typeof id === 'string' && id.length <= MAX_TEXT && !seen.has(id); at++) {
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) return [];
      seen.add(id); ids.push(id);
      if (message.author?.role === 'user') {
        const user = entry.turn.items.find(item => item?.type === 'user-message');
        return id === (user?.messageId || user?.serverMessageId) && entry.turn.messageIds.every(value => seen.has(value))
          ? ids.reverse() : [];
      }
      id = node.parent;
    }
    return [];
  }
  /** #318 identified the history cache. Both sources project only explicitly named
   * messages. Typed public items own presentation; cache text cannot supply a final. */
