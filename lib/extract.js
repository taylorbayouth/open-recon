'use strict';

// Lowercase ARIA roles. CDP emits 'StaticText' etc. in CamelCase for
// Chrome-internal roles; ARIA roles are all lowercase.
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox',
  'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'searchbox', 'slider', 'spinbutton', 'switch',
  'treeitem', 'option', 'columnheader', 'rowheader',
]);

// Roles that signal "no semantics" — a focusable element with one of these
// is a custom widget (e.g. <div tabindex="0">). Landmark/region roles are
// intentionally excluded: they're page containers, not click targets.
const NON_SEMANTIC_ROLES = new Set(['generic', 'none', 'presentation', '', undefined, null]);

// 'StaticText' is Chrome-internal (CamelCase); the rest are ARIA lowercase.
// InlineTextBox / LineBreak are sub-runs of StaticText and are omitted.
const TEXT_ROLES = new Set([
  'heading', 'paragraph', 'StaticText', 'label', 'caption',
  'listitem', 'term', 'definition', 'blockquote', 'code',
]);

// Roles preserved as structural parents in tree mode. Everything else is
// pass-through: the node is skipped but its descendants bubble up.
const CONTAINER_ROLES = new Set([
  'RootWebArea',
  'main', 'navigation', 'banner', 'complementary', 'contentinfo',
  'region', 'search', 'form',
  'article', 'section', 'list', 'listitem', 'group', 'figure',
  'dialog', 'alertdialog', 'tabpanel', 'tablist', 'menu', 'menubar',
  'radiogroup', 'listbox', 'tree', 'treegrid', 'grid', 'table',
  'row', 'rowgroup', 'sectionheader', 'sectionfooter', 'status',
]);

const STYLE_PROPS = [
  'cursor', 'display', 'visibility', 'opacity', 'pointer-events',
  'position', 'z-index', 'background-color', 'color',
  'font-size', 'font-weight', 'border-radius', 'overflow',
];

// ─── Pure helpers ────────────────────────────────────────────────────────────

function flattenProperties(properties) {
  const result = {};
  if (!properties) return result;
  for (const prop of properties) result[prop.name] = prop.value?.value ?? null;
  return result;
}

// Build the cross-reference tables we use to resolve AX nodes → layout data.
//
// DOMSnapshot returns parallel arrays inside each document, optimized for wire
// size, not for lookup. To find the bbox for an AX node we need three hops:
//
//     backendNodeId ─(byBackendId)→ (doc, nodeIdx)
//                       (nodeIdx) ─(doc.__layoutMap)→ layoutIdx
//                              (layoutIdx) → doc.layout.bounds[layoutIdx]
//
// We precompute both indexes once per snapshot. Stashing `__layoutMap` on the
// document object is a deliberate (cheap) mutation — these objects are local
// to this call and discarded immediately after.
function buildSnapshotMaps(snapshot) {
  const byBackendId = new Map();
  for (const doc of snapshot.documents) {
    const ids = doc.nodes?.backendNodeId ?? [];
    for (let i = 0; i < ids.length; i++) byBackendId.set(ids[i], { doc, nodeIdx: i });
    // Not every node has a layout entry (display:none, detached, etc.). The
    // layoutMap lets getBounds() bail out cleanly with `undefined` instead of
    // scanning the layout arrays linearly.
    const layoutMap = new Map();
    const layoutNodeIndex = doc.layout?.nodeIndex ?? [];
    for (let j = 0; j < layoutNodeIndex.length; j++) layoutMap.set(layoutNodeIndex[j], j);
    doc.__layoutMap = layoutMap;
  }
  // styleIndexMap: STYLE_PROPS[i] → i. Snapshot styles are returned as parallel
  // arrays in the same order we requested them, so this is a simple zip.
  const styleIndexMap = Object.fromEntries(STYLE_PROPS.map((p, i) => [p, i]));
  return { byBackendId, styleIndexMap, strings: snapshot.strings };
}

