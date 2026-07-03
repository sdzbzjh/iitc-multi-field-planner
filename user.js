// ==UserScript==
// @id             iitc-plugin-multi-field-planner
// @name           IITC Multi-Field Planner
// @category       Layer
// @version        0.1.0
// @description    Plan maximum-AP multi-fields and required keys from selected portals.
// @match          https://intel.ingress.com/*
// @match          https://*.ingress.com/intel*
// @grant          none
// ==/UserScript==

(function () {
'use strict';

// src/planner/geometry.js
function normalizePortal(portal) {
  return {
    id: String(portal.id ?? portal.guid),
    name: String(portal.name ?? portal.title ?? portal.id ?? portal.guid),
    lat: Number(portal.lat),
    lng: Number(portal.lng)
  };
}

function comparePortals(a, b) {
  return a.id.localeCompare(b.id) || a.lat - b.lat || a.lng - b.lng;
}

function orientation(a, b, c) {
  const value = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  if (Math.abs(value) < 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function onSegment(a, b, c) {
  return Math.min(a.lat, c.lat) - 1e-9 <= b.lat
    && b.lat <= Math.max(a.lat, c.lat) + 1e-9
    && Math.min(a.lng, c.lng) - 1e-9 <= b.lng
    && b.lng <= Math.max(a.lng, c.lng) + 1e-9
    && orientation(a, b, c) === 0;
}

function segmentsIntersect(a, b, c, d, { allowSharedEndpoint = true } = {}) {
  const shared = [a.id, b.id].some((id) => id !== undefined && (id === c.id || id === d.id));
  if (shared && allowSharedEndpoint) {
    return false;
  }

  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  return (o1 === 0 && onSegment(a, c, b))
    || (o2 === 0 && onSegment(a, d, b))
    || (o3 === 0 && onSegment(c, a, d))
    || (o4 === 0 && onSegment(c, b, d));
}

function convexHull(portals) {
  const points = [...portals].sort((a, b) => a.lng - b.lng || a.lat - b.lat || a.id.localeCompare(b.id));
  if (points.length <= 1) {
    return points;
  }

  const lower = [];
  for (const point of points) {
    while (lower.length >= 2 && orientation(lower[lower.length - 2], lower[lower.length - 1], point) !== -1) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (const point of [...points].reverse()) {
    while (upper.length >= 2 && orientation(upper[upper.length - 2], upper[upper.length - 1], point) !== -1) {
      upper.pop();
    }
    upper.push(point);
  }

  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pointInTriangle(point, a, b, c) {
  const o1 = orientation(point, a, b);
  const o2 = orientation(point, b, c);
  const o3 = orientation(point, c, a);
  const hasPositive = o1 > 0 || o2 > 0 || o3 > 0;
  const hasNegative = o1 < 0 || o2 < 0 || o3 < 0;
  return !(hasPositive && hasNegative);
}

function triangleArea(a, b, c) {
  return Math.abs((a.lng * (b.lat - c.lat) + b.lng * (c.lat - a.lat) + c.lng * (a.lat - b.lat)) / 2);
}


// src/planner/graph.js

function makeLink(from, to, order = 0) {
  return {
    id: `${from.id}->${to.id}`,
    from: from.id,
    to: to.id,
    fromPortal: from,
    toPortal: to,
    order
  };
}

function buildCandidateLinks(portals) {
  const sorted = [...portals].sort(comparePortals);
  const links = [];
  for (const from of sorted) {
    for (const to of sorted) {
      if (from.id !== to.id) {
        links.push(makeLink(from, to));
      }
    }
  }
  return links;
}

function linksCross(left, right) {
  return segmentsIntersect(left.fromPortal, left.toPortal, right.fromPortal, right.toPortal);
}

function validateNonCrossingLinks(links) {
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      if (linksCross(links[i], links[j])) {
        return false;
      }
    }
  }
  return true;
}

function orderLinks(links) {
  return links.map((link, index) => ({ ...link, order: index + 1 }));
}


// src/planner/keySummary.js
function summarizeRequiredKeys(portals, orderedLinks) {
  const byPortal = new Map(portals.map((portal) => [
    portal.id,
    {
      portalId: portal.id,
      name: portal.name,
      required: 0
    }
  ]));

  for (const link of orderedLinks) {
    const row = byPortal.get(link.to);
    if (row) {
      row.required += 1;
    }
  }

  return [...byPortal.values()]
    .filter((row) => row.required > 0)
    .sort((a, b) => b.required - a.required || a.name.localeCompare(b.name) || a.portalId.localeCompare(b.portalId));
}


// src/planner/scoring.js
const AP_PER_LINK = 313;
const AP_PER_FIELD = 1250;

function scorePlan(plan) {
  const linkCount = plan.linkCount ?? plan.orderedLinks.length;
  const fieldCount = plan.fieldCount ?? 0;
  const ap = linkCount * AP_PER_LINK + fieldCount * AP_PER_FIELD;
  return {
    ap,
    fieldCount,
    linkCount,
    explanation: `${fieldCount} fields, ${linkCount} links, ${ap} AP`
  };
}

function comparePlans(a, b) {
  const scoreA = a.score ?? scorePlan(a);
  const scoreB = b.score ?? scorePlan(b);
  return scoreB.ap - scoreA.ap
    || scoreB.fieldCount - scoreA.fieldCount
    || scoreB.linkCount - scoreA.linkCount
    || stablePlanSignature(a).localeCompare(stablePlanSignature(b));
}

function stablePlanSignature(plan) {
  return plan.orderedLinks.map((link) => `${link.from}->${link.to}`).join('|');
}


// src/planner/planner.js

function planMultiField(input) {
  const portals = [...new Map((input?.portals ?? [])
    .map(normalizePortal)
    .filter((portal) => portal.id && Number.isFinite(portal.lat) && Number.isFinite(portal.lng))
    .map((portal) => [portal.id, portal])).values()]
    .sort(comparePortals);

  if (portals.length < 3) {
    return emptyResult(portals, 'Select at least 3 portals.');
  }

  const hull = convexHull(portals);
  if (hull.length < 3) {
    return emptyResult(portals, 'Selected portals must not be collinear.');
  }

  const anchors = chooseBestAnchorTriangle(hull);
  const inner = portals
    .filter((portal) => !anchors.some((anchor) => anchor.id === portal.id))
    .filter((portal) => pointInTriangle(portal, anchors[0], anchors[1], anchors[2]))
    .sort((a, b) => triangleArea(anchors[0], anchors[1], a) - triangleArea(anchors[0], anchors[1], b) || comparePortals(a, b));

  const unordered = [
    makeLink(anchors[0], anchors[1]),
    makeLink(anchors[1], anchors[2]),
    makeLink(anchors[2], anchors[0])
  ];

  for (const portal of inner) {
    unordered.push(makeLink(anchors[0], portal));
  }

  const orderedLinks = orderLinks(unordered);
  if (!validateNonCrossingLinks(orderedLinks)) {
    return emptyResult(portals, 'Could not produce a non-crossing plan for this portal set.');
  }

  const fieldCount = Math.max(1, 1 + inner.length);
  const plan = {
    status: 'ok',
    portals,
    anchors,
    orderedLinks,
    fieldCount,
    linkCount: orderedLinks.length
  };
  const score = scorePlan(plan);
  const requiredKeys = summarizeRequiredKeys(portals, orderedLinks);

  return {
    ...plan,
    score,
    requiredKeys
  };
}

function chooseBestAnchorTriangle(hull) {
  let best = [hull[0], hull[1], hull[2]];
  let bestArea = -Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    for (let j = i + 1; j < hull.length; j += 1) {
      for (let k = j + 1; k < hull.length; k += 1) {
        const candidate = [hull[i], hull[j], hull[k]];
        const area = triangleArea(...candidate);
        const signature = candidate.map((portal) => portal.id).join('|');
        const bestSignature = best.map((portal) => portal.id).join('|');
        if (area > bestArea || (area === bestArea && signature < bestSignature)) {
          best = candidate;
          bestArea = area;
        }
      }
    }
  }
  return best;
}

function emptyResult(portals, reason) {
  return {
    status: 'empty',
    reason,
    portals,
    anchors: [],
    orderedLinks: [],
    fieldCount: 0,
    linkCount: 0,
    score: scorePlan({ orderedLinks: [], fieldCount: 0 }),
    requiredKeys: []
  };
}


// src/iitc/portalSelection.js

function createSelectionStore() {
  const selected = new Map();

  return {
    add(portal) {
      const normalized = normalizePortal(portal);
      if (!normalized.id || !Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lng)) {
        throw new Error('Portal must include id, lat, and lng.');
      }
      selected.set(normalized.id, normalized);
      return normalized;
    },
    remove(id) {
      selected.delete(String(id));
    },
    clear() {
      selected.clear();
    },
    list() {
      return [...selected.values()];
    },
    has(id) {
      return selected.has(String(id));
    }
  };
}

function portalFromIitc(guid, data = {}) {
  const latLng = data.latLng ?? data._latlng ?? {};
  const options = data.options?.data ?? data.options ?? data;
  return normalizePortal({
    id: guid,
    name: options.title ?? options.name ?? guid,
    lat: latLng.lat ?? options.lat,
    lng: latLng.lng ?? options.lng
  });
}


// src/ui/overlay.js
function createOverlayController(L, map) {
  const layerGroup = L?.layerGroup ? L.layerGroup() : createMemoryLayerGroup();
  if (map && layerGroup.addTo) {
    layerGroup.addTo(map);
  }

  return {
    clear() {
      layerGroup.clearLayers();
    },
    render(result) {
      layerGroup.clearLayers();
      if (!result || result.status !== 'ok') {
        return;
      }
      for (const link of result.orderedLinks) {
        const line = createLine(L, link);
        layerGroup.addLayer(line);
      }
    },
    layerGroup
  };
}

function createLine(L, link) {
  const positions = [
    [link.fromPortal.lat, link.fromPortal.lng],
    [link.toPortal.lat, link.toPortal.lng]
  ];
  if (!L?.polyline) {
    return { positions, link };
  }
  const line = L.polyline(positions, {
    color: '#ffce3a',
    weight: 3,
    opacity: 0.85
  });
  if (line.bindTooltip) {
    line.bindTooltip(String(link.order), {
      permanent: true,
      direction: 'center',
      className: 'iitc-mfp-link-label'
    });
  }
  return line;
}

function createMemoryLayerGroup() {
  const layers = [];
  return {
    layers,
    addTo() {
      return this;
    },
    addLayer(layer) {
      layers.push(layer);
    },
    clearLayers() {
      layers.length = 0;
    }
  };
}


// src/ui/panel.js
function createPanel({ documentRef = globalThis.document, onCalculate, onRemove, onClear } = {}) {
  const root = documentRef.createElement('section');
  root.className = 'iitc-mfp-panel';
  root.innerHTML = `
    <header class="iitc-mfp-header">
      <h2>Multi-field Planner</h2>
      <button type="button" data-action="clear" title="Clear selected portals">Clear</button>
    </header>
    <p class="iitc-mfp-warning">Clean-field plan: check blockers before linking.</p>
    <div class="iitc-mfp-portals" data-role="portal-list"></div>
    <button type="button" data-action="calculate">Calculate max AP</button>
    <div class="iitc-mfp-status" data-role="status"></div>
    <ol class="iitc-mfp-actions" data-role="action-list"></ol>
    <div class="iitc-mfp-keys" data-role="key-summary"></div>
  `;

  root.querySelector('[data-action="calculate"]').addEventListener('click', () => onCalculate?.());
  root.querySelector('[data-action="clear"]').addEventListener('click', () => onClear?.());
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-id]');
    if (button) {
      onRemove?.(button.getAttribute('data-remove-id'));
    }
  });

  return {
    root,
    renderSelection(portals) {
      const list = root.querySelector('[data-role="portal-list"]');
      if (portals.length === 0) {
        list.innerHTML = '<p class="iitc-mfp-empty">Select portals from the map.</p>';
        return;
      }
      list.innerHTML = portals.map((portal) => `
        <div class="iitc-mfp-portal">
          <span>${escapeHtml(portal.name)}</span>
          <button type="button" data-remove-id="${escapeHtml(portal.id)}" title="Remove portal">Remove</button>
        </div>
      `).join('');
    },
    setLoading() {
      setStatus(root, 'Calculating maximum-AP plan...');
      clearResult(root);
    },
    renderResult(result) {
      clearResult(root);
      if (!result || result.status !== 'ok') {
        setStatus(root, result?.reason ?? 'No usable plan for this selection.');
        return;
      }
      setStatus(root, result.score.explanation);
      root.querySelector('[data-role="action-list"]').innerHTML = result.orderedLinks.map((link) => `
        <li>${link.order}. ${escapeHtml(link.fromPortal.name)} -> ${escapeHtml(link.toPortal.name)}</li>
      `).join('');
      root.querySelector('[data-role="key-summary"]').innerHTML = `
        <h3>Required keys</h3>
        <ul>
          ${result.requiredKeys.map((row) => `<li>${escapeHtml(row.name)}: ${row.required}</li>`).join('')}
        </ul>
      `;
    },
    clearResult() {
      clearResult(root);
      setStatus(root, '');
    }
  };
}

