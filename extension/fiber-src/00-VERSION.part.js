/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * A collapsed connector row shows the word "Called tool" and
 * nothing else, but the React Fiber behind it already knows exactly which tool ran, under
 * which connector, and how many further calls that single row is standing in for. That
 * last part is why this file has to exist at all — the page renders one row for a run of
 * calls, not always to the same tool, so the visible rows are not a list of the calls, and
 * no amount of DOM reading from the isolated world can recover the ones it folded away.
 * The same bounded bridge also reads account-evaluated model choices and the installed
 * connector's public tool declarations. Neither path exports account/session objects or
 * invokes React action callbacks; the named serverId$ signal is read only for durable
 * conversation identity. The isolated world owns UI actions and operation claims.
 *
 * Everything here is written on the assumption that it is the least trusted code in the
 * extension:
 *
 *  · **It runs where the page can reach it.** ChatGPT could replace `JSON.parse`,
 *    `postMessage`, `Array.prototype.map` — anything this file touches. Native references
 *    are captured at load, before the page has had a chance to react to us, and the file
 *    is kept short so there is little to subvert.
 *  · **It emits an allowlist, never a filtered copy.** Only the named fields below cross
 *    into the extension. Copying the props and deleting the sensitive parts would be a
 *    denylist, and one renamed field would be a leak — the request JSON has been observed
 *    carrying tool arguments verbatim.
 *  · **It emits no argument values at all, and does not even parse them.** Tool arguments
 *    are the user's own text and this app's own secrets, and there is no key-level
 *    allowlist that generalises across tools. The request payload is never handed to
 *    `JSON.parse`; only the tool path anchored at the very front of it is read, so `args`
 *    is never walked at all. The tool's identity is what relabelling actually needs; the
 *    app already knows the arguments for every call it ran itself.
 *  · **It fails closed.** An unrecognised Fiber shape yields `null` for that row, which
 *    leaves the row exactly as ChatGPT drew it. Guessing would put a wrong tool name on a
 *    real call, which is worse than the generic label it replaced.
 *
 * The receiving side treats everything here as page-controlled evidence regardless: the
 * page can post these same messages itself. See the trust note in content.js.
 */