// DOMSnapshot.captureSnapshot reports layout bounds in DEVICE pixels, but the
// rest of the pipeline (viewport, executor, pageToScreen) works in CSS pixels.
// On a Retina / scaled display (devicePixelRatio > 1) the raw bounds are thus
// dpr× too large and offset dpr× from the origin — boxes inflate and drift
// down-right proportional to position. Divide by the snapshot scale to bring
// bounds back into CSS-pixel space. `maps.scale` defaults to 1 (no-op) on
// ordinary 1:1 displays. See performExtract for how scale is derived.
function getBounds(backendNodeId, maps) {
  const hit = maps.byBackendId.get(backendNodeId);
  if (!hit) return null;
  const layoutIdx = hit.doc.__layoutMap.get(hit.nodeIdx);
  if (layoutIdx === undefined) return null;
  const b = hit.doc.layout?.bounds?.[layoutIdx];
  if (!b) return null;
  const s = maps.scale || 1;
  return { x: b[0] / s, y: b[1] / s, width: b[2] / s, height: b[3] / s };
}

function getComputedStyles(backendNodeId, maps) {
  const hit = maps.byBackendId.get(backendNodeId);
  if (!hit) return null;
  const layoutIdx = hit.doc.__layoutMap.get(hit.nodeIdx);
  if (layoutIdx === undefined) return null;
  const styleValues = hit.doc.layout?.styles?.[layoutIdx];
  if (!styleValues) return null;
  const result = {};
  for (const prop of STYLE_PROPS) {
    const stringIdx = styleValues[maps.styleIndexMap[prop]];
    result[prop] = stringIdx >= 0 ? maps.strings[stringIdx] : null;
  }
  return result;
}

function isInViewport(bbox, vp) {
  if (!bbox) return false;
  const x = bbox.x - vp.scrollX;
  const y = bbox.y - vp.scrollY;
  return x + bbox.width > 0 && x < vp.width && y + bbox.height > 0 && y < vp.height;
}

// Discard elements that have a bbox but aren't actually reachable: hidden via
// CSS, pointer-events:none, or zero-area.
//
// `opacity:0` is the subtle one. It usually means "invisible" — but it's also
// how sites build a transparent-but-functional input: the real <input> is
// rendered at opacity:0 with its visible styling drawn by a sibling element
// (LinkedIn's search box does exactly this). Such an input is focusable and
// pointer-reachable, so we keep opacity:0 elements that are `focusable`; only
// non-interactive transparent nodes are dropped. (pointer-events:none below
// still removes anything genuinely unclickable, transparent or not.)
function isLeanVisible(bbox, style, focusable = false) {
  if (!bbox || bbox.width === 0 || bbox.height === 0) return false;
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style['pointer-events'] === 'none') return false;
  if (style.opacity === '0' && !focusable) return false;
  return true;
}

function bboxArr(b) {
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
}

// ─── Tree mode builders ───────────────────────────────────────────────────────

function buildTreeInteractive(node, props, bbox, inViewport, ref) {
  const out = { ref, role: node.role?.value };
  const name = node.name?.value;
  if (name) out.name = name;
  out.bbox = bboxArr(bbox);
  if (inViewport) out.inViewport = true;
  const value = node.value?.value;
  if (value != null && value !== '') out.value = value;
  if (props.url) out.url = props.url;
  if (props.checked != null) out.checked = props.checked;
  if (props.selected != null) out.selected = props.selected;
  if (props.expanded != null) out.expanded = props.expanded;
  if (props.disabled === true) out.disabled = true;
  if (props.focused === true) out.focused = true;
  return out;
}

function buildTreeText(node, props, bbox, inViewport, ref) {
  const out = { ref, role: node.role?.value, name: node.name.value };
  if (bbox) out.bbox = bboxArr(bbox);
  if (inViewport) out.inViewport = true;
  if (typeof props.level === 'number') out.level = props.level;
  return out;
}

