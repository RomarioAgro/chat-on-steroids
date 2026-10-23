  function requestOf(message) {
    if (!message || typeof message !== 'object') return null;
    const author = message.author;
    if (!author || author.role !== 'assistant') return null;
    const recipient = str(message.recipient);
    if (!recipient || recipient.indexOf('api_tool') !== 0) return null;

    let path = null;
    const text = message.content && message.content.text;
    if (typeof text === 'string' && text.length > 0) {
      const head = PATH_HEAD.exec(text);
      if (head) path = str(head[1]);
    }

    // ChatGPT stamps every connector request with its own request id, and the same id
    // reaches the app on the MCP request itself — a deterministic join between the page and
    // the call, so two workers calling one tool at once need no timing heuristic to tell
    // apart. Allowlisted like everything else here — an opaque id, never arguments.
    const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    return {
      path,
      messageId: str(message.id),
      requestId: meta ? str(meta.request_id) : null,
      createTime: num(message.create_time)
    };
  }

  /**
   * Every request id ChatGPT has stamped anywhere in this turn.
   *
   * `callsOf` deliberately answers a narrow question — which rows are *this app's* connector
   * calls, so they can be labelled and rendered — and to answer it, it requires a readable
   * `api_tool` recipient and a parseable tool path. That filter is right for a tool row and
   * wrong for attribution, and the difference cost an entire class of calls.
   *
   * ChatGPT stamps `metadata.request_id` on the plain `recipient: "all"` message the moment a
   * turn starts a connector request, and only materializes the `api_tool` message once its
   * safety check clears — live 2026-08-21, forty seconds later, well past the app's fifteen
   * second evidence window. The id was on screen and readable the whole time; this file threw
   * it away because it was not yet attached to a row worth *drawing*. The app then filed the
   * call under `Unattributed activity`, refused identity-sensitive calls, and the chat looked
   * broken for reasons no log named.
   *
   * The request id is opaque, and the join it feeds is exact: id -> conversation, nothing
   * else. So harvest it from every message in the turn, with no opinion about recipient, path
   * or tool name, and let the app decide. Nothing here is rendered and nothing here is parsed
   * from `content.text` — this list carries three allowlisted primitives per entry and never
   * appears in the transcript.
   */
  function requestIdsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const message = messages[at];
      if (!message || typeof message !== 'object') continue;
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const requestId = meta ? str(meta.request_id) : null;
      if (!requestId || seen.has(requestId)) continue;
      seen.add(requestId);
      out.push({
        requestId,
        messageId: str(message.id),
        createTime: num(message.create_time)
      });
    }
    return out;
  }

  /** "/Chat On Steroids Core/link_…/read" -> "read", or null if that is not a name. */
  function toolName(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const tail = value.slice(value.lastIndexOf('/') + 1);
    return NAME.test(tail) ? tail : null;
  }

  /**
   * The tool a row ran, from both sources or neither.
   *
   * The request names it and so does the result — `invoked_resource.resource_uri`, which
   * is structured and needs no parsing. Where both are readable they must agree: two
   * sources naming different tools means the pairing is wrong, and a row labelled with the
   * wrong tool is worse than one left saying "Called tool". Where only one is readable it
   * is used, because an unanswered call has no result yet and a truncated payload has no
   * path.
   */
  function identify(request, result) {
    const asked = toolName(request.path);
    const answered = result ? toolName(result.resource) : null;
    if (asked && answered) return asked === answered ? asked : null;
    return asked || answered;
  }

  /** The connector a result came back through, and whether it came back at all. */
  /**
   * Every connector result row's identity in these messages, ours or not: request id, app id,
   * link id and the name ChatGPT shows. The app learns its own connectors from these, but only
   * for request ids it served itself (connector-identity.ts). No arguments or result bytes.
   */
  function sightingsOf(messages) {
    const out = [];
    if (!Array.isArray(messages)) return out;
    for (let at = 0; at < messages.length && out.length < 50; at++) {
      const message = messages[at];
      if (!message || message.author?.role !== 'tool' || message.author.name !== 'api_tool.call_tool') continue;
      const result = resultOf(message), requestId = str(message.metadata?.request_id), appId = appIdOf(result?.resource);
      if (!requestId || !appId) continue;
      out.push({ requestId, appId, linkId: linkIdOf(result.resource), appName: result.app });
    }
    return out;
  }

  function resultOf(message) {
    if (!message || typeof message !== 'object') return null;
    const meta = message.metadata;
    const resource = meta && meta.invoked_resource;
    if (!resource || typeof resource !== 'object') return null;
    return { app: str(resource.app_name), resource: str(resource.resource_uri) };
  }

  function conflictingRequestScope(left, right) {
    return ['request_id', 'working_turn_id', 'turn_exchange_id'].some(key =>
      str(left.metadata?.[key]) && str(right.metadata?.[key]) && left.metadata[key] !== right.metadata[key]);
  }

  /** Native results can point through a completed assistant/all intermediate message.
   * Follow its exact parent links inside this turn, stopping at any other tool boundary.
   * Repeated ids, cycles and contradictory request/working-turn ids provide no receipt. */
  function resultParentsOf(messages) {
    const byId = new Map(), parents = new Map();
    for (const message of messages || []) {
      const id = str(message?.id);
      if (id) byId.set(id, byId.has(id) ? null : message);
    }
    for (const message of messages || []) {
      const result = resultOf(message);
      if (!result || !ownResult(result)) continue;
      const visited = new Set();
      let id = str(message.metadata?.parent_id), parentId = null;
      while (id && visited.size < MAX_CALLS && !visited.has(id)) {
        visited.add(id);
        const parent = byId.get(id);
        if (!parent) { if (!byId.has(id)) parentId = id; break; }
        if (conflictingRequestScope(parent, message)) break;
        const request = requestOf(parent);
        if (request) { if (identify(request, result)) parentId = id; break; }
        if (parent.author?.role !== 'assistant' || parent.recipient !== 'all' ||
            parent.status !== 'finished_successfully' || parent.end_turn === true) break;
        id = str(parent.metadata?.parent_id);
      }
      parents.set(message, parentId);
    }
    return parents;
  }

  /** Rehydrated direct calls can expose only their public result object. Its UUID,
   * request id and invoked resource are exact evidence; no parent or payload is guessed. */
  function completedCallOf(message) {
    if (!message || message.author?.role !== 'tool' || message.author.name !== 'api_tool.call_tool' ||
        message.recipient !== 'all' || str(message.metadata?.parent_id)) return null;
    const result = resultOf(message);
    const messageId = str(message.id), requestId = str(message.metadata?.request_id);
    const tool = result && toolName(result.resource);
    if (!result || !ownResult(result) || !messageId || !requestId || !tool) return null;
    return { ...result, messageId, requestId, tool, createTime: num(message.create_time) };
  }
  /** Exact number of this app's own invocations represented by the whole turn, or null. */
  function localCountOf(messages, resultParents = resultParentsOf(messages)) {
    if (!Array.isArray(messages)) return null;
    const ids = [];
    let anonymous = 0;
    const remember = (id) => {
      if (!id) {
        anonymous += 1;
        return;
      }
      for (let at = 0; at < ids.length; at++) if (ids[at] === id) return;
      ids.push(id);
    };

    for (let at = 0; at < messages.length; at++) {
      const message = messages[at];
      const request = requestOf(message);
      if (request && ownRequestPath(request.path)) {
        remember(request.messageId);
      }

      const result = resultOf(message);
      if (result && ownResult(result)) {
        remember(resultParents.get(message) || completedCallOf(message)?.messageId);
      }
    }
    return Math.min(999, ids.length + anonymous);
  }

  /**
   * One row's descriptor, or null when the shape is not the one we know.
   *
   * The representative call is `messages[0]` — the group's own request, and the one whose
   * name the row shows. It is also the *last* call of what the row stands for: ChatGPT's
   * own "Open tool call list" for a turn that ran five calls showed four rows whose
   * requests were calls two to five, with call one folded under the first row.
   *
   * The result is found by `parent_id`, never by position. Everything after `messages[0]`
   * is a result, but only the one whose `metadata.parent_id` is this request's id answered
   * *this* call; the rest are chained to requests that are not in this array at all.
   * Taking the nearest one instead — which is what scanning forward does — pairs a row with
   * whatever came back next, and that is the live symptom of a row headed `Search files`
   * sitting over another tool's output.
   */
  function describe(row, index) {
    const fiber = fiberOf(row);
    if (!fiber) return null;

    const group = groupOf(fiber);
    if (!group) return null;

    const turnMessages = turnMessagesOf(fiber);
    const messages = group.messages;
    const resultParents = resultParentsOf(turnMessages || messages);
    const localCount = localCountOf(turnMessages, resultParents);
    const request = requestOf(messages[0]);
    // A rejected result join is not positive evidence for the request's label.
    // Keep an explicit contradictory parent/result visible as an unknown row.
    const conflictingResult = request?.messageId && messages.some(message =>
      str(message?.metadata?.parent_id) === request.messageId && resultOf(message) &&
      identify(request, resultOf(message)) === null);
    let result = null;
    if (request?.messageId) {
      // An index loop and no array method: this walks page-owned data, and the page can
      // replace Array.prototype.find but it cannot replace the language.
      for (let at = 1; at < messages.length && result === null; at++) {
        const message = messages[at];
        if (resultParents.get(message) === request.messageId) {
          result = resultOf(message);
        }
      }
    }

    let completed = request ? null : completedCallOf(messages[0]);
    // A settled native disclosure can retain a stale request before a parentless result.
    // Represent the result's own UUID, leaving the unrelated request unanswered in callsOf.
    // Never borrow a neighbor's result to complete that request or a still-running group.
    if (request && !result && group.isCompletionRequestInProgress === false && messages.length === 2 &&
        messages[0].status === 'finished_successfully' && messages[1].status === 'finished_successfully' &&
        !conflictingRequestScope(messages[0], messages[1]) && ownRequestPath(request.path)) {
      const displayed = completedCallOf(messages[1]);
      if (displayed && displayed.requestId === request.requestId && identify(request, displayed) === displayed.tool) completed = displayed;
    }
    if (completed) return { v: VERSION, index, tool: completed.tool, path: null, app: completed.app,
      resource: completed.resource, messageId: completed.messageId, turnId: str(group.turnId),
      conversationId: str(group.clientThreadId) || str(group.conversationId), createTime: completed.createTime,
      hidden: int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null),
      localCount, answered: true, own: ownResult(completed) };
    if (!request) return null;

    /**
     * How many calls the row shows in place of, as the page counts them.
     *
     * Presentation cardinality and nothing else. The prop is named for a run of calls to
     * the same tool, but the live page folds different tools together — `list_resources`
     * under one `agents` call — so it says how many the row stands for, never which.
     */
    const hidden = int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null);
    const turnId = str(group.turnId);

    return {
      v: VERSION,
      index,
      tool: conflictingResult ? null : identify(request, result),
      path: request.path,
      app: result ? result.app : null,
      resource: result ? result.resource : null,
      messageId: request.messageId,
      turnId,
      conversationId: str(group.clientThreadId) || str(group.conversationId),
      createTime: request.createTime,
      hidden,
      // Turn-wide cardinality only. No request arguments or message bodies cross worlds.
      localCount,
      /** Whether the page has shown a result for the representative call yet. */
      answered: result !== null,
      /** Whether this row is one of this install's connectors (app id, link, then name). */
      own: result ? ownResult(result) : ownRequestPath(request.path)
    };
  }

  /**
   * Every connector request this turn issued, one entry per call.
   *
   * This is the evidence the app's attribution was missing, and it was here the whole time.
   * The visible rows are a *rendering* of these messages: ChatGPT folds a run of calls into
   * one row and on a fast turn draws no row at all until well after the call was answered,
   * so counting rows counts fewer calls than the turn made. Everything the row count could
   * not account for was then filed outside the chat that made it — a single conversation
   * splitting itself into its real session plus a permanently growing pile of unattributed
   * work. The message list does not fold: each request is its own message, with its own id
   * and its own tool path, whatever the renderer decides to draw.
   *
   * Restricted to this app's own connector. A Gmail or Calendar request in the same turn is
   * some other integration's business, and vouching for it would put a stranger's call into
   * this app's session — the precise false match that made a bare connector row weak
   * evidence in the first place.
   *
   * The allowlist is the same one everything else here obeys, and is if anything tighter:
   * a message id, a tool name derived from the front of the path, the position in the turn
   * and whether a result has come back. No argument values, no result bodies, no reasoning,
   * no whole objects. `content.text` is never parsed — only the anchored path is read off
   * the front of it, exactly as `requestOf` already does.
   */
  /** Native Code Mode chains child requests/results before one functions.exec result.
   * A child's parent_id is then chronology, not its individual response receipt.
   * Resolve the exact enclosing call without reading code or result payloads. */
  function codeModeReceipts(messages) {
    const byId = new Map();
    for (const message of messages) {
      const id = str(message && message.id);
      if (id) byId.set(id, byId.has(id) ? null : message);
    }
    const owners = new Map();
    const scope = message => {
      const meta = message && message.metadata;
      const request = str(meta && meta.request_id), working = str(meta && meta.working_turn_id),
        exchange = str(meta && meta.turn_exchange_id);
      return request && working && exchange ? `${request}\u0000${working}\u0000${exchange}` : null;
    };
    const ownerOf = message => {
      const trail = [], visited = new Set();
      let cursor = message, owner = null;
      while (cursor && trail.length < MAX_CALLS) {
        const id = str(cursor.id);
        if (!id || byId.get(id) !== cursor || visited.has(id)) break;
        visited.add(id);
        const role = cursor.author && cursor.author.role;
        if (role === 'assistant' && cursor.recipient === 'functions.exec') {
          owner = { id, scope: scope(cursor), valid: cursor.status === 'finished_successfully' && !!scope(cursor) };
          break;
        }
        // An earlier completed enclosing call cannot own a later ordinary invocation.
        if (trail.length && role === 'tool' && cursor.author.name === 'functions.exec') break;
        if (owners.has(id)) { owner = owners.get(id); break; }
        if (!((role === 'assistant' && cursor.recipient === 'api_tool.call_tool') ||
            (role === 'tool' && cursor.recipient === 'all' &&
              (cursor.author.name === 'api_tool.call_tool' || cursor.author.name === 'functions.exec')))) break;
        trail.push(cursor);
        cursor = byId.get(str(cursor.metadata && cursor.metadata.parent_id));
      }
      for (let index = trail.length - 1; index >= 0; index--) {
        if (owner) owner = { ...owner, valid: owner.valid && scope(trail[index]) === owner.scope };
        owners.set(trail[index].id, owner);
      }
      return owner;
    };
    const completed = new Set();
    for (const message of messages) {
      if (message && message.author && message.author.role === 'tool' && message.author.name === 'functions.exec' &&
          message.recipient === 'all' && message.status === 'finished_successfully' && byId.get(message.id) === message) {
        const owner = ownerOf(message);
        if (owner && owner.valid) completed.add(owner.id);
      }
    }
    const receipts = new Map();
    for (const message of messages) {
      const owner = ownerOf(message);
      if (owner) receipts.set(message.id, owner.valid && completed.has(owner.id));
    }
    return receipts;
  }