(() => {
  'use strict';

  /** Bumped when the descriptor shape changes, so a stale pair cannot half-understand. */
  const VERSION = 22;
  // The MAIN world survives an extension reload because the ChatGPT document survives it.
  // Recovery may therefore execute this file again in a page that still has an older helper
  // listener. Retire it across versions too: picker/plugin replies use their own v1
  // protocol, so an older listener can otherwise win with an empty or stale snapshot.
  const ACTIVE_HELPER = '__clfFiberHelper';
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** Only a successfully described connector row carries this scan reference. */
  const CONNECTOR = '[data-clf-fiber]';
  /**
   * A runaway guard on the climb, not a claim about how the page is shaped.
   *
   * This was 30, taken from an observed depth, and the live page put the group node at
   * exactly 30 — one past `up < MAX_CLIMB`. Every row of every chat then produced no
   * descriptor at all, silently, because failing closed is indistinguishable from a
   * browser where this helper never ran. What stops the climb now is `groupOf`'s own test
   * for the shape it wants; this number only keeps a detached or cyclic tree from looping.
   */
  const MAX_CLIMB = 80;
  /**
   * How far a node may sit below React's root. ChatGPT's tree reached 405 levels on 2026-10-02
   * (#969); at the old limit of 400 the committed root was never found, so the model picker and
   * the shell's query client read as unavailable and Send failed to confirm its model.
   */
  const MAX_ROOT_DEPTH = 2048;
  const MAX_TEXT = 200;
  /** A page with more connector rows than this is not one we need to read exhaustively. */
  const MAX_ROWS = 400;
  /** Mounted section groups read per scan, including user and assistant groups. */
  const MAX_TURNS = 6;
  /** Connector requests reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  /** Public generated-image descriptors retained per turn. Pixels never cross this boundary. */
  const MAX_GENERATED_IMAGES = 200;
  /** ChatGPT's own turn anchors, which is where a turn's message model hangs. */
  // Shell anchors and typed items adapted from @ehkogh's #318. Keep one wire format.
  const LEGACY_TURN_SECTION = 'section[data-testid^="conversation-turn"]';
  const SHELL_TURN = '[data-app-shell-main-surface] [data-thread-find-target="conversation"] [data-turn-key]';
  const SEARCH_TURN_ANCHOR = '[data-chatgpt-search-unit-key$=":user"]';
  const SEARCH_TURN_UNIT = '[data-chatgpt-search-unit-key]';
  const TURN_SECTION = `${LEGACY_TURN_SECTION}, ${SHELL_TURN}, ${SEARCH_TURN_ANCHOR}`;
  /** ChatGPT-rendered authored prose. Tool rows and this extension's own surfaces are excluded. */
  const MARKDOWN = '.markdown, [data-markdown-text-style="assistant-message"]';
  const TOOL = 'span[class*="tool-message"], div.pointer-events-none.contents, div:has(> [data-testid="cot-v5-tool-icon-pile"])';
  const GENERATED_IMAGE = '[class~="group/imagegen-image"] img, [class~="group/generated-image-preview"] img';
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';
  const MAX_RENDERED_HTML = 120_000;
  // An exact, stable assistant final can have far more than 120k of decorative
  // markup around the prose. Carry a compact text rendering, not a cut HTML tag.
  const MAX_LARGE_FINAL_HTML = 256_000;
  // A 15k–20k-token compaction answer is routinely 60k–90k characters. Capping public
  // assistant prose at 32k here made the canonical session transcript lose the back half
  // even though Compact & Resume itself carried the full DOM answer. One event still stays
  // comfortably below the 512 KiB bridge body cap alongside its bounded rendered HTML.
  // Safety guard only. Compact & Resume is specified in tokens (up to 30k), so this must be
  // comfortably larger than a normal handoff rather than acting as a second token budget.
  const MAX_RENDERED_TEXT = 256_000;
  /** Aggregate authored text/HTML copied through MAIN -> isolated world in one scan. */
  const MAX_RESPONSE_TEXT = MAX_TURNS * 512 * 1024;
  const MAX_TURN_TEXT = 512 * 1024;
  /** A turn outline (`shellTurnTrace`): items, one sentence block, one recap, and all of its text. */
  const MAX_TRACE_ITEMS = 400;
  const MAX_TRACE_SAY = 8000;
  const MAX_TRACE_RECAP = 300;
  const MAX_TRACE_TEXT = 128 * 1024;

  function budgetedText(value, budget, perValueLimit) {
    if (typeof value !== 'string' || !value || !budget || budget.remaining <= 0) return '';
    const limit = Math.max(0, Math.min(perValueLimit, budget.remaining));
    if (limit === 0) return '';
    const taken = value.slice(0, limit);
    budget.remaining -= taken.length;
    return taken;
  }
  /**
   * The connectors this app is reached through. Nothing else is ours to vouch for.
   *
   * There is more than one now: 1.7.1 split the model-facing surface into a Core and a
   * Desktop connector, so a single hardcoded name stopped matching *anything* the page
   * held — every call in every chat lost its page evidence at once and was filed outside
   * the conversation that made it. The name is not user input: ChatGPT takes `app_name`
   * from the `resource_name` this app serves in its own protected-resource metadata
   * (`server.ts`), so these are this app naming itself rather than labels somebody typed.
   * The pre-1.7.1 name stays so an older chat's evidence still reads.
   *
   * Exact names, never a prefix: `Chat On Steroids Backup` would be somebody else's
   * connector, and a prefix test would have this app vouch for its traffic.
   *
   * A computer that shares its ChatGPT account with another names its connectors with a suffix
   * ("Chat On Steroids Core (Windows)"). The content script passes this install's names with
   * every ask, and only those are ours: the other computer's calls run there, not here. Measured
   * 2026-10-04: the call path, `invocation.server` and `app_name` all carry the name as typed.
   */
  const PLAIN_APPS = ['Chat On Steroids Core', 'Chat On Steroids Desktop', 'Chat On Steroids Plugins'];
  const LEGACY_APPS = ['TobisComputer'];
  const SUFFIXED_APP = /^Chat On Steroids (Core|Desktop|Plugins) \([\p{L}\p{N} ._-]{1,32}\)$/u;
  let OUR_APPS = [...PLAIN_APPS, ...LEGACY_APPS];
  /** Takes the names an ask carries: three "Chat On Steroids …" names, in core/desktop/plugins order. */
  function adoptAppNames(names) {
    if (!Array.isArray(names) || names.length !== 3) return;
    const words = ['Core', 'Desktop', 'Plugins'];
    for (let at = 0; at < 3; at++) {
      const name = names[at];
      if (typeof name !== 'string' || (name !== PLAIN_APPS[at] && SUFFIXED_APP.exec(name)?.[1] !== words[at])) return;
    }
    OUR_APPS = [...names, ...LEGACY_APPS];
  }
  /** The Plugins connector of any computer: it only sets that connector's larger action limits. */
  function pluginsConnectorName(name) {
    return name === PLAIN_APPS[2] || SUFFIXED_APP.exec(typeof name === 'string' ? name : '')?.[1] === 'Plugins';
  }

  /**
   * This install's proven connector apps ({ surface, appId, linkId, name }), from the app's
   * status (connector-identity.ts). ChatGPT keeps an app's `asdk_app_…` and `link_…` ids when the
   * user renames it (measured 2026-10-11), so a renamed connector is still recognized by them.
   */
  const APP_ID = /^asdk_app_[A-Za-z0-9_-]{1,160}$/, LINK_ID = /^link_[A-Za-z0-9_-]{1,160}$/;
  const SURFACES = ['core', 'desktop', 'plugins'];
  let OUR_APP_IDS = [];
  function adoptAppIds(list) {
    if (!Array.isArray(list)) return;
    const next = [];
    for (let at = 0; at < list.length && next.length < 12; at++) {
      const app = list[at];
      if (!app || typeof app.appId !== 'string' || !APP_ID.test(app.appId) || !SURFACES.includes(app.surface)) continue;
      next.push({ surface: app.surface, appId: app.appId,
        linkId: typeof app.linkId === 'string' && LINK_ID.test(app.linkId) ? app.linkId : null,
        name: typeof app.name === 'string' && app.name ? app.name : null });
    }
    OUR_APP_IDS = next;
  }
  /** This install's Plugins connector, by name or (after a rename) by its proven app id. */
  function pluginsConnectorApp(name, appId) {
    return pluginsConnectorName(name) || (typeof appId === 'string' && OUR_APP_IDS.some(app => app.surface === 'plugins' && app.appId === appId));
  }
  /** `/asdk_app_…/link_…/tool` → the app id, or null. */
  function appIdOf(resource) {
    if (typeof resource !== 'string' || resource.charCodeAt(0) !== 47) return null;
    const end = resource.indexOf('/', 1), id = resource.slice(1, end > 0 ? end : undefined);
    return APP_ID.test(id) ? id : null;
  }
  /** `/<name or app id>/link_…/tool` → the link id, or null. */
  function linkIdOf(path) {
    if (typeof path !== 'string' || path.charCodeAt(0) !== 47) return null;
    const parts = path.split('/');
    return parts.length >= 4 && LINK_ID.test(parts[2]) ? parts[2] : null;
  }
  /** Which surface a configured or proven name belongs to, or null. */
  function surfaceOfName(name) {
    for (let at = 0; at < 3; at++) if (OUR_APPS[at] === name) return SURFACES[at];
    for (let at = 0; at < OUR_APP_IDS.length; at++) if (OUR_APP_IDS[at].name === name) return OUR_APP_IDS[at].surface;
    return null;
  }
  /**
   * A name is ours, exactly as before, unless its surface already has a proven app and this row
   * names a different one: then a same-named app is somebody else's.
   */
  function ownByName(name, appId, linkId) {
    if (typeof name !== 'string') return false;
    for (let at = 0; at < LEGACY_APPS.length; at++) if (LEGACY_APPS[at] === name) return true;
    const surface = surfaceOfName(name);
    if (!surface) return false;
    const known = OUR_APP_IDS.filter(app => app.surface === surface);
    if (!known.length) return true;
    if (appId) return known.some(app => app.appId === appId);
    if (linkId) return known.some(app => app.linkId === linkId);
    return true;
  }
  /** Whether a result row (`invoked_resource`) belongs to one of this app's own connectors. */
  function ownResult(result) {
    if (!result) return false;
    const appId = appIdOf(result.resource);
    if (appId && OUR_APP_IDS.some(app => app.appId === appId)) return true;
    return ownByName(result.app, appId, linkIdOf(result.resource));
  }
  /** Whether a request path — `/<connector>/link_…/<tool>` — is one of ours. */
  function ownRequestPath(path) {
    if (typeof path !== 'string' || path.charCodeAt(0) !== 47) return false;
    const linkId = linkIdOf(path);
    if (linkId && OUR_APP_IDS.some(app => app.linkId === linkId)) return true;
    const end = path.indexOf('/', 1);
    return end > 1 && ownByName(path.slice(1, end), null, linkId);
  }
  /** Names `mcp-tool-call` steps may carry for ours: configured and proven (spaces may be `_`). */
  function ownServerName(name) {
    if (typeof name !== 'string') return null;
    const names = [...OUR_APPS];
    for (let at = 0; at < OUR_APP_IDS.length; at++) if (OUR_APP_IDS[at].name) names.push(OUR_APP_IDS[at].name);
    return names.find(app => name === app || name === app.replaceAll(' ', '_')) || null;
  }
  /**
   * The tool path at the very front of a request payload.
   *
   * Anchored, and it stops at the first quote, so it can only ever see the path — never a
   * key or value from `args`, including the `path` argument a file tool takes, which is a
   * second `"path"` later in the same string.
   */
  const PATH_HEAD = /^\s*\{\s*"path"\s*:\s*"([^"\\]{1,200})"/;
  /** A tool name we are willing to put on a row. */
  const NAME = /^[a-z0-9_.-]{1,64}$/i;

  // Captured before the page can swap them. If the page has already replaced one of these
  // at load time there is nothing to be done about it, but it cannot do so afterwards.
  const post = window.postMessage.bind(window);
  const own = Object.prototype.hasOwnProperty;

  /** A short, plain string or null. Never a number, object, or anything with a toString. */
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
  }

  /** A model slug such as `gpt-5-6-thinking`, or null. Slugs are short ids, never prose. */
  function modelSlugOf(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : null;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function int(value) {
    const raw = num(value);
    return raw === null ? 0 : Math.max(0, Math.min(999, Math.round(raw)));
  }

  // One synchronous observation owns these path views. Never retain a React tree
  // between requests or mutate its return pointers when a memoized child is shared.
  let currentPaths = null;
  function committedPath(fiber) {
    const path = [], seen = new Set();
    let at = fiber, base = null, paired = false;
    const view = (node, parent) => ({ memoizedProps: node.memoizedProps,
      memoizedState: node.memoizedState, updateQueue: node.updateQueue, return: parent });
    const remember = (node, value) => {
      currentPaths?.set(node, value);
      if (node.alternate) currentPaths?.set(node.alternate, value);
    };
    while (at && path.length < MAX_ROOT_DEPTH) {
      if (seen.has(at)) return null;
      seen.add(at);
      const cached = currentPaths?.get(at);
      if (cached && cached.root.current === cached.current) { base = cached; break; }
      paired ||= !!at.alternate;
      if (at.tag === 3) {
        const root = at.stateNode, current = root?.current;
        if (!current || (current !== at && current !== at.alternate)) return null;
        base = { root, current, node: current, view: view(current, null) };
        remember(at, base);
        break;
      }
      path.push(at); at = at.return;
    }
    // Older unpaired owner facades have no root bookkeeping. A double-buffered
    // or actual React tree must prove its committed root, including on unmount.
    if (!base) return !paired && !at && path.every(node => typeof node.tag !== 'number') ? fiber : null;
    let budget = 4096;
    for (let index = path.length - 1; index >= 0; index--) {
      const wanted = path[index];
      let selected = null;
      // Walk only this parent's child list, never an arbitrary subtree or cache.
      // Return links can still name the previous parent after a React bailout.
      for (let child = base.node.child; child; child = child.sibling) {
        if (--budget < 0) return null;
        if (child !== wanted && child !== wanted.alternate) continue;
        if (selected) return null;
        selected = child;
      }
      if (!selected || base.root.current !== base.current) return null;
      base = { root: base.root, current: base.current, node: selected, view: view(selected, base.view) };
      remember(wanted, base);
    }
    return base.view;
  }

  /** The DOM's original Fiber pointer may be the previous render. Read the
   * root-selected child path, preserving current ancestors of shared children. */
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return committedPath(node[key]);
    }
    return null;
  }

  /**
   * The props of the node that renders exactly this row's group of messages.
   *
   * Two shapes are reachable by climbing from a row, and only one of them may be used.
   * The near one — observed live at depth 30 — carries `messages`, where `messages[0]` is
   * this row's own request and everything after it is other rows' business. The far one,
   * around depth 43, carries `allMessages`/`turn` for the *whole* turn; reading a row's
   * identity out of that means picking one of a turn's many requests by position, which is
   * how a row ends up labelled with a neighbour's tool. So the turn-level node is not a
   * fallback, it is a stop: reaching it means this row's group was not found, and a row
   * with no group keeps the label ChatGPT gave it.
   */
