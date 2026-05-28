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

function buildSnapshotMaps(snapshot) {
  const byBackendId = new Map();
  for (const doc of snapshot.documents) {
    const ids = doc.nodes?.backendNodeId ?? [];
    for (let i = 0; i < ids.length; i++) byBackendId.set(ids[i], { doc, nodeIdx: i });
    const layoutMap = new Map();
    const layoutNodeIndex = doc.layout?.nodeIndex ?? [];
    for (let j = 0; j < layoutNodeIndex.length; j++) layoutMap.set(layoutNodeIndex[j], j);
    doc.__layoutMap = layoutMap;
  }
  const styleIndexMap = Object.fromEntries(STYLE_PROPS.map((p, i) => [p, i]));
  return { byBackendId, styleIndexMap, strings: snapshot.strings };
}

function getBounds(backendNodeId, maps) {
  const hit = maps.byBackendId.get(backendNodeId);
  if (!hit) return null;
  const layoutIdx = hit.doc.__layoutMap.get(hit.nodeIdx);
  if (layoutIdx === undefined) return null;
  const b = hit.doc.layout?.bounds?.[layoutIdx];
  if (!b) return null;
  return { x: b[0], y: b[1], width: b[2], height: b[3] };
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
// CSS, transparent, pointer-events:none, or zero-area.
function isLeanVisible(bbox, style) {
  if (!bbox || bbox.width === 0 || bbox.height === 0) return false;
  if (!style) return true;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  if (style['pointer-events'] === 'none') return false;
  if (style.display === 'none') return false;
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
        if (!isLeanVisible(bbox, getComputedStyles(id, maps))) return [];
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
  return out;
}

// ─── Main extraction ──────────────────────────────────────────────────────────

async function performExtract(client, opts = {}) {
  const start = Date.now();
  const format = opts.format || (opts.tree ? 'tree' : opts.lean ? 'lean' : 'full');

  const { Accessibility, DOMSnapshot, Page } = client;
  await Accessibility.enable();

  const [axResult, snapshotResult, layoutMetrics] = await Promise.all([
    Accessibility.getFullAXTree(),
    DOMSnapshot.captureSnapshot({
      computedStyles: STYLE_PROPS,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    }),
    Page.getLayoutMetrics(),
  ]);

  const viewport = {
    width: layoutMetrics.cssLayoutViewport.clientWidth,
    height: layoutMetrics.cssLayoutViewport.clientHeight,
    scrollX: layoutMetrics.cssLayoutViewport.pageX,
    scrollY: layoutMetrics.cssLayoutViewport.pageY,
  };

  const maps = buildSnapshotMaps(snapshotResult);

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
    if (format === 'lean' && !isLeanVisible(bbox, style)) continue;

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
