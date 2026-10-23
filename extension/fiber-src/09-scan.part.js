  function scan(nonce) {
    // The existing scan also refreshes mounted-picker evidence; no new poll timer.
    try { pickerSnapshot(); } catch { /* An unknown picker cannot affect recording. */ }
    try { temporaryModeSnapshot(); } catch { /* Unknown mode leaves no stamp, never a false one. */ }
    // The request nonce already uniquely names this scan across the two worlds. Reuse it as
    // the ephemeral frame token rather than minting a second random value: every DOM stamp
    // can then prove both which descriptor index it names and which exact scan produced it.
    // A stamp from scan N is therefore unusable against descriptors from scan N+1 even when
    // React leaves the old DOM node mounted and both scans happen to use index 0.
    const scanToken = nonce;
    const rows = [];
    let turns = [];
    let scanOk = true;
    let found;
    try {
      // Inspect existing native tool containers, never translated control labels.
      // The row-local Fiber group is the authority; built-in tools fail describe().
      found = [...document.querySelectorAll(TOOL)].filter(row => !row.closest(OWN_SURFACES));
      for (const old of document.querySelectorAll(CONNECTOR)) old.removeAttribute('data-clf-fiber');
    } catch {
      return post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk: false, rows: [], turns }, location.origin);
    }
    const limit = Math.min(found.length, MAX_ROWS);
    for (let index = 0; index < limit; index++) {
      const row = found[index];
      let descriptor = null;
      try {
        descriptor = describe(row, index);
      } catch {
        // One unreadable row must not cost the rest of the page its labels.
        descriptor = null;
      }
      try {
        if (descriptor) row.setAttribute('data-clf-fiber', `${scanToken}:${index}`);
      } catch {
        // If the page will not take the marker, the descriptor is unusable: drop it
        // rather than let the other side match it to a row by position.
        descriptor = null;
      }
      if (descriptor) rows.push(descriptor);
    }
    // Row stamps must exist before native activity projection excludes connectors.
    try {
      turns = turnsOf(scanToken);
    } catch {
      turns = [];
      scanOk = false;
    }
    post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk, rows, turns }, location.origin);
  }

  /**
   * Whether this document is a temporary chat, from React's own state rather than an icon.
   *
   * The newer shell draws the header toggle with inline paths instead of the `#chat-temp-checked`
   * sprite `temporaryChatReady()` looked for, so an empty temporary chat stopped proving its mode
   * at all (measured 2026-09-26, English and German). The toggle's owner carries
   * `isTemporaryChat` a few Fibers up — true on `/?temporary-chat=true`, false after switching it
   * off — which is the same state the mounted-turn stamp reads. Only a single consistent answer
   * from visible header buttons stamps the document, with the pathname it was made on.
   */
  function temporaryModeSnapshot() {
    const answers = new Set();
    const buttons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0 &&
      !button.closest(`${OWN_SURFACES},form,[data-turn-key],[data-testid^="conversation-turn"],nav,aside`)).slice(0, 40);
    for (const button of buttons) {
      let at = fiberOf(button);
      for (let up = 0; at && up < 12; up++, at = at.return) {
        const props = at.memoizedProps;
        if (props && typeof props === 'object' && typeof props.isTemporaryChat === 'boolean') { answers.add(props.isTemporaryChat); break; }
      }
    }
    const root = document.documentElement;
    if (answers.size === 1 && answers.has(true)) {
      if (root.getAttribute('data-clf-temporary-page') !== location.pathname) root.setAttribute('data-clf-temporary-page', location.pathname);
    } else root.removeAttribute('data-clf-temporary-page');
  }

  /** Picker data is account-evaluated state, never a scraped English announcement.
   * Copy only selection metadata; no conversation, account object or callbacks cross worlds. */
  function pickerSnapshot() {
    // The closed native trigger retains the same picker owner. Passive recording
    // must not depend on discovery opening its portal first.
    const form = document.querySelector('#prompt-textarea, form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')?.closest('form');
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const triggers = [...new Set([...(form?.querySelectorAll('button[aria-haspopup="menu"]') || []), ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const candidates = [];
    if (triggers.length <= 8) for (const trigger of triggers) {
      try {
        const picker = readPickerSnapshot(trigger) || readShellPickerSnapshot(trigger);
        if (picker) candidates.push({ node: trigger, picker });
      } catch { /* An unrelated native menu is not picker evidence. */ }
    }
    const specific = candidates.filter(candidate => candidate.node.matches(reported));
    const identified = specific.length === 1 ? specific[0] : candidates.length === 1 ? candidates[0] : null;
    const native = triggers.filter(trigger => trigger.matches(reported));
    const fallback = native.length === 1 ? native[0] : triggers.length === 1 ? triggers[0] : null;
    const node = document.querySelector('[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]') || identified?.node || fallback;
    let state = null;
    try { state = identified?.picker || readPickerSnapshot(node); } catch { /* Unknown state invalidates prior proof. */ }
    const selected = state ? state.choices.find(choice => choice.bucket === state.currentBucket && choice.available)
      : (node && node === fallback ? closedPickerSelection(node) : null);
    const provenTrigger = identified?.node || (selected && node === fallback ? fallback : null);
    for (const trigger of triggers) {
      if (trigger !== provenTrigger) trigger.removeAttribute('data-clf-picker-route');
      else if (trigger.getAttribute('data-clf-picker-route') !== location.pathname) trigger.setAttribute('data-clf-picker-route', location.pathname);
      if (trigger !== node) for (const attribute of ['data-clf-selected-model', 'data-clf-selected-effort', 'data-clf-selected-route']) trigger.removeAttribute(attribute);
    }
    for (const [attribute, value] of [['data-clf-selected-model', selected?.id], ['data-clf-selected-effort', selected?.effort], ['data-clf-selected-route', selected && location.pathname]]) {
      if (!value) node?.removeAttribute(attribute);
      else if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    }
    return state;
  }
  /** Shell execution ids are provider identities, not localized presentation. */
  function shellProExecutionModel(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
  }

  /** A shell lane's transport effort when its label is translated. The Extra High lane sends max
   * (English and German pages alike, 2026-10-09), as the September picker's non-Work max did. */
  function shellLaneTransportEffort(value) {
    return ({ none:'none', minimal:'minimal', low:'low', medium:'medium', high:'high', xhigh:'xhigh', max:'xhigh' })[value] ?? null;
  }

  // The native closed picker does not mount composerIntelligencePickerState.
  // Its own ancestor carries the current execution model; its visible label
  // carries the selected effort. These are observation, never catalog discovery.
  function closedPickerSelection(node) {
    const machine = node.getAttribute('data-selected-reasoning-effort');
    // The reported alternate trigger exposes a locale-independent selected effort.
    // Unknown explicit values invalidate proof rather than falling back to its caption.
    const captionEffort = ({ instant: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
      'extra high': 'xhigh', max: 'max', ultra: 'ultra', pro: 'pro' })[String(node.textContent || '').trim().toLowerCase()];
    let model = null, lane = null;
    for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      // The shell picker's selected lane carries the visible effort name: the machine
      // attribute reports its transport value (medium/max) for Pro/Extra High lanes.
      const sel = fiber.memoizedProps?.selectedPowerSelection ?? fiber.memoizedProps?.selectedLabelCandidate;
      if (lane === null && sel) {
        const caption = String(sel.labels?.effort ?? sel.sliderLabel ?? '').trim().toLowerCase();
        lane = { model: sel.model,
          effort: ({ instant:'none', minimal:'minimal', low:'low', medium:'medium', high:'high',
            'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[caption] ?? (caption ? shellLaneTransportEffort(sel.reasoningEffort) : null) };
      }
      const current = fiber.memoizedProps?.currentModelId;
      if (current === undefined) continue;
      if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) return null;
      model = current;
    }
    const effort = shellProExecutionModel(model) ? 'pro' : (lane && lane.model === model && lane.effort) ||
      (machine !== null ? (['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(machine) ? machine : null) : captionEffort);
    if (!effort) return null;
    return model ? { id: model, effort } : null;
  }
  function readPickerSnapshot(node) {
    let fiber = node && fiberOf(node);
    for (let up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      // The September composer retains the unmounted menu as dropdownContent.
      // Read that exact native child too; opening it is unnecessary for observation.
      const owner = fiber.memoizedProps;
      const props = owner?.composerIntelligencePickerState ? owner : owner?.dropdownContent?.props;
      const state = props?.composerIntelligencePickerState, data = props?.modelsData;
      if (!state || !Array.isArray(data?.versions)) continue;
      if (data.versions.length > 20 || !Array.isArray(state.bucketSelections) || state.bucketSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      // Native version groups may have spaces; execution slugs retain their strict contract.
      const groupId = value => typeof value === 'string' && value.length <= 80 && /^[\p{L}\p{N}._ -]+$/u.test(value) && value.trim() === value && value.trim() ? value : null;
      const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 ? value.trim() : null;
      const effortOf = choice => choice.category?.modelLane === 'pro' ? 'pro'
        : ['auto', 'instant'].includes(choice.category?.modelLane) ? 'none'
        : choice.thinkingEffort === 'max' && choice.modelConfig?.isWorkModeModel === true ? 'max'
        : ({ min: 'low', standard: 'medium', extended: 'high', max: 'xhigh', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'ultra' })[choice.thinkingEffort] || null;
      const choices = state.bucketSelections.map(choice => {
        const name = label(choice.category?.shortLabel);
        // Native navigation groups may contain spaces or localized names. Those
        // are not execution ids: retain the exact provider slug for such families.
        const familyId = id(choice.category?.modelVersion) || id(choice.modelSlug);
        const family = data.versions.find(version => version.id === choice.category?.modelVersion);
        return { bucket: choice.bucket, id: id(choice.modelSlug),
          label: name && (/^\d/.test(name) ? `GPT-${name}` : name), effort: effortOf(choice),
          familyId, familyLabel: label(family?.displayTextForIntelligence) || label(choice.modelConfig?.title) || (name && (/^\d/.test(name) ? `GPT-${name}` : name)),
          available: choice.availability?.status === 'available' && !props.modelSwitcherDenialsBySlug?.[choice.modelSlug] };
      });
      const versions = data.versions.filter(version => version.enabled === true).map(version => ({ id: groupId(version.id), label: label(version.displayTextForIntelligence) }));
      if (!versions.length || versions.some(v => !v.id || !v.label) || choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length) return null;
      const version = groupId(state.selectedVersionEntry?.id), currentBucket = state.currentBucket;
      if (!versions.some(v => v.id === version) || !choices.some(c => c.bucket === currentBucket)) return null;
      const selected = state.currentSelection;
      const chosen = choices.find(c => c.bucket === currentBucket);
      if (selected?.modelSlug !== chosen.id || effortOf(selected) !== chosen.effort) return null;
      return { version, currentBucket, versions, choices };
    }
    return null;
  }

  /** @ehkogh/#318: the shell's evaluated powers normalize into the existing picker
   * contract. Execution ids remain families here: a mixed Latest group is not one model. */