function setStatus(root, text) {
  root.querySelector('[data-role="status"]').textContent = text;
}

function clearResult(root) {
  root.querySelector('[data-role="action-list"]').innerHTML = '';
  root.querySelector('[data-role="key-summary"]').innerHTML = '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}


// src/iitc/plugin.js

function createPlannerPlugin(windowRef = globalThis.window) {
  if (!windowRef?.document) {
    return null;
  }

  const plugin = windowRef.plugin?.multiFieldPlanner ?? {};
  const store = createSelectionStore();
  let panel;
  let overlay;

  plugin.setup = function setup() {
    overlay = createOverlayController(windowRef.L, windowRef.map);
    panel = createPanel({
      documentRef: windowRef.document,
      onCalculate: calculate,
      onRemove: (id) => {
        store.remove(id);
        renderSelection();
        clearOutput();
      },
      onClear: () => {
        store.clear();
        renderSelection();
        clearOutput();
      }
    });

    mountPanel(windowRef, panel.root);
    renderSelection();
  };

  plugin.addPortal = function addPortal(portal) {
    store.add(portal);
    renderSelection();
    clearOutput();
  };

  plugin.addIitcPortal = function addIitcPortal(guid, data) {
    plugin.addPortal(portalFromIitc(guid, data));
  };

  plugin.getSelection = function getSelection() {
    return store.list();
  };

  windowRef.plugin = windowRef.plugin || {};
  windowRef.plugin.multiFieldPlanner = plugin;

  if (windowRef.iitcLoaded && typeof plugin.setup === 'function') {
    plugin.setup();
  } else {
    windowRef.bootPlugins = windowRef.bootPlugins || [];
    windowRef.bootPlugins.push(plugin.setup);
  }

  function calculate() {
    panel.setLoading();
    overlay.clear();
    const result = planMultiField({ portals: store.list() });
    panel.renderResult(result);
    overlay.render(result);
  }

  function renderSelection() {
    panel?.renderSelection(store.list());
  }

  function clearOutput() {
    panel?.clearResult();
    overlay?.clear();
  }

  return plugin;
}

function mountPanel(windowRef, root) {
  const toolbox = windowRef.document.querySelector('#toolbox') ?? windowRef.document.body;
  toolbox.append(root);
}


if (typeof window !== 'undefined') {
  const style = window.document && window.document.createElement('style');
  if (style && !window.document.getElementById('iitc-mfp-styles')) {
    style.id = 'iitc-mfp-styles';
    style.textContent = ".iitc-mfp-panel {\n  display: grid;\n  gap: 8px;\n  max-width: 360px;\n  padding: 10px;\n  color: #f3f5f7;\n  background: #20252b;\n  border: 1px solid #4b5663;\n  font: 13px/1.4 system-ui, sans-serif;\n}\n\n.iitc-mfp-header,\n.iitc-mfp-portal {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.iitc-mfp-header h2,\n.iitc-mfp-keys h3 {\n  margin: 0;\n  font-size: 14px;\n}\n\n.iitc-mfp-warning {\n  margin: 0;\n  color: #ffd166;\n}\n\n.iitc-mfp-actions,\n.iitc-mfp-keys ul {\n  margin: 0;\n  padding-left: 20px;\n}\n\n.iitc-mfp-empty,\n.iitc-mfp-status {\n  margin: 0;\n  color: #b6c2cf;\n}\n\n.iitc-mfp-link-label {\n  color: #111;\n  background: #ffce3a;\n  border: 1px solid #111;\n  border-radius: 8px;\n}\n";
    window.document.head.append(style);
  }
  window.iitcMultiFieldPlanner = {
    planMultiField,
    createPlannerPlugin
  };
  createPlannerPlugin(window);
}
})();
