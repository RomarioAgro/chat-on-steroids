  function authoredAssistantMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    const logicalIds = new Set();
    const thoughtParents = new Map();
    if (!Array.isArray(messages)) return out;
    const terminalId = turnEndMessageId(messages);
    for (const candidate of messages) {
      if (thoughtMessage(candidate)) thoughtParents.set(str(candidate.id), candidate);
    }
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      // ChatGPT visually hides public preambles even while their text still grows.
      // That presentation flag must not freeze or discard these typed public updates.
      const publicPreamble = message.recipient === 'all' && channelOf(message) === 'commentary' &&
        message.content?.content_type === 'text' && message.metadata?.is_thinking_preamble_message === true &&
        message.metadata.is_visually_hidden !== true;
      if (requestOf(message) || resultOf(message) || (hiddenMessage(message) && !publicPreamble)) continue;
      // Private reasoning, by ChatGPT's own routing. Never a transcript row.
      if (analysisMessage(message)) continue;
      const id = str(message.id);
      const rawText = budgetedText(authoredText(message), budget, MAX_RENDERED_TEXT);
      // A native final can be textless (for example after generated images).
      // Preserve its exact end_turn proof through the normal message pipeline.
      if (!id || (!rawText && id !== terminalId)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const parentId = meta ? str(meta.parent_id) : null;
      const workingTurnId = meta ? str(meta.working_turn_id) : null;
      const turnExchangeId = meta ? str(meta.turn_exchange_id) : null;
      // The server's own answer to "which model produced this": the only per-reply model proof.
      const resolvedModel = meta ? modelSlugOf(meta.resolved_model_slug) || modelSlugOf(meta.model_slug) : null;
      const createTime = authoredTime(message);
      const authoredId = assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime);
      // Two messages of one branch sharing a creation millisecond would collide on that
      // identity. Keep the first and hand the later one the parent tuple instead, so a
      // collision costs a weaker key rather than a swallowed message.
      const collides = logicalIds.has(authoredId);
      let logicalId = collides ? assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, null) : authoredId;
      // The reload-durable identity needs no thought parent to be trustworthy.
      let stable = !collides && Boolean(createTime) && logicalId !== id && logicalId !== parentId;

      // Live streaming can replace the raw text-message UUID while the same commentary block
      // keeps growing. The page already supplies a stronger relation: public commentary is a
      // child of the thought object that owns that reasoning step. Use that thought id only
      // when the parent is actually present in this same turn model and its own turn metadata
      // does not contradict the child. No text, order, timing or DOM position participates.
      if (parentId) {
          const parent = thoughtParents.get(parentId);
          if (parent) {
          const parentMeta = parent.metadata && typeof parent.metadata === 'object' ? parent.metadata : null;
          const parentWorking = parentMeta ? str(parentMeta.working_turn_id) : null;
          const parentExchange = parentMeta ? str(parentMeta.turn_exchange_id) : null;
          if (!turnIdentityContradicts(workingTurnId, parentWorking) && !turnIdentityContradicts(turnExchangeId, parentExchange)) {
          // Keep the same exact tuple chosen above. If older page data has a thought parent
          // but no working/exchange metadata, parent_id itself is the stronger identity.
          if (logicalId === id) logicalId = parentId;
          stable = true;
          }
        }
      }
      // The parent fallback can itself collide when the page publishes two authored blocks
      // with the same relation and no creation stamp. Raw ids are weaker across reloads but
      // still strictly better than swallowing one of two distinct messages in this scan.
      if (logicalIds.has(logicalId)) {
        logicalId = id;
        stable = false;
      }
      // Keep the position from ChatGPT's own turn model. `messages` and native activity are
      // transported as separate arrays below for validation, so without this ordinal the
      // isolated-world recorder has no way to put them back together. That was visible on
      // the first interim update of a turn: the prose and the preceding thinking headline
      // often arrived in one scan, and content.js always emitted all prose before all
      // headlines regardless of the order ChatGPT actually rendered them.
      out.push({
        id,
        messageId: logicalId,
        role: 'assistant',
        stable,
        rawText,
        order: index,
        createTime,
        ...(resolvedModel ? { resolvedModel } : {})
      });
      logicalIds.add(logicalId);
    }
    return out;
  }

  /**
   * Public user messages in ChatGPT's own turn model.
   *
   * The DOM usually exposes `data-message-id` for user prose, but the first message of a
   * brand-new chat can exist in the React model before that attribute is mounted. That is
   * exactly the gap where the live recorder used to miss the opening prompt and only recover
   * it after a reload. The model id is already ChatGPT's durable identity, so there is no
   * reason to make user capture depend on the DOM having caught up.
   */
  /** A question's parent in ChatGPT's message tree: a message id, or "root" for a chat's first turn. */
  function parentIdOf(message) {
    const parent = message.metadata?.parent_id;
    return typeof parent === 'string' && (parent === 'root' || /^[A-Za-z0-9:_-]{8,190}$/.test(parent)) ? parent : null;
  }

  function authoredUserMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'user') continue;
      const id = str(message.id);
      const content = message.content;
      const multimodal = content?.content_type === 'multimodal_text' && Array.isArray(content.parts);
      const imageCount = multimodal ? content.parts.filter(part => part?.content_type === 'image_asset_pointer').length : 0;
      const attachments = imageCount > 0 && Array.isArray(message.metadata?.attachments)
        ? message.metadata.attachments.filter(file => file && typeof file.id === 'string' && file.id.length > 0 && file.id.length <= 100 &&
          typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 200 &&
          /^image\/[a-z0-9.+-]{1,80}$/i.test(file.mime_type) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 512 * 1024 * 1024)
          .slice(0, Math.min(4, imageCount)).map(file => ({ id: file.id, name: file.name, size: file.size, mimeType: file.mime_type })) : [];
      const authored = multimodal ? content.parts.filter(part => typeof part === 'string').join('\n') : authoredText(message);
      const rawText = budgetedText(withoutAppMentions(authored), budget, MAX_RENDERED_TEXT) || '';
      if (!id || (!rawText && !attachments.length)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        messageId: id,
        role: 'user',
        stable: true,
        rawText,
        // ChatGPT's own mark for text it stored as escaped Markdown (page-inserted text).
        ...(message.metadata?.serialization_metadata?.render_format === 'markdown' ? { markdown: true } : {}),
        ...(attachments.length ? { attachments } : {}),
        // Its place in ChatGPT's message tree; `parentExact` says two questions sharing it are versions
        // of one message (always, for a real parent id; for the shell's predecessor, only with ChatGPT's
        // own versions control on that turn).
        ...(parentIdOf(message) ? { parentId: parentIdOf(message), parentExact: message.metadata?.clf_parent_exact !== false } : {}),
        order: index,
        createTime: authoredTime(message)
      });
    }
    return out;
  }

  /**
   * Public native generated-image outputs in ChatGPT's own turn model.
   *
   * Live evidence records these as role=tool, channel=final multimodal messages rather than
   * assistant prose. The typed public assistant role is also supported for the same payload;
   * every other role/channel is private or unknown. User image pointers are
   * uploads and every other role/channel is private or unknown. Only the provider message UUID,
   * sediment file id and bounded geometry cross worlds; no signed URL or arbitrary metadata does.
   */
  function generatedImagesOf(sections, messages, exactImageNodes, shellImages = new Map()) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length && out.length < MAX_GENERATED_IMAGES; index++) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || hiddenMessage(message) || analysisMessage(message)) continue;
      const role = message.author && (message.author.role === 'tool' || message.author.role === 'assistant')
        ? message.author.role : null;
      if (!role || message.recipient !== 'all' || neverTerminalChannel(message)) continue;
      const messageId = str(message.id);
      const content = message.content;
      if (!messageId || !content || typeof content !== 'object' || content.content_type !== 'multimodal_text' || !Array.isArray(content.parts)) continue;
      for (let partOrder = 0; partOrder < content.parts.length && out.length < MAX_GENERATED_IMAGES; partOrder++) {
        const part = content.parts[partOrder];
        if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') continue;
        const pointer = str(part.asset_pointer);
        const match = pointer && /^sediment:\/\/(file_[A-Za-z0-9_-]{8,100})$/.exec(pointer);
        if (!match) continue;
        const assetId = match[1];
        const key = `${messageId}\u0000${assetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const width = Number.isInteger(part.width) && part.width > 0 && part.width <= 30_000 ? part.width : null;
        const height = Number.isInteger(part.height) && part.height > 0 && part.height <= 30_000 ? part.height : null;
        out.push({
          messageId,
          assetId,
          providerRole: role,
          providerChannel: channelOf(message) || null,
          providerStatus: message.status === 'finished_successfully' || message.status === 'in_progress' ? message.status : null,
          order: index,
          partOrder,
          createTime: authoredTime(message),
          ...(width ? { width } : {}),
          ...(height ? { height } : {})
        });
      }
    }

    // The URL is an ephemeral pixel selector, never durable identity. It is accepted only
    // inside this exact turn, for the exact same-origin estuary endpoint, and only when typed
    // ownership is unique for the sediment file id. A gallery can mount several presentation
    // clones of the same exact asset, so DOM node count is not ownership.
    const descriptorsByAsset = new Map();
    for (const image of out) {
      const list = descriptorsByAsset.get(image.assetId) || [];
      list.push(image);
      descriptorsByAsset.set(image.assetId, list);
    }
    const nodesByAsset = new Map();
    for (const section of sections) {
      let nodes = [];
      try { nodes = section.querySelectorAll(GENERATED_IMAGE); } catch { nodes = []; }
      for (const node of nodes) {
        try {
          const url = new URL(node.currentSrc || node.src, location.href);
          if (url.origin !== location.origin) continue;
          let assetId = url.pathname === '/backend-api/estuary/content' ? url.searchParams.get('id') : null;
          if (url.protocol === 'blob:') {
            // Current image previews use blob pixels. Only the mounted typed item
            // and its exact per-image control can identify those pixels; a blob URL
            // or a nearby gallery alone is not an asset identity.
            let control = null;
            for (let at = fiberOf(node), up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
              const props = at.memoizedProps;
              if (props?.imageId && !control) control = props;
              if (shellImages.has(props?.item)) {
                if (control?.imageId === props.item.id && control.isComplete === true && control.isPreview === false)
                  assetId = shellImages.get(props.item);
                break;
              }
              if (props?.entry) break;
            }
          }
          if (!assetId || !descriptorsByAsset.has(assetId)) continue;
          const list = nodesByAsset.get(assetId) || [];
          list.push(node);
          nodesByAsset.set(assetId, list);
        } catch {
          // A malformed or inaccessible URL simply has no pixel authority.
        }
      }
    }
    for (const [assetId, descriptors] of descriptorsByAsset) {
      const nodes = nodesByAsset.get(assetId) || [];
      // A native gallery mounts several presentation clones (main image, thumbnail, mask and
      // blur layers) for one exact asset. They all resolve the same source bytes, so stamp all
      // of them. Ambiguous *typed ownership* remains fail-closed.
      if (descriptors.length !== 1 || nodes.length === 0) continue;
      for (const node of nodes) exactImageNodes.set(node, descriptors[0]);
    }
    return out;
  }

  /**
   * Whether ChatGPT's own message model says this turn reached a terminal successful end.
   *
   * Live 2026-08-19 evidence: an actively generating turn can already expose
   * `isFinalTurn:true`, and interim public messages can already have
   * `status:'finished_successfully'`; neither is completion. The final assistant message is
   * the one that additionally carries direct `end_turn:true`. Only that boolean plus the
   * assistant role/status crosses worlds. No private reasoning or finish payload is copied.
   */
  function turnEndMessageId(messages) {
    if (!Array.isArray(messages)) return null;
    // The latest public message that *could* be the answer is the current state of the assistant
    // turn. A Retry/Regenerate can leave the previous finished attempt in the same model while
    // a newer public message is active; searching for *any* older end_turn=true would
    // incorrectly keep the new attempt terminal forever. So the first such message from the
    // tail decides, fail closed.
    //
    // "Could be the answer" is ChatGPT's own routing, not a guess about content: a turn's
    // trailing `analysis` or `commentary` message is not a turn still in flight, it is a
    // message on a channel that never carries answers. Skipping those is what stops one empty
    // scratch message — live, an `analysis` row stuck at `status:'in_progress'` after the
    // Stop control had already gone — from hiding a completed answer forever, leaving the real
    // final prose recorded as partial and the turn permanently open. See neverTerminalChannel.
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      const content = message.content;
      if (!content || typeof content !== 'object' || !['text', 'multimodal_text', 'image'].includes(content.content_type)) continue;
      if (neverTerminalChannel(message)) continue;
      if (message.end_turn === true && message.status === 'finished_successfully') return str(message.id);
      return null;
    }
    return null;
  }

  /** Whitespace-only normalisation for an optional DOM decoration match. */
  function visibleText(value) {
    return typeof value === 'string' ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Public authored prose from ChatGPT's own message model, optionally decorated with the
   * rendered HTML of the matching visible block.
   *
   * Identity and raw Markdown come from the model, not the DOM. That is the important
   * invariant: a renderer refactor may cost rich HTML for one message, but can no longer make
   * the message disappear or mint a new identity for each streaming snapshot.
   *
   * HTML is decoration only. Prefer an explicit DOM/Fiber message id. Where the page no
   * longer exposes one, an exact whitespace-normalised text equality may attach a block, but
   * only when that match is unique on both sides. Markdown whose rendered text differs from
   * its raw source simply keeps `renderedHtml: ''` and the recorder still has the canonical
   * raw Markdown. Finally, the old positional fallback remains only for the fully balanced
   * case, where every remaining candidate has exactly one remaining visible block.
   */
  /**
   * The sources behind each citation pill in these sections, from the pill's own props: the list
   * its hover card pages through, and the reply and reference index it belongs to (its reference's
   * position in that reply's `content_references`, which the inline directive names). Titles,
   * links, publication dates and snippets only, bounded; anything else is left out.
   */
