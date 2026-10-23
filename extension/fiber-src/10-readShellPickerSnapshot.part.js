  function readShellPickerSnapshot(node) {
    for (let fiber = node && fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!Array.isArray(p?.powerSelections)) continue;
      const selected = p.selectedPowerSelection ?? p.selectedLabelCandidate, options = p.modelListConfig?.options;
      if (!selected || !Array.isArray(options) || options.length > 20 || p.powerSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      const group = value => typeof value === 'string' && /^[\p{L}\p{N}._ -]{1,80}$/u.test(value) && value.trim() === value ? value : null;
      const label = value => typeof value === 'string' && value.trim() && value.length <= 80 ? value.trim() : null;
      const effort = value => ({ none:'none', instant:'none', minimal:'minimal', min:'low', low:'low', standard:'medium', medium:'medium', extended:'high', high:'high', xhigh:'xhigh', 'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[value] || null;
      // The machine reasoningEffort is a lane's transport setting, not its identity: the
      // Pro and Extra High lanes still report medium/max. The lane's visible label is what
      // the picker offers, matching readPickerSnapshot's modelLane/thinkingEffort mapping.
      // A translated label ("Sehr hoch") falls back to that transport value, where max is Extra High.
      const laneEffort = c => shellProExecutionModel(c?.model) ? 'pro' :
        effort(String(c?.labels?.effort ?? c?.sliderLabel ?? '').trim().toLowerCase()) ??
        ((c?.labels?.effort ?? c?.sliderLabel) ? shellLaneTransportEffort(c?.reasoningEffort) : effort(c?.reasoningEffort));
      const current = options.filter(o => o?.selected === true);
      if (current.length !== 1) return null;
      const version = group(current[0].id);
      const versions = options.filter(o => o && o.disabled !== true).map(o => ({ id: group(o.id), label: label(o.label) }));
      // The shell names older models by number alone ("5.6"); the September picker's own rule
      // names them in full, so the list reads GPT-6, GPT-5.6, GPT-5.5 alike.
      const modelName = value => { const name = label(value); return name && /^\d/.test(name) ? `GPT-${name}` : name; };
      const choices = p.powerSelections.map(c => ({ bucket: c?.powerSettingIndex, id: id(c?.model),
        label: modelName(c?.modelLabel), familyId: id(c?.model), familyLabel: modelName(c?.modelLabel), effort: laneEffort(c),
        available: p.modelSelectionDisabled !== true && c?.disabled !== true &&
          (!c?.availability || c.availability.status === 'available') && !p.modelSwitcherDenialsBySlug?.[c?.model] }));
      if (!version || !versions.length || versions.some(v => !v.id || !v.label) || !choices.length ||
          choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length || !versions.some(v => v.id === version)) return null;
      // One model's Instant and thinking lanes are separate slugs under one name (gpt-6 and
      // gpt-6-thinking, both "GPT-6"; observed 2026-10-07). They are one family, as the September
      // picker had them, so the effort control offers Instant, Medium and High together. Lanes join
      // only under one name in this version and with distinct efforts: a mixed group never merges.
      // GPT-6's Instant lane is ChatGPT's automatic `gpt-6`, which its server may answer with the
      // thinking lane; the fixed `gpt-6-instant` exists but no native view offers it (2026-10-08).
      for (const name of new Set(choices.map(c => c.label))) {
        const lanes = choices.filter(c => c.label === name);
        if (lanes.length < 2 || new Set(lanes.map(c => c.effort)).size !== lanes.length) continue;
        const shared = lanes.map(c => c.id).reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); })
          .replace(/[-._]+$/, '');
        const family = id(shared) && /\d/.test(shared) ? shared : lanes[0].id;
        for (const lane of lanes) lane.familyId = family;
      }
      const matches = choices.filter(c => c.id === id(selected.model) && c.effort === laneEffort(selected));
      if (matches.length !== 1 || (selected.powerSettingIndex !== undefined && selected.powerSettingIndex !== matches[0].bucket)) return null;
      return { version, currentBucket: matches[0].bucket, versions, choices };
    }
    return null;
  }

  /**
   * What reading one connector's declarations back from the page may cost (#864 follow-up).
   *
   * The app publishes at most 250,000 UTF-8 bytes of Plugins declarations
   * (src/main/plugins/exposure.ts). copySchema charges each character as three bytes, the
   * worst case, plus key overhead, so the old 280,000 rejected anything above roughly 93 KB of
   * text: a Unity plugin's 82 tools (about 116 KB) made every Plugins refresh fail with an
   * unreadable settings card. Three times the publication budget, with room for key overhead,
   * reads back everything the app can publish; the isolated world and the app still cap the
   * projected JSON at 300,000 characters.
   */
  const PLUGIN_SCHEMA_READ_BYTES = 900000;

  function copySchema(value, budget, depth = 0) {
    if (depth > 32 || --budget.nodes < 0) throw new Error('schema_bound');
    const spend = bytes => { budget.bytes -= bytes; if (budget.bytes < 0) throw new Error('schema_bound'); };
    if (value === null) { spend(4); return null; }
    if (typeof value === 'string') { spend(value.length * 3 + 2); return value; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { spend(32); return value; }
    if (!value || typeof value !== 'object') throw new Error('schema_shape');
    if (Array.isArray(value)) {
      if (value.length > budget.nodes) throw new Error('schema_bound');
      spend(value.length + 2); return value.map(item => copySchema(item, budget, depth + 1));
    }
    const keys = Object.keys(value);
    if (keys.length > budget.nodes) throw new Error('schema_bound');
    const result = Object.create(null);
    for (const key of keys) {
      spend(key.length * 3 + 4);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('schema_accessor');
      result[key] = copySchema(descriptor.value, budget, depth + 1);
    }
    return result;
  }

  /**
   * The newer shell moved plugin management out of the settings dialog onto a full page,
   * `/settings/plugins-settings/plugin_<app>`, and ChatGPT now drops the old `#settings/Plugins`
   * hash entirely. Measured 2026-09-27: the page has no tab panel, no `reportEntity` card and no
   * `actions` prop; the connector object (with its `actions`) sits a few Fibers above each
   * management button, and only the Refresh-tools button's own wrapper carries a `loading`
   * state besides the row's "Actions" menu trigger (`aria-haspopup`). Delete and Uninstall are
   * `danger*` coloured; either marker disqualifies a control in any language. Every CoS connector refresh on the new layout failed with "the connector settings
   * card could not be read", so ChatGPT kept whatever tool list it had before an update.
   */
  function pagePluginSnapshot(appId) {
    const buttons = [...document.querySelectorAll('main button')].slice(0, 200);
    let connector = null, control = null;
    for (const button of buttons) {
      if (!button.getClientRects().length) continue;
      let fiber = fiberOf(button), loading = false, unsafe = false, owner = null;
      for (let up = 0; fiber && up < 16; up++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        if (up <= 2) {
          if (own.call(props, 'loading')) loading = true;
          if (own.call(props, 'aria-haspopup') || (typeof props.color === 'string' && /danger|destructive/i.test(props.color))) unsafe = true;
        }
        if (props.connector && typeof props.connector === 'object') { owner = props.connector; break; }
      }
      if (!owner || owner.id !== appId) continue;
      if (connector && connector !== owner) return null;
      connector = owner;
      // Never a destructive control, whatever its wrapper looks like.
      if (loading && !unsafe && !/\b(?:delete|remove|uninstall|disconnect)\b/i.test(button.textContent || '')) {
        if (control && control !== button) return null;
        control = button;
      }
    }
    if (!connector || !Array.isArray(connector.actions) || typeof connector.name !== 'string') return null;
    const externalPlugins = pluginsConnectorApp(connector.name, connector.id);
    // A sanity bound, not a catalog: the app's own Core and Desktop declare a few dozen tools at most
    // (Windows Desktop 24 in 2.1.44, which the old bound of 16 refused, #1763); Plugins holds every
    // enabled external plugin's tools. A test keeps 64 above what Core and Desktop declare.
    if ((!connector.actions.length && !externalPlugins) || connector.actions.length > (externalPlugins ? 257 : 64)) return null;
    const budget = { bytes: PLUGIN_SCHEMA_READ_BYTES, nodes: 20000 };
    // Measured 2026-09-27: this page sends `description_model: ""` rather than null, so `??`
    // read every declaration as empty and no refresh could ever match the published schema.
    const tools = connector.actions.map(action => ({ name: action.name, description: copySchema(action.description_model || action.description, budget), inputSchema: copySchema(action.params, budget) }));
    if (tools.some(tool => !NAME.test(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') ||
        new Set(tools.map(tool => tool.name)).size !== tools.length) return null;
    if (control && control.getAttribute('data-clf-plugin-refresh') !== appId) control.setAttribute('data-clf-plugin-refresh', appId);
    // `settled`: the actions arrive in the same response as the connector itself, so an empty
    // list here is the installed state (a stale Plugins connector), not a list still loading.
    const tunnelId = typeof connector.tunnel_id === 'string' && /^tunnel_[a-zA-Z0-9]{8,80}$/.test(connector.tunnel_id) ? connector.tunnel_id : null;
    return { appId, connectorName: connector.name.slice(0, 100), versionId: str(connector.app_metadata?.version_id), tools, refreshAvailable: !!control, tunnelId, settled: true };
  }

  function pluginSnapshot() {
    const pageRoute = /^\/(?:settings\/plugins-settings|plugins)\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.pathname);
    if (pageRoute && !location.hash) return pagePluginSnapshot(pageRoute[1]);
    const route = /^#settings\/Plugins\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.hash);
    if (!route) return null;
    // The hash already names one exact installed connector settings route. Provider tab labels
    // are localized, so the remaining DOM proof is simply one visible tabpanel for that route;
    // ambiguity still fails closed rather than guessing between multiple mounted panels.
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(panel => !panel.hidden);
    if (panels.length !== 1) return null;
    const buttons = [...panels[0].querySelectorAll('button')].slice(0, 100);
    let result = null, control = null, observedActions = null, observedCard = null;
    for (const button of buttons) {
      let fiber = fiberOf(button);
      for (let up = 0; fiber && up < 24; up++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props) continue;
        if (props.reportEntity?.entityType === 'connector' && props.reportEntity.id === route[1] &&
            Array.isArray(props.details) && props.details.some(detail => detail.value === route[1]) &&
            button.getClientRects().length > 0) {
          if (observedCard && observedCard !== props) return null;
          observedCard = props;
          if (props.headerTrailingContent) {
            if (control && control !== button) return null;
            control = button;
          }
        }
        if (props.connector?.id !== route[1] || !Array.isArray(props.actions) || props.isLoadingActions === true) continue;
        if (props.actions === observedActions) continue;
        if (observedActions) return null;
        observedActions = props.actions;
        const externalPlugins = pluginsConnectorApp(props.connector.name, props.connector.id);
        if ((!props.actions.length && !externalPlugins) || props.actions.length > (externalPlugins ? 257 : 64) || typeof props.connector.name !== 'string') return null;
        const budget = { bytes: PLUGIN_SCHEMA_READ_BYTES, nodes: 20000 };
        const tools = props.actions.map(action => ({ name: action.name, description: copySchema(action.description_model ?? action.description, budget), inputSchema: copySchema(action.params, budget) }));
        if (tools.some(tool => !NAME.test(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') ||
            new Set(tools.map(tool => tool.name)).size !== tools.length) return null;
        result = { appId: route[1], connectorName: props.connector.name.slice(0, 100),
          versionId: str(props.connector.app_metadata?.version_id), tools };
      }
    }
    if (!result || !observedCard) return null;
    // Stamp only the native button wired to this connector's header action. Never
    // invoke page callbacks; the isolated world still owns the durable claim and click.
    if (control && control.getAttribute('data-clf-plugin-refresh') !== route[1]) control.setAttribute('data-clf-plugin-refresh', route[1]);
    return { ...result, refreshAvailable: !!control };
  }

  /**
   * Branch in new chat (#482): marks ChatGPT's own "new chat" entry in the open Branch submenu.
   *
   * The submenu's entries differ only by label and handler: Work mode's handler names its
   * upsell/work surface, the new chat's does not. Labels are translated, so the handler decides,
   * and exactly one entry must qualify. Reads handler source only; calls nothing.
   */
  function markBranchNewChat(nonce) {
    const triggers = [...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"][aria-expanded="true"]')]
      .filter(item => item.querySelector('svg use[href*="#branch"]'));
    if (triggers.length !== 1) return 0;
    const menu = document.getElementById(triggers[0].getAttribute('aria-controls') || '');
    if (!menu) return 0;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const handler = item => {
      let fiber = null;
      for (const key in item) if (key.indexOf('__reactFiber$') === 0) { fiber = item[key]; break; }
      for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
        const onSelect = fiber.memoizedProps && fiber.memoizedProps.onSelect;
        if (typeof onSelect === 'function') return Function.prototype.toString.call(onSelect);
      }
      return null;
    };
    for (const item of items) item.removeAttribute('data-clf-branch-new-chat');
    const plain = items.filter(item => { const source = handler(item); return typeof source === 'string' && !/work/i.test(source); });
    if (plain.length !== 1) return plain.length;
    plain[0].setAttribute('data-clf-branch-new-chat', nonce);
    return 1;
  }

  /**
   * Edit & resubmit (#365): marks the Edit control of one question with `nonce`, chosen by handler
   * (ChatGPT's own edit action on a user message), never by its translated label. The question's
   * turn is `[data-turn-key=<id>]` on the newer shell (its key is the question's id), or the turn
   * holding `[data-message-id=<id>]` on the older page. Returns how many controls matched; only
   * exactly one is marked.
   */
  function markQuestionEdit(nonce, messageId) {
    if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(messageId)) return 0;
    for (const node of document.querySelectorAll('[data-clf-edit]')) node.removeAttribute('data-clf-edit');
    const keyed = [...document.querySelectorAll('[data-turn-key]')].filter(node => node.getAttribute('data-turn-key') === messageId);
    const legacy = [...document.querySelectorAll('[data-message-id]')].filter(node => node.getAttribute('data-message-id') === messageId)
      .map(node => node.closest('[data-testid^="conversation-turn"], article'));
    const turns = [...new Set([...keyed, ...legacy].filter(Boolean))];
    if (turns.length !== 1) return 0;
    const handler = button => {
      let fiber = null;
      for (const key in button) if (key.indexOf('__reactFiber$') === 0) { fiber = button[key]; break; }
      for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
        const onClick = fiber.memoizedProps && fiber.memoizedProps.onClick;
        if (typeof onClick === 'function') return Function.prototype.toString.call(onClick);
      }
      return '';
    };
    const edits = [...turns[0].querySelectorAll('button')].filter(button => {
      const source = handler(button);
      return /action:\s*"edit"/.test(source) && /surface:\s*"user_message"/.test(source);
    });
    if (edits.length === 1) edits[0].setAttribute('data-clf-edit', nonce);
    return edits.length;
  }
