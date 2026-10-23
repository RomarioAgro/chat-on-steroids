  function groupOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (Array.isArray(props.allMessages) || (props.turn && typeof props.turn === 'object')) return null;
      if (Array.isArray(props.messages) && props.messages.length > 0) return props;
    }
    return null;
  }
  /**
   * The complete message list for this logical turn, read separately from the row group.
   *
   * Row identity must never come from this list because it contains many requests. For
   * attribution cardinality, though, that is exactly the useful property: it lets us count
   * how many requests in the turn actually target TobisComputer instead of treating
   * ChatGPT's folded-row count as if api_tool metadata calls were local MCP calls.
   */
  function turnMessagesOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.messages)) return turn.messages;
      if (Array.isArray(props.allMessages)) return props.allMessages;
    }
    return null;
  }

  /**
   * ChatGPT's internal conversation identity attached to this Fiber branch.
   *
   * Absence and contradiction are deliberately different states. During navigation React can
   * leave props from chat A and chat B mounted on one branch for a tick. Returning plain null
   * for that shape used to make content.js treat the branch exactly like one that simply had
   * no conversation metadata, which let stale assistant messages from another chat be recorded
   * under the current URL. Preserve the conflict bit so the isolated world can fail closed.
   */
  function conversationEvidenceOf(fiber) {
    let found = null;
    const conversations = new Map();
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn && typeof props.turn === 'object' ? props.turn : null;
      // The mounted conversation.id can be a local WEB identity, not the /c id.
      // Its serverId$ signal is the read-only durable identity used by that same
      // conversation object. Read it once per object; never equate the local id
      // with the page route or infer ownership from the URL itself.
      const conversation = props.conversation && typeof props.conversation === 'object' ? props.conversation : null;
      if (conversation && !conversations.has(conversation)) {
        let serverId = null;
        try {
          const value = typeof conversation.serverId$ === 'function' ? conversation.serverId$() : null;
          if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) serverId = value;
        } catch { /* Unresolved signal carries no durable identity. */ }
        conversations.set(conversation, serverId);
      }
      const values = [props.clientThreadId, props.conversationId, conversation && conversation.id,
        Array.isArray(props.entry?.turn?.items) ? props.entry.conversationId : null,
        conversations.get(conversation), turn && turn.clientThreadId, turn && turn.conversationId];
      for (let index = 0; index < values.length; index++) {
        const value = str(values[index]);
        if (!value || value.startsWith('WEB:') || value.startsWith('local-chatgpt:')) continue;
        if (found && found !== value) return { conversationId: null, conflict: true };
        found = value;
      }
    }
    return { conversationId: found, conflict: false };
  }

  /** An authored assistant message object, when a rendered prose node exposes one directly. */
  function messageOf(fiber, candidates, conversationId) {
    let found = null;
    const scope = conversationEvidenceOf(fiber);
    if (scope.conflict || (scope.conversationId && conversationId && scope.conversationId !== conversationId)) return null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const candidate = props.message;
      const direct = candidate && typeof candidate === 'object' && candidate.author?.role === 'assistant' &&
        !requestOf(candidate) && !resultOf(candidate) ? str(candidate.id) : null;
      const scoped = props.conversation && scope.conversationId && scope.conversationId === conversationId ? str(props.messageId) : null;
      // Native public interim rows expose a typed preamble key, while their
      // messageId/conversation props can both be undefined. Join the complete key
      // to this turn's authored candidates; displayed prose is never identity.
      const item = props.item;
      let preamble = null;
      if (item?.type === 'preamble') {
        if (!scope.conversationId || scope.conversationId !== conversationId) return null;
        preamble = candidates.find(candidate => item.key === `preamble-${candidate.id}`)?.id;
        if (!preamble) return null;
      }
      const typed = item?.type === 'assistant-message' && scope.conversationId === conversationId ? str(item.messageId) : null;
      for (const id of [direct, scoped, preamble, typed]) {
        if (!id) continue;
        if (!candidates.some(candidate => candidate.id === id)) return null;
        if (found && found !== id) return null;
        found = id;
      }
    }
    return found;
  }

  /**
   * ChatGPT's own name for what a public assistant message is *for*.
   *
   * The page model routes assistant prose down three named channels, and they are not
   * interchangeable. `final` is the answer. `commentary` is the running narration a
   * tool-using turn shows between calls. `analysis` is the model's private scratch, which
   * this extension never records and never shows.
   *
   * Read as a plain string, absent included: page data old enough to carry no channel at all
   * keeps behaving exactly as it did before this field was known, rather than being
   * reclassified by a default.
   */
  function channelOf(message) {
    return message && typeof message === 'object' ? str(message.channel) : '';
  }

  /**
   * Whether this message is ChatGPT's private reasoning scratch rather than something it
   * said. Recording it would put chain-of-thought in the transcript; letting it stand as the
   * turn's newest public prose is worse, and is measured below.
   */
  function analysisMessage(message) {
    return channelOf(message) === 'analysis';
  }

  /**
   * Whether this message is, by ChatGPT's own routing, incapable of being the answer.
   *
   * Live 2026-08-31, on a finished tool-heavy turn with the Stop control already gone, the
   * page model held: the answer on `channel:'final'` with `end_turn:true` and
   * `status:'finished_successfully'`, and *after* it an empty message on `channel:'analysis'`
   * left at `status:'in_progress'` forever. A trailing `commentary` message left at
   * `end_turn:false` behaves the same way. Neither is a turn that is still running and
   * neither can ever become the answer — so neither may stand in front of the message that
   * is one.
   */
  function neverTerminalChannel(message) {
    const channel = channelOf(message);
    return channel === 'analysis' || channel === 'commentary';
  }

  function hiddenMessage(message) {
    const meta = message && typeof message === 'object' ? message.metadata : null;
    return Boolean(
      meta &&
      typeof meta === 'object' &&
      (meta.is_visually_hidden_from_conversation === true || meta.is_visually_hidden === true)
    );
  }

  /** Whether one page-model message is ChatGPT's own reasoning/thought object. */
  function thoughtMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const author = message.author;
    const content = message.content;
    return Boolean(
      author &&
      author.role === 'assistant' &&
      content &&
      typeof content === 'object' &&
      content.content_type === 'thoughts' &&
      str(message.id)
    );
  }

  /**
   * ChatGPT's row-local identity for a rendered thought item.
   *
   * The live renderer exposes `memoizedProps.item = { type: 'thought', key:
   * 'thought-<message UUID>-<item index>', ... }` only a few Fibers above the visible row.
   * The UUID portion must resolve to an actual thought message in this turn; the full key is
   * retained because the suffix is page identity too and can distinguish two items owned by
   * one thought if ChatGPT ever emits them.
   */
  function thoughtItemOf(fiber, thoughtIds) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const item = props.item;
      if (!item || typeof item !== 'object' || item.type !== 'thought') continue;
      const key = str(item.key);
      if (!key) continue;
      const suffixAt = key.lastIndexOf('-');
      const suffix = suffixAt >= 0 ? key.slice(suffixAt + 1) : '';
      const owner = key.startsWith('thought-') && /^\d{1,6}$/.test(suffix) ? key.slice(8, suffixAt) : null;
      if (owner && !thoughtIds.has(owner)) continue;
      if (!owner) continue;
      if (found && found.messageId !== key) return null;
      found = { messageId: key, thoughtMessageId: owner };
    }
    return found;
  }

  /**
   * The public authored text carried by one ChatGPT assistant message, or null.
   *
   * Live turns contain many assistant-authored *internal* messages as well: connector
   * requests are `code`, and reasoning/tool-summary state is `thoughts`. The latter is the
   * shape that broke canonical prose capture in 1.8.1: a turn with 3 real text messages also
   * held 23 `thoughts` records, so the old positional fallback saw 26 candidate ids for 18
   * rendered Markdown nodes and (correctly) refused to guess. `content_type: text` is the
   * page model's explicit boundary for authored prose; `parts` then carries the raw Markdown
   * exactly as ChatGPT authored it.
   *
   * Do not fall back to arbitrary object/string fields. This helper runs in the page world
   * and its allowlist is a privacy boundary: only the public text payload crosses worlds.
   */
  /**
   * A message that mentions a ChatGPT app stores the mention inline as `[$slug](app://asdk_app_…)`
   * (#861). That is how the message attached the app, not what its author wrote, and the app adds
   * one to every prompt it sends, so user text is read without it. Ordinary links are untouched.
   */
  const APP_MENTION_LINK = /[ \t]*\[\$[a-z0-9][a-z0-9-]{0,80}\]\(app:\/\/asdk_app_[A-Za-z0-9_-]{1,160}\)[ \t]*/g;
  function withoutAppMentions(value) {
    if (typeof value !== 'string' || !value.includes('](app://asdk_app_')) return value;
    return value.replace(APP_MENTION_LINK, ' ').trim();
  }

  function authoredText(message) {
    const content = message && typeof message === 'object' ? message.content : null;
    if (!content || typeof content !== 'object' || content.content_type !== 'text') return null;
    if (Array.isArray(content.parts)) {
      let value = '';
      for (let at = 0; at < content.parts.length; at++) {
        const part = content.parts[at];
        if (typeof part !== 'string') continue;
        if (value) value += '\n';
        value += part;
        if (value.length >= MAX_RENDERED_TEXT) break;
      }
      value = value.slice(0, MAX_RENDERED_TEXT);
      return value.length > 0 ? value : null;
    }
    return typeof content.text === 'string' && content.text.length > 0
      ? content.text.slice(0, MAX_RENDERED_TEXT)
      : null;
  }

  /** ChatGPT's own message creation time, normalized to epoch milliseconds when present. */
  function authoredTime(message) {
    const raw = message && typeof message === 'object' ? Number(message.create_time) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // The live model uses epoch seconds (often fractional). Accept milliseconds too so a
    // renderer change cannot move a valid timestamp ~54,000 years into the past.
    return Math.round(raw < 10_000_000_000 ? raw * 1000 : raw);
  }

  /** Whether two optional page turn identities contradict one another. */
  function turnIdentityContradicts(left, right) {
    return Boolean(left && right && left !== right);
  }

  /**
   * Stable public-assistant identity before the owning thought object necessarily mounts.
   *
   * ChatGPT can rotate the child text-message UUID while one commentary item streams, so the
   * raw message id is not identity. Three pieces of ChatGPT's own server-authored metadata
   * are: `working_turn_id` and `turn_exchange_id` name the branch, and `create_time` names
   * the message inside it. That tuple is the same before and after a reload, which the
   * previous `parent_id` tuple was not: rehydrating a conversation from the server re-parents
   * the text message, so every already-recorded message came back under a second key and the
   * transcript showed each one twice.
   *
   * No text, DOM position, or local observation time takes part. `create_time` here is
   * ChatGPT's own creation stamp for that exact message, read from the page model.
   *
   * `parent_id` remains the fallback identity for page data old enough to carry no
   * `create_time`. A bare parent_id is deliberately insufficient even then: Retry/Regenerate
   * branches can share a parent. With no turn/exchange discriminator at all there is no exact
   * identity to use, and the raw message id stands until one exists.
   */
  function assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime) {
    if ((workingTurnId || turnExchangeId) && createTime) {
      const stable = `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}`;
      if (stable.length <= 190) return stable;
    }
    if (!parentId || (!workingTurnId && !turnExchangeId)) return id;
    const value = `assistant:${parentId}:${workingTurnId || ''}:${turnExchangeId || ''}`;
    return value.length <= 190 ? value : id;
  }

  /** Public assistant messages in ChatGPT's own turn model, in model order. */
