/** Focused adaptation of @ehkogh's observed shell fixtures in #318 (c18f289c).
 * Only page identity, authored messages, tool evidence and the native picker.
 * No cache-derived message history, invented receipts or alternate presentation. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const ANSWER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
let page: JSDOM;
afterEach(() => page?.window.close());

function fixture() {
  page = new JSDOM(`<div id="root"><aside id="app-shell-sidebar"></aside><main data-app-shell-main-surface>
    <div data-thread-find-target="conversation"><div data-turn-key="${USER}"><div data-content-search-turn-key="${TURN}">
      <div data-content-search-unit-key="${TURN}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap">hello</div></div></div>
      <div><span hidden data-chatgpt-agent-turn-start></span><button aria-expanded="true">Worked for 1s</button>
        <div data-markdown-text-style="assistant-message">Commentary without a provider message id</div></div>
      <div data-content-search-unit-key="${TURN}:2:assistant"><div data-markdown-text-style="assistant-message">Answer</div></div>
    </div></div></div>
    <form data-chatgpt-composer><div data-composer-body><div contenteditable="true" role="textbox" data-composer-markdown><p><br></p></div>
      <button type="button" data-composer-navigation-target="add-context">+</button>
      <button type="button" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium">Mittel</button>
      <button type="submit" aria-label="Senden">Senden</button>
    </div></form></main></div>`, { url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = data => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as any, origin: win.location.origin })));
  const chain = (props: any, parent: any = null) => ({ memoizedProps: props, return: parent });
  const queries: any[] = [];
  const cache = { getAll: () => queries };
  const top = chain({ client: { getQueryCache: () => cache } });
  const entry = { id: TURN, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [USER, CALL, ANSWER], items: [
    { type: 'user-message', messageId: USER, serverMessageId: USER, message: 'hello' },
    { type: 'chatgpt-reasoning-group', items: [
      { type: 'reasoning', presentation: 'preamble', content: 'Commentary without a provider message id' },
      { type: 'mcp-tool-call', callId: CALL, completed: false, invocation: { server: 'Chat On Steroids Core', tool: 'link_x/read', arguments: { private: 'NEVER_COPY_TOOL_ARGS' } }, result: null }
    ] },
    { type: 'assistant-message', messageId: ANSWER, content: 'Answer', phase: 'final_answer', completed: false }
  ] as any[] } };
  const row = chain({ entry }, top);
  (doc.querySelector('[data-turn-key]') as any).__reactFiber$fixture = row;
  (doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-markdown-text-style]') as any).__reactFiber$fixture = chain({ item: entry.turn.items[2], conversationId: THREAD }, row);
  const versions = [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }, { id: 'future', label: '未来モデル', selected: false }];
  const selections = [
    [ { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'medium', powerSettingIndex: 1 },
      { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'high', powerSettingIndex: 2 } ],
    [ { model: 'future-thinking', modelLabel: '未来モデル', reasoningEffort: 'high', powerSettingIndex: 1 },
      { model: 'future-pro', modelLabel: '未来 Pro', reasoningEffort: 'pro', powerSettingIndex: 2 } ]
  ];
  const props: any = { powerSelections: selections[0], selectedLabelCandidate: selections[0]![0], selectedPowerSelection: null,
    modelListConfig: { options: versions }, modelSelectionDisabled: false };
  const trigger = doc.querySelector('[data-codex-intelligence-trigger]') as HTMLButtonElement;
  (trigger as any).__reactFiber$fixture = chain(props, top);
  const actions = vi.fn();
  const render = () => {
    let panel = doc.querySelector('[data-model-picker-view]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', 'simple'); panel.setAttribute('role', 'menu'); doc.body.append(panel); }
    // The portal intentionally has no picker owner; only the trigger does.
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle>Version</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.querySelector('[data-model-picker-view-toggle]')!.addEventListener('click', () => {
      panel.replaceChildren();
      for (const [index, version] of versions.entries()) {
        const option = doc.createElement('div'); option.setAttribute('role', 'menuitemradio'); option.textContent = version.label;
        option.addEventListener('keydown', (event: any) => { if (event.key !== 'Enter') return;
          actions('version'); versions.forEach(v => { v.selected = v === version; }); props.powerSelections = selections[index];
          props.selectedPowerSelection = selections[index]![0]; render(); }); panel.append(option);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      const selected = props.selectedPowerSelection ?? props.selectedLabelCandidate;
      const at = props.powerSelections.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!props.powerSelections[at]) return; actions('effort'); props.selectedPowerSelection = props.powerSelections[at]; render();
    });
  };
  trigger.addEventListener('keydown', event => { if (event.key === 'Enter') render(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') doc.querySelector('[data-model-picker-view]')?.remove(); });
  win.eval(fiberSource); win.eval(domSource);
  let serial = 0;
  const ask = (source = 'clf-fiber-ask') => new Promise<any>((resolve, reject) => {
    const nonce = `shell-${++serial}`, expected = source.replace('-ask', '-reply');
    const timer = setTimeout(() => { win.removeEventListener('message', receive as any); reject(new Error('Missing helper reply')); }, 2500);
    const receive = (event: MessageEvent) => { if (event.data?.source !== expected || event.data.nonce !== nonce) return;
      clearTimeout(timer); win.removeEventListener('message', receive as any); resolve(event.data); };
    win.addEventListener('message', receive as any); win.postMessage({ source, nonce }, win.location.origin);
  });
  return { api: (win as any).CLF_DOM, doc, win, entry, row, top, props, versions, selections, trigger, actions, queries, ask, chain };
}

// Models the observed Markdown editor's native text/break serialization, not
// the app's receipt check. No exported scripts, credentials or chat text are used.
it('recovers same-message DIL fallback when shell content is empty or only DilResponseRoot', async () => {
  const f = fixture();
  const answer = f.entry.turn.items[2];
  answer.contentReferences = [{ type: 'dil', source_message_id: ANSWER, model_dil_v2: { fallbackMarkdown: '**Recovered**' } }];
  for (const content of ['', '  ', 'DilResponseRoot']) {
    answer.content = content;
    const turn = (await f.ask()).turns[0];
    expect(turn.messages.find((m: any) => m.rawMessageId === ANSWER).rawText).toBe('**Recovered**');
  }
  answer.contentReferences = [{ type: 'dil', source_message_id: OTHER, model_dil_v2: { fallbackMarkdown: 'Wrong owner' } }];
  answer.content = 'DilResponseRoot';
  expect((await f.ask()).turns[0].messages.find((m: any) => m.rawMessageId === ANSWER).rawText).toBe('DilResponseRoot');
});