function buildTree(axResult, maps, viewport, opts) {
  const byId = new Map();
  for (const n of axResult.nodes) byId.set(n.nodeId, n);
  const counts = { interactive: 0, text: 0 };
  const lookup = {};

  const interactiveRoles = opts.interactiveRoles
    ? new Set(opts.interactiveRoles)
    : INTERACTIVE_ROLES;
  const containerRoles = opts.containerRoles
    ? new Set(opts.containerRoles)
    : CONTAINER_ROLES;

  function collect(nodeId) {
    const node = byId.get(nodeId);
    if (!node) return [];

    const role = node.role?.value;
    const props = flattenProperties(node.properties);
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const inViewport = isInViewport(bbox, viewport);

    if (!node.ignored) {
      const hasRole = interactiveRoles.has(role);
      const isCustomWidget = props.focusable === true && NON_SEMANTIC_ROLES.has(role);

      if (hasRole || isCustomWidget) {
        if (!isLeanVisible(bbox, getComputedStyles(id, maps), props.focusable === true)) return [];
        if (opts.inViewportOnly && !inViewport) return [];
        counts.interactive++;
        const ref = `@e${counts.interactive}`;
        lookup[ref] = id;
        return [buildTreeInteractive(node, props, bbox, inViewport, ref)];
      }

      if (TEXT_ROLES.has(role) && node.name?.value?.trim()) {
        if (!bbox || bbox.width === 0 || bbox.height === 0) return [];
        if (opts.inViewportOnly && !inViewport) return [];
        counts.text++;
        const ref = `@t${counts.text}`;
        lookup[ref] = id;
        return [buildTreeText(node, props, bbox, inViewport, ref)];
      }
    }

    const children = (node.childIds || []).flatMap(collect);

    if (!node.ignored && containerRoles.has(role)) {
      if (children.length === 0) return [];
      if (children.length === 1 && !node.name?.value) return children;
      const out = { role };
      if (node.name?.value) out.name = node.name.value;
      out.children = children;
      return [out];
    }

    return children;
  }

  const roots = axResult.nodes.filter(n => !n.parentId);
  if (!roots.length) return { tree: null, counts, lookup };
  const root = roots.reduce((a, b) =>
    (b.childIds?.length || 0) > (a.childIds?.length || 0) ? b : a
  );
  const result = collect(root.nodeId);
  return { tree: result[0] || null, counts, lookup };
}

// ─── Flat mode builders ───────────────────────────────────────────────────────

function buildLeanElement(node, props, ref, bbox, inViewport) {
  const out = { ref, role: node.role?.value ?? null, name: node.name?.value ?? null, bbox, inViewport };
  const value = node.value?.value;
  if (value != null && value !== '') out.value = value;
  if (props.url) out.url = props.url;
  if (props.checked != null) out.checked = props.checked;
  if (props.selected != null) out.selected = props.selected;
  if (props.expanded != null) out.expanded = props.expanded;
  if (props.disabled === true) out.disabled = true;
  if (props.focused === true) out.focused = true;
  return out;
}

// ─── Main extraction ──────────────────────────────────────────────────────────

