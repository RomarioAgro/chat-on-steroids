  function shellRequestMetadata(fiber, queries, shell, conversation, sightings = []) {
    if (conversation.conflict) return [];
    const entry = shell.entry;
    const ids = entry.turn.messageIds;
    if (!Array.isArray(ids) || ids.length > MAX_ROWS || new Set(ids).size !== ids.length) return [];
    let live;
    try { live = shellLiveMapping(fiber, entry); } catch { return []; }
    if (live === false) return [];
    // A freshly submitted shell exchange can still carry only its provisional
    // local-chatgpt id while the page route already names the real conversation.
    // The mounted live mapping is independently fenced by this exact entry, turn
    // object and user message id, so retain its request metadata during that gap.
    // Cache metadata still requires the concrete server conversation join below.
    if (!conversation.conversationId && !live) return [];
    const matches = conversation.conversationId ? queries.filter(query => Array.isArray(query?.queryKey) && query.queryKey.length === 2 &&
      query.queryKey[0] === 'chatgpt-conversation' && query.queryKey[1] === conversation.conversationId) : [];
    if (matches.length > 1) return [];
    const data = matches[0]?.state?.data;
    if (data?.conversation_id && data.conversation_id !== conversation.conversationId) return [];
    const mapping = live?.renderedConversation?.mapping || data?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];
    const out = [];
    const publicBudget = { remaining: MAX_TURN_TEXT };
    const selected = new Set(ids);
    const invocationIds = new Set();
    const sourceCounts = new Map();
    for (const reference of shell.callSources.values()) if (reference.id)
      sourceCounts.set(reference.id, (sourceCounts.get(reference.id) || 0) + 1);
    const messageAt = id => {
      const node = id && Object.getOwnPropertyDescriptor(mapping, id)?.value;
      return node?.id === id && node.message?.id === id ? node.message : null;
    };
    // Native dynamic-tool-call.callId explicitly names the functions.exec
    // invocation (811613 / L). Its source can disappear from messageIds when
    // paired results replace sourceMessage. Read metadata, never its code.
    for (const id of shell.executionIds) {
      const message = messageAt(id);
      if (message?.author?.role === 'assistant' && message.recipient === 'functions.exec') invocationIds.add(id);
    }
    const serverName = name => ownServerName(name);
    for (const call of shell.calls) {
      const reference = shell.callSources.get(call.messageId);
      if (!reference?.id || !selected.has(reference.id) || sourceCounts.get(reference.id) !== 1) continue;
      const result = messageAt(reference.id);
      if (result?.author?.role !== 'tool') continue;
      const resource = resultOf(result);
      if (resource && (serverName(resource.app) !== serverName(reference.server) || toolName(resource.resource) !== call.tool)) continue;
      const invocation = messageAt(call.messageId);
      if (invocation) {
        const asked = requestOf(invocation), path = asked?.path;
        // Native N() keeps callId while replacing sourceMessage with the result.
        // This mounted relation, not cache position or a sibling's request id,
        // permits reading the original invocation's metadata after a reload.
        if (invocation.recipient !== 'api_tool.call_tool' || !path || serverName(path.slice(1, path.indexOf('/', 1))) !== serverName(reference.server) ||
            toolName(path) !== call.tool) continue;
        for (const key of ['request_id', 'working_turn_id', 'turn_exchange_id']) {
          const a = str(invocation.metadata?.[key]), b = str(result.metadata?.[key]);
          if (a && b && a !== b) return [];
        }
        invocationIds.add(call.messageId);
      }
      reference.metadataId = reference.id;
    }
    for (const id of new Set([...ids, ...invocationIds, ...shellCurrentPath(live, entry)])) {
      if (typeof id !== 'string' || !id || id.length > MAX_TEXT || !own.call(mapping, id)) continue;
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) continue;
      // The stripped entries below carry no app identity; read it here, ids only (sightingsOf).
      for (const sighting of sightingsOf([message])) if (sightings.length < 50 && !sightings.some(prior => prior.requestId === sighting.requestId && prior.appId === sighting.appId)) sightings.push(sighting);
      const request = str(message.metadata?.request_id), cached = data?.mapping?.[id]?.message;
      if (live && cached?.id === id && request && cached.metadata?.request_id && cached.metadata.request_id !== request) return [];
      const publicMessage = selected.has(id) && message.author?.role === 'assistant' && !hiddenMessage(message) &&
        message.metadata?.is_visually_hidden_reasoning_group !== true && message.metadata?.summary_type !== 'raw_cot';
      const thought = publicMessage && thoughtMessage(message) && Array.isArray(message.content.thoughts)
        ? message.content.thoughts.at(-1)?.summary : null;
      const preamble = publicMessage && channelOf(message) === 'commentary' &&
        (!message.recipient || message.recipient === 'all') ? authoredText(message) : null;
      out.push({ id, create_time: num(message.create_time), metadata: { request_id: request },
        ...(typeof thought === 'string' ? { thought: budgetedText(thought, publicBudget, MAX_RENDERED_TEXT) } : {}),
        ...(preamble ? { preamble: budgetedText(preamble, publicBudget, MAX_RENDERED_TEXT),
          publicIdentity: { parent_id: str(message.metadata?.parent_id), working_turn_id: str(message.metadata?.working_turn_id),
            turn_exchange_id: str(message.metadata?.turn_exchange_id) } } : {}) });
    }
    // A result row can sit outside the turn's message ids (a new chat, measured 2026-10-11). Find
    // the result rows of this turn's own request ids anywhere in the mapping; bounded, ids only.
    const turnRequests = new Set();
    for (const entry of out) if (entry.metadata.request_id) turnRequests.add(entry.metadata.request_id);
    if (turnRequests.size && sightings.length < 50) {
      const known = new Set(sightings.map(sighting => `${sighting.requestId} ${sighting.appId}`));
      let visited = 0;
      for (const key in mapping) {
        if (++visited > 5000 || sightings.length >= 50) break;
        if (!own.call(mapping, key)) continue;
        const message = Object.getOwnPropertyDescriptor(mapping, key)?.value?.message;
        if (!message || !turnRequests.has(str(message.metadata?.request_id))) continue;
        for (const sighting of sightingsOf([message])) {
          const seen = `${sighting.requestId} ${sighting.appId}`;
          if (!known.has(seen)) { known.add(seen); sightings.push(sighting); }
        }
      }
    }
    return out;
  }
  /** Public shell titles/preambles have no ids of their own. Their selected source
   * messages do. Match only unique public representations; never mint ids from a
   * group index, use raw analysis, or suppress DOM based on this text comparison. */
  function shellPublicActivity(shell, metadata, rendered, budget, section, exactAnchors) {
    const publicItems = shell.entry.turn.items.flatMap(item => item?.type === 'chatgpt-reasoning-group' &&
      Array.isArray(item.items) && item.reasoningRecap?.type !== 'hide_all' ? item.items : []).filter(item => item?.type === 'reasoning' &&
        item.isTransient !== true && ['thought', 'preamble'].includes(item.presentation) && typeof item.content === 'string');
    const ids = shell.entry.turn.messageIds;
    const order = new Map(Array.isArray(ids) && ids.length <= MAX_ROWS ? ids.map((id, index) => [id, index]) : []);
    for (const message of rendered) if (order.has(message.rawMessageId)) message.order = order.get(message.rawMessageId);
    const events = [];
    const blocks = [...section.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
      .filter(node => node.closest('[data-turn-key]') === section && !node.closest(OWN_SURFACES)).slice(0, MAX_ROWS);
    for (const source of metadata) for (const kind of ['thought', 'preamble']) {
      const text = source[kind];
      const matches = publicItems.filter(item => item.presentation === kind && item.content === text);
      if (!text || matches.length !== 1 ||
          metadata.filter(other => other[kind] === text).length !== 1) continue;
      const authored = kind === 'preamble' ? authoredAssistantMessages([{ id: source.id, author: { role: 'assistant' },
        channel: 'commentary', metadata: source.publicIdentity, create_time: source.create_time,
        content: { content_type: 'text', parts: [text] } }], budget)[0] : null;
      const publicText = kind === 'thought' ? budgetedText(visibleText(text), budget, 300) : authored?.rawText;
      if (!publicText) continue;
      if (kind === 'thought') events.push({ messageId: source.id, label: publicText, order: order.get(source.id) });
      else if (!rendered.some(message => message.rawMessageId === source.id)) rendered.push({ messageId: authored.messageId,
        rawMessageId: source.id, role: 'assistant', stable: authored.stable, rawText: publicText, renderedHtml: '',
        order: order.get(source.id), createTime: authoredTime(source) });
      if (kind === 'preamble') {
        // Native ChatGptMarkdown is owned by the exact typed reasoning item.
        // Text equality above selects public content; only this object relation
        // may place a local tool chunk beside the provider's own prose node.
        const nodes = blocks.filter(node => {
          for (let at = fiberOf(node), up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
            if (at.memoizedProps?.item === matches[0]) return true;
            if (at.memoizedProps?.entry) break;
          }
          return false;
        });
        if (nodes.length === 1) exactAnchors.set(nodes[0], source.id);
      }
    }
    rendered.sort((a, b) => a.order - b.order);
    return { events, notifications: [] };
  }
  /** A reply that is nothing but content references to other messages. */
  const ONLY_CONTENT_REFERENCES = /^\s*(?:::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;
  /**
   * The Markdown a shell item says. ChatGPT's newer renderer (DIL, GPT-6 on 2026-10-08) leaves
   * only `::chatgpt-content-reference{…}` in `content` and keeps the reply itself as
   * `fallbackMarkdown` on the one `dil` reference that names this same message: the text the page
   * shows when its widget cannot render, so the text the model wrote. Anything else keeps its
   * content as it is.
   */
  function shellItemText(item) {
    const content = typeof item?.content === 'string' ? item.content : '';
    // Some DIL turns expose no directive at all (or just the renderer root)
    // while their authored fallback is attached to this exact message.
    if (content.trim() && content.trim() !== 'DilResponseRoot' && !ONLY_CONTENT_REFERENCES.test(content)) return content;
    const id = str(item.messageId);
    const own = (Array.isArray(item.contentReferences) ? item.contentReferences : []).filter(reference =>
      reference?.type === 'dil' && id && reference.source_message_id === id &&
      typeof reference.model_dil_v2?.fallbackMarkdown === 'string' && reference.model_dil_v2.fallbackMarkdown.trim());
    if (own.length !== 1 && (content.trim() === 'DilResponseRoot' || ONLY_CONTENT_REFERENCES.test(content))) {
      console.warn('cos-dil-structure', { messageId: id, contentKind: content.trim() === 'DilResponseRoot' ? 'root' : 'reference',
        referencesCount: Array.isArray(item.contentReferences) ? item.contentReferences.length : -1,
        referenceShapes: (Array.isArray(item.contentReferences) ? item.contentReferences : []).slice(0, 8).map(ref => ({
          type: typeof ref?.type === 'string' ? ref.type : null,
          sourceMessageId: typeof ref?.source_message_id === 'string' ? ref.source_message_id : null,
          sourceMatches: !!id && ref?.source_message_id === id,
          hasFallback: typeof ref?.model_dil_v2?.fallbackMarkdown === 'string' && !!ref.model_dil_v2.fallbackMarkdown.trim(),
          modelKeys: ref?.model_dil_v2 && typeof ref.model_dil_v2 === 'object' ? Object.keys(ref.model_dil_v2).slice(0, 12) : [] })) });
    }
    return own.length === 1 ? unescapeFallbackMarkdown(own[0].model_dil_v2.fallbackMarkdown).slice(0, MAX_RENDERED_TEXT) : content;
  }
  /** A display formula longer than this is not looked for; its lines are read as plain text. */
  const MAX_FORMULA_LINES = 400;
  /**
   * The reply as the model wrote it. `fallbackMarkdown` keeps its formatting but backslash-escapes
   * every literal punctuation mark in plain text (measured on GPT-6, 2026-10-09: `2\^10 = 1024 \[ok\]`,
   * and the Goal marker as `\[\[COS\_GOAL:COMPLETE\]\]`), while code spans and fenced code keep
   * theirs verbatim. Every reader of a reply (Goal markers, Loop decisions, compaction briefs) expects
   * the model's own text, so outside code each `\` before ASCII punctuation is dropped, as Markdown
   * itself would on rendering.
   *
   * Formulas are verbatim too (measured 2026-10-12, #1342): a display formula is a block from a line
   * holding only `\[` to a line holding only `\]`, an inline one sits in `\( … \)`, and both hold raw
   * LaTeX. Literal brackets are escaped inside their text line and literal parentheses never are,
   * so neither is mistaken for one. An opening without its closing is plain text.
   */
  /**
   * Entities in the fallback's plain text (measured on GPT-6, 2026-10-16: `|` arrives as `&#124;`,
   * `&` as `&amp;`). A literal `&` is always `&amp;` there, so one left-to-right pass is exact: a
   * literal `&#124;` the model wrote arrives as `&amp;#124;` and comes back as `&#124;`.
   */
  const FALLBACK_ENTITY = /^&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;
  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function fallbackEntity(name) {
    if (name[0] !== '#') return NAMED_ENTITIES[name] ?? null;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : null;
  }
  function unescapeFallbackMarkdown(markdown) {
    const lines = markdown.split('\n');
    const out = [];
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
        out.push(line);
        continue;
      }
      if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) { fence = marker; out.push(line); continue; }
      if (line.trim() === '\\[') {
        let close = -1;
        for (let at = index + 1; at < lines.length && at <= index + MAX_FORMULA_LINES; at++) if (lines[at].trim() === '\\]') { close = at; break; }
        if (close > index) { for (; index <= close; index++) out.push(lines[index]); index--; continue; }
      }
      let text = '';
      for (let at = 0; at < line.length;) {
        const char = line[at];
        if (char === '\\' && line[at + 1] === '(') {
          const close = line.indexOf('\\)', at + 2);
          if (close >= 0) { text += line.slice(at, close + 2); at = close + 2; continue; }
        }
        if (char === '\\' && /[!-\/:-@[-`{-~]/.test(line[at + 1] || '')) { text += line[at + 1]; at += 2; continue; }
        if (char === '&') {
          const entity = FALLBACK_ENTITY.exec(line.slice(at));
          const decoded = entity && fallbackEntity(entity[1]);
          if (decoded !== null && decoded !== undefined) { text += decoded; at += entity[0].length; continue; }
        }
        if (char === '`') {
          const run = /^`+/.exec(line.slice(at))[0];
          const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(line.slice(at + run.length));
          if (close) { const end = at + run.length + close.index + run.length; text += line.slice(at, end); at = end; continue; }
          text += run; at += run.length; continue;
        }
        text += char; at++;
      }
      out.push(text);
    }
    return out.join('\n');
  }
  /**
   * The provider's own outline of a shell turn's work, in its order: what the model said between
   * steps, each call of this app's connectors, and the recap ChatGPT closes each round with.
   *
   * ChatGPT draws a turn's work as reasoning groups. Inside one, a round is the model's sentences
   * (`assistant-message` items under GPT-6, id-less `reasoning` preambles under GPT-5.x), its calls,
   * and a public `thought` that recaps them ("Created the test files"). In a new chat's first turn
   * none of the sentences or recaps reach any message mapping (#942), so the outline is the only
   * place they exist while the turn runs. It is presentation: it names no message the recorder
   * does not already know, and the app places its recorded calls in rounds by tool and order
   * (renderer/timeline-rounds.ts), never by an id. Hidden groups and transient reasoning stay out.
   */
  /**
   * The user message that opened a shell turn, by ChatGPT's id (#1301). A message the user sends
   * into a running answer opens a turn of its own in ChatGPT's model, while the request id of the
   * answer runs on; the app files each turn's outline only under the local turn that message opened.
   */
  function shellQuestion(shell) {
    const first = shell?.entry?.turn?.items?.[0];
    return first?.type === 'user-message' ? str(first.messageId) || str(first.serverMessageId) || null : null;
  }