async function performExtract(client, opts = {}) {
  const start = Date.now();
  const format = opts.format || (opts.tree ? 'tree' : opts.lean ? 'lean' : 'full');
  if (!['tree', 'lean', 'full'].includes(format)) {
    throw new Error(`unknown extract format "${format}" (expected: tree, lean, full)`);
  }

  const { Accessibility, DOMSnapshot, Page, Runtime } = client;
  await Accessibility.enable();

  const [axResult, snapshotResult, layoutMetrics, dprEval] = await Promise.all([
    Accessibility.getFullAXTree(),
    DOMSnapshot.captureSnapshot({
      computedStyles: STYLE_PROPS,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    }),
    Page.getLayoutMetrics(),
    Runtime.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true }).catch(() => null),
  ]);

  const viewport = {
    width: layoutMetrics.cssLayoutViewport.clientWidth,
    height: layoutMetrics.cssLayoutViewport.clientHeight,
    scrollX: layoutMetrics.cssLayoutViewport.pageX,
    scrollY: layoutMetrics.cssLayoutViewport.pageY,
    // Full scrollable document size — lets the consumer report scroll position
    // and whether more content lies above/below the current view.
    contentWidth: layoutMetrics.cssContentSize?.width ?? null,
    contentHeight: layoutMetrics.cssContentSize?.height ?? null,
  };

  const maps = buildSnapshotMaps(snapshotResult);

  // Snapshot bounds are in device pixels; normalise to CSS pixels by dividing
  // by the device pixel ratio. window.devicePixelRatio is the authoritative
  // source — it's the same value the browser uses internally. Falls back to 1
  // (no-op) if the evaluate call failed (e.g. page context unavailable).
  const dpr = dprEval?.result?.type === 'number' && dprEval.result.value > 0
    ? dprEval.result.value
    : 1;
  maps.scale = dpr;
  if (process.env.RECON_DEBUG_COORDS) console.error(`[extract] bounds scale = ${maps.scale}`);

  const base = {
    schemaVersion: '2.0',
    url: null,    // populated by Session from target info
    title: null,
    timestamp: new Date().toISOString(),
    viewport,
  };

  if (format === 'tree') {
    const { tree, counts, lookup } = buildTree(axResult, maps, viewport, opts);
    return {
      ...base,
      tree,
      lookup,
      stats: {
        totalAXNodes: axResult.nodes.length,
        interactiveReturned: counts.interactive,
        textReturned: counts.text,
        elapsedMs: Date.now() - start,
      },
    };
  }

  // full / lean flat mode
  const interactiveRoles = opts.interactiveRoles ? new Set(opts.interactiveRoles) : INTERACTIVE_ROLES;

  const interactiveNodes = [];
  const textNodes = [];
  for (const n of axResult.nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    const props = flattenProperties(n.properties);
    if (interactiveRoles.has(role) || (props.focusable === true && NON_SEMANTIC_ROLES.has(role))) {
      interactiveNodes.push({ node: n, props, source: interactiveRoles.has(role) ? 'role' : 'focusable' });
    }
    if (TEXT_ROLES.has(role) && n.name?.value?.trim()) {
      textNodes.push({ node: n, props });
    }
  }

  const stats = {
    totalAXNodes: axResult.nodes.length,
    interactiveFound: interactiveNodes.length,
    textFound: textNodes.length,
    withBounds: 0,
    inViewport: 0,
    returned: 0,
  };

  const lookup = {};
  const elements = [];
  for (const { node, props, source } of interactiveNodes) {
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const style = getComputedStyles(id, maps);
    const inViewport = isInViewport(bbox, viewport);
    if (bbox) stats.withBounds++;
    if (inViewport) stats.inViewport++;
    if (opts.inViewportOnly && !inViewport) continue;
    if (format === 'lean' && !isLeanVisible(bbox, style, props.focusable === true)) continue;

    const ref = `@e${elements.length + 1}`;
    lookup[ref] = id;

    if (format === 'lean') {
      elements.push(buildLeanElement(node, props, ref, bbox, inViewport));
    } else {
      elements.push({
        ref,
        role: node.role?.value ?? null,
        name: node.name?.value ?? null,
        source,
        focusable: props.focusable ?? null,
        focused: props.focused ?? null,
        expanded: props.expanded ?? null,
        checked: props.checked ?? null,
        selected: props.selected ?? null,
        disabled: props.disabled ?? null,
        url: props.url ?? null,
        bbox,
        inViewport,
        computedStyle: style,
      });
    }
  }
  stats.returned = elements.length;

  const text = [];
  for (const { node, props } of textNodes) {
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const inViewport = isInViewport(bbox, viewport);
    if (opts.inViewportOnly && !inViewport) continue;
    if (format === 'lean' && (!bbox || bbox.width === 0 || bbox.height === 0)) continue;

    const ref = `@t${text.length + 1}`;
    lookup[ref] = id;

    if (format === 'lean') {
      const t = { ref, role: node.role?.value ?? null, name: node.name.value, bbox, inViewport };
      if (typeof props.level === 'number') t.level = props.level;
      text.push(t);
    } else {
      text.push({
        ref,
        role: node.role?.value ?? null,
        name: node.name.value,
        level: typeof props.level === 'number' ? props.level : null,
        bbox,
        inViewport,
      });
    }
  }

  stats.elapsedMs = Date.now() - start;
  return { ...base, elements, text, lookup, stats };
}

module.exports = {
  performExtract,
  // exported for testing
  flattenProperties, isInViewport, isLeanVisible, bboxArr,
  INTERACTIVE_ROLES, TEXT_ROLES, CONTAINER_ROLES, NON_SEMANTIC_ROLES, STYLE_PROPS,
};
