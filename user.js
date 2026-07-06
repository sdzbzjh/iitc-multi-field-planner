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


// src/planner/upstreamPlanner.js

const INF = Number.POSITIVE_INFINITY;

class UpstreamPoint {
  constructor(portal) {
    this.portal = portal;
    this.id = portal.id;
    this.x = portal.lng;
    this.y = portal.lat;
  }
}

class Link {
  constructor(origin, target, options = {}) {
    this.origin = options.reverse ? target : origin;
    this.target = options.reverse ? origin : target;
    this.jetLink = Boolean(options.jetLink);
    this.triangle = options.triangle ?? null;
  }
}

class PointSet {
  constructor(points) {
    this.pointList = [...points];
    this.needUpdate = true;
    this.innerPoints = [];
  }

  get norm() {
    return this.pointList.length;
  }

  get convexHull() {
    if (!this.needUpdate) {
      return this._convexHull;
    }

    this.pointList.sort(comparePoints);
    const lowerHull = [];
    for (const point of this.pointList) {
      while (lowerHull.length >= 2 && crossProduct(lowerHull.at(-2), lowerHull.at(-1), point) <= 0) {
        lowerHull.pop();
      }
      lowerHull.push(point);
    }

    const upperHull = [];
    for (const point of this.pointList) {
      while (upperHull.length >= 2 && crossProduct(upperHull.at(-2), upperHull.at(-1), point) >= 0) {
        upperHull.pop();
      }
      upperHull.push(point);
    }
    upperHull.shift();
    upperHull.pop();
    upperHull.reverse();

    this._convexHull = new ConvexHull([...lowerHull, ...upperHull]);
    this.needUpdate = false;
    this.innerPoints = [...this.pointList];
    for (const point of this._convexHull.pointList) {
      removePoint(this.innerPoints, point);
    }
    return this._convexHull;
  }

  cover(point) {
    const hull = this.convexHull;
    for (let i = 1; i < hull.norm; i += 1) {
      if (crossProduct(point, hull.pointList[i - 1], hull.pointList[i]) <= 0) {
        return false;
      }
    }
    return crossProduct(point, hull.pointList.at(-1), hull.pointList[0]) > 0;
  }

  divide(partition) {
    const newPartition = [];
    for (const item of partition) {
      const triangle = item instanceof Triangle ? item : new Triangle(item.pointList);
      for (const point of this.innerPoints) {
        triangle.addInnerPoints(point);
      }
      newPartition.push(triangle);
    }
    return newPartition;
  }

  findBalanceKeySolution() {
    const partitions = this.convexHull.triangulation().map((partition) => this.divide(partition));
    let solution = null;

    for (const partition of partitions) {
      const triangleResultMap = new Map();
      for (const triangle of partition) {
        if (!getTriangleMap(triangleResultMap, triangle)) {
          let outerLinksSet = null;
          let initOut = new Map();
          let initIn = new Map();
          for (const [tri, result] of triangleResultMap.entries()) {
            if (tri.isNeighbour(triangle)) {
              const labels = new Map([[tri.A, 'A'], [tri.B, 'B'], [tri.C, 'C']]);
              const commonEdge = tri.commonEdge(triangle);
              const directedEdge = result.links.find((link) => sameUndirectedLink(link, commonEdge));
              if (directedEdge) {
                outerLinksSet = genOuterLinksSet(triangle.getOuterIndex(directedEdge), directedEdge, triangle);
                initOut = new Map([[directedEdge.origin, Math.max(0, result[`outDegree${labels.get(directedEdge.origin)}`] - 1)]]);
                initIn = new Map([[directedEdge.target, Math.max(0, result[`inDegree${labels.get(directedEdge.target)}`] - 1)]]);
              }
              break;
            }
          }
          triangleResultMap.set(triangle, triangle.findBalanceKeySolution({ outerLinksSet, initOut, initIn }));
        }
      }

      const triangleResults = [...triangleResultMap.values()];
      const innerMaxKey = Math.max(...triangleResults.map((value) => value.key));
      const outerMaxKey = new Map(this.convexHull.pointList.map((point) => [point, 0]));
      const outerOutDegree = new Map(this.convexHull.pointList.map((point) => [point, 0]));
      const tmpLinks = [];

      for (const [triangle, result] of triangleResultMap.entries()) {
        tmpLinks.push(...result.links);
        addMap(outerMaxKey, triangle.A, result.inDegreeA);
        addMap(outerMaxKey, triangle.B, result.inDegreeB);
        addMap(outerMaxKey, triangle.C, result.inDegreeC);
        addMap(outerOutDegree, triangle.A, result.outDegreeA);
        addMap(outerOutDegree, triangle.B, result.outDegreeB);
        addMap(outerOutDegree, triangle.C, result.outDegreeC);

        for (const link of result.links) {
          if ([triangle.A, triangle.B, triangle.C].includes(link.origin)
            && [triangle.A, triangle.B, triangle.C].includes(link.target)) {
            const i1 = this.convexHull.pointList.indexOf(link.origin);
            const i2 = this.convexHull.pointList.indexOf(link.target);
            const isBoundary = Math.abs(i1 - i2) === 1 || Math.abs(i1 - i2) === this.convexHull.norm - 1;
            if (!isBoundary) {
              addMap(outerMaxKey, link.target, -0.5);
              addMap(outerOutDegree, link.origin, -0.5);
            }
          }
        }
      }

      let maxKey = Math.max(innerMaxKey, ...outerMaxKey.values());
      const maxOutDegree = Math.max(...outerOutDegree.values());
      const links = uniqueLinks(tmpLinks);
      if (maxOutDegree > 8) {
        maxKey = INF;
      }
      if (!solution || maxKey <= solution.maxKey) {
        solution = { maxKey, maxOutDegree, links };
      }
    }

    return solution ?? { maxKey: INF, maxOutDegree: INF, links: [] };
  }
}

class ConvexHull extends PointSet {
  triangulation() {
    const partitions = [];
    const partition = [];
    if (this.norm >= 3) {
      for (let i = 1; i < this.norm - 1; i += 1) {
        const middlePart = new ConvexHull([this.pointList[0], this.pointList[i], this.pointList.at(-1)]);
        const rightPart = new ConvexHull(this.pointList.slice(0, i + 1));
        const leftPart = new ConvexHull(this.pointList.slice(i));
        if (rightPart.norm < 3) {
          if (leftPart.norm < 3) {
            partition.push(middlePart);
            partitions.push(partition);
          } else {
            for (const a of leftPart.triangulation()) {
              for (const b of middlePart.triangulation()) {
                partitions.push([...a, ...b, ...partition]);
              }
            }
          }
        } else if (leftPart.norm < 3) {
          for (const a of middlePart.triangulation()) {
            for (const b of rightPart.triangulation()) {
              partitions.push([...a, ...partition, ...b]);
            }
          }
        } else {
          for (const a of leftPart.triangulation()) {
            for (const b of middlePart.triangulation()) {
              for (const c of rightPart.triangulation()) {
                partitions.push([...a, ...b, ...partition, ...c]);
              }
            }
          }
        }
      }
    }
    return partitions;
  }
}

class Triangle extends PointSet {
  static resultMap = new Map();

  constructor(points, custom = false) {
    super(points);
    if (custom) {
      [this.A, this.B, this.C] = points;
      this.innerPoints = [];
    } else {
      this.A = this.convexHull.pointList[0];
      this.B = this.convexHull.pointList[1];
      this.C = this.convexHull.pointList[2];
    }
  }

  key() {
    return canonicalTriangleKey(this);
  }

  addInnerPoints(point) {
    if (this.cover(point) && !this.pointList.includes(point)) {
      this.pointList.push(point);
      this.innerPoints.push(point);
      this.needUpdate = true;
    }
  }

  nextVertex(vertex) {
    if (vertex === this.A) return this.B;
    if (vertex === this.B) return this.C;
    return this.A;
  }

  previousVertex(vertex) {
    if (vertex === this.A) return this.C;
    if (vertex === this.B) return this.A;
    return this.B;
  }

  isNeighbour(other) {
    return [this.A, this.B, this.C].filter((point) => [other.A, other.B, other.C].includes(point)).length === 2;
  }

  commonEdge(other) {
    const intersection = [this.A, this.B, this.C].filter((point) => [other.A, other.B, other.C].includes(point));
    return new Link(intersection[0], intersection[1]);
  }

  getOuterIndex(link) {
    if (sameUndirectedLink(link, new Link(this.A, this.B))) return 0;
    if (sameUndirectedLink(link, new Link(this.B, this.C))) return 1;
    if (sameUndirectedLink(link, new Link(this.C, this.A))) return 2;
    return null;
  }

  divideIntoThreeTriangle(divider) {
    const abd = new Triangle([this.A, this.B, divider], true);
    const bcd = new Triangle([this.B, this.C, divider], true);
    const dca = new Triangle([divider, this.C, this.A], true);
    return this.divide([abd, bcd, dca]);
  }

  findBalanceKeySolution({ outerLinksSet = null, depth = 0, initOut = new Map(), initIn = new Map() } = {}) {
    const normalizedOuterLinksSet = outerLinksSet ?? cartesianProduct([
      [new Link(this.A, this.B), new Link(this.A, this.B, { reverse: true })],
      [new Link(this.B, this.C), new Link(this.B, this.C, { reverse: true })],
      [new Link(this.C, this.A), new Link(this.C, this.A, { reverse: true })]
    ]);

    let result = null;
    if (this.norm === 3) {
      for (const outerLinks of normalizedOuterLinksSet) {
        const key = new Map([[this.A, 0], [this.B, 0], [this.C, 0]]);
        for (const link of outerLinks) {
          addMap(key, link.target, 1);
        }
        const tmpResult = baseResult();
        tmpResult.key = Math.max(...key.values());
        if (depth === 0) {
          tmpResult.links = [...outerLinks];
        }
        if (!result || tmpResult.key <= result.key) {
          result = tmpResult;
        }
      }
      return result;
    }

    for (const outerLinks of normalizedOuterLinksSet) {
      for (const divider of this.innerPoints) {
        for (const jetPoint of [this.A, this.B, this.C]) {
          for (const dBD of [0, 1]) {
            for (const dCD of [0, 1]) {
              const { AD, BD, CD } = this.buildDividerLinks(jetPoint, divider, dBD, dCD);
              const subTriangles = this.divideIntoThreeTriangle(divider);
              const subResults = [];

              for (let index = 0; index < subTriangles.length; index += 1) {
                const triangle = subTriangles[index];
                const cached = Triangle.resultMap.get(triangle.key());
                if (cached) {
                  subResults.push(cached);
                  continue;
                }

                let tmp;
                if (index === 0) {
                  tmp = triangle.findBalanceKeySolution({ outerLinksSet: [[outerLinks[0], BD, AD]], depth: depth + 1, initOut, initIn });
                } else if (index === 1) {
                  tmp = triangle.findBalanceKeySolution({ outerLinksSet: [[outerLinks[1], CD, BD]], depth: depth + 1, initOut, initIn });
                } else {
                  tmp = triangle.findBalanceKeySolution({ outerLinksSet: [[CD, outerLinks[2], AD]], depth: depth + 1, initOut, initIn });
                }
                Triangle.resultMap.set(triangle.key(), tmp);
                subResults.push(tmp);
              }

              const tmpResult = this.combineSubResults({ subResults, outerLinks, AD, BD, CD, jetPoint, dBD, dCD, divider, initOut, initIn, depth });
              const feasibility = testFeasibility([...tmpResult.links, ...outerLinks]);
              if (!feasibility.ok) {
                tmpResult.key = INF;
              } else if (depth === 0) {
                tmpResult.links = feasibility.links;
              }

              if (!result || tmpResult.key <= result.key) {
                result = tmpResult;
              }
            }
          }
        }
      }
    }
    return result ?? { ...baseResult(), key: INF };
  }

  buildDividerLinks(jetPoint, divider, dBD, dCD) {
    if (jetPoint === this.A) {
      return {
        AD: new Link(this.A, divider, { jetLink: true, triangle: this }),
        BD: new Link(this.B, divider, { reverse: 1 - dBD }),
        CD: new Link(this.C, divider, { reverse: 1 - dCD })
      };
    }
    if (jetPoint === this.B) {
      return {
        AD: new Link(this.A, divider, { reverse: 1 - dCD }),
        BD: new Link(this.B, divider, { jetLink: true, triangle: this }),
        CD: new Link(this.C, divider, { reverse: 1 - dBD })
      };
    }
    return {
      AD: new Link(this.A, divider, { reverse: 1 - dBD }),
      BD: new Link(this.B, divider, { reverse: 1 - dCD }),
      CD: new Link(this.C, divider, { jetLink: true, triangle: this })
    };
  }

  combineSubResults({ subResults, outerLinks, AD, BD, CD, jetPoint, dBD, dCD, divider, initOut, initIn, depth }) {
    const tmpResult = {
      links: [...subResults[0].links, ...subResults[1].links, ...subResults[2].links, AD, BD, CD],
      outDegreeA: subResults[0].outDegreeA + subResults[2].outDegreeC,
      outDegreeB: subResults[0].outDegreeB + subResults[1].outDegreeA,
      outDegreeC: subResults[1].outDegreeB + subResults[2].outDegreeB,
      inDegreeA: subResults[0].inDegreeA + subResults[2].inDegreeC,
      inDegreeB: subResults[0].inDegreeB + subResults[1].inDegreeA,
      inDegreeC: subResults[1].inDegreeB + subResults[2].inDegreeB,
      key: INF
    };

    if (jetPoint === this.A) {
      tmpResult.outDegreeA += 1;
      tmpResult.outDegreeB += dBD;
      tmpResult.outDegreeC += dCD;
      tmpResult.inDegreeB += 1 - dBD;
      tmpResult.inDegreeC += 1 - dCD;
    } else if (jetPoint === this.B) {
      tmpResult.outDegreeB += 1;
      tmpResult.outDegreeC += dBD;
      tmpResult.outDegreeA += dCD;
      tmpResult.inDegreeC += 1 - dBD;
      tmpResult.inDegreeA += 1 - dCD;
    } else {
      tmpResult.outDegreeC += 1;
      tmpResult.outDegreeA += dBD;
      tmpResult.outDegreeB += dCD;
      tmpResult.inDegreeA += 1 - dBD;
      tmpResult.inDegreeB += 1 - dCD;
    }

    const inDegreeD = 1 + dBD + dCD + subResults[0].inDegreeC + subResults[1].inDegreeC + subResults[2].inDegreeA;
    if (depth === 0) {
      tmpResult.inDegreeD = inDegreeD;
    }

    const labels = new Map([[this.A, 'A'], [this.B, 'B'], [this.C, 'C']]);
    const actualOut = { A: tmpResult.outDegreeA, B: tmpResult.outDegreeB, C: tmpResult.outDegreeC };
    const actualIn = { A: tmpResult.inDegreeA, B: tmpResult.inDegreeB, C: tmpResult.inDegreeC };

    for (const link of outerLinks) {
      actualOut[labels.get(link.origin)] += 1;
      actualIn[labels.get(link.target)] += 1;
    }
    for (const point of [this.A, this.B, this.C]) {
      const label = labels.get(point);
      if (initOut.has(point)) {
        actualOut[label] += initOut.get(point);
      }
      if (initIn.has(point)) {
        actualIn[label] += initIn.get(point);
      }
    }

    if (depth === 0) {
      tmpResult.outDegreeA = actualOut.A;
      tmpResult.outDegreeB = actualOut.B;
      tmpResult.outDegreeC = actualOut.C;
      tmpResult.inDegreeA = actualIn.A;
      tmpResult.inDegreeB = actualIn.B;
      tmpResult.inDegreeC = actualIn.C;
    }

    tmpResult.key = Math.max(...subResults.map((subResult) => subResult.key), ...Object.values(actualIn), inDegreeD);
    if (Math.max(...Object.values(actualOut)) > 8) {
      tmpResult.key = INF;
    }
    tmpResult.divider = divider;
    return tmpResult;
  }
}

function findUpstreamPlan(portalsInput) {
  const portals = [...new Map((portalsInput ?? []).map(normalizePortal).map((portal) => [portal.id, portal])).values()]
    .filter((portal) => portal.id && Number.isFinite(portal.lat) && Number.isFinite(portal.lng))
    .sort((a, b) => a.lng - b.lng || a.lat - b.lat || a.id.localeCompare(b.id));
  const points = portals.map((portal) => new UpstreamPoint(portal));

  if (points.length < 3) {
    return { status: 'empty', portals, reason: 'Select at least 3 portals.', links: [], maxKey: 0, maxOutDegree: 0 };
  }

  Triangle.resultMap = new Map();
  const solution = new PointSet(points).findBalanceKeySolution();
  if (!solution.links.length || !Number.isFinite(solution.maxKey)) {
    return { status: 'empty', portals, reason: 'Could not produce a feasible upstream multi-field plan.', links: [], maxKey: solution.maxKey, maxOutDegree: solution.maxOutDegree };
  }

  return {
    status: 'ok',
    portals,
    links: uniqueDirectedLinks(solution.links),
    maxKey: solution.maxKey,
    maxOutDegree: solution.maxOutDegree
  };
}

function testFeasibility(links) {
  const jetLinks = links.filter((link) => link.jetLink).sort(compareJetLinks);
  if (jetLinks.length === 0) {
    return { ok: true, links };
  }

  try {
    return { ok: true, links: drawOtherLinks(jetLinks[0], [...jetLinks], links) };
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: true, links };
    }
    return { ok: false, links: [] };
  }
}

function drawOtherLinks(jetLink, jetLinks, links, edges = []) {
  const A = jetLink.origin;
  const D = jetLink.target;
  const B = jetLink.triangle.nextVertex(A);
  const C = jetLink.triangle.previousVertex(A);
  const BD = new Link(B, D);
  const CD = new Link(C, D);
  const BC = new Link(B, C);
  const AB = new Link(A, B);
  const AC = new Link(A, C);
  const seq = [BD, CD, BC, AB, AC].filter((edge) => !containsUndirected(edges, edge));
  const canLink = [];

  for (let edge of seq) {
    const existing = links.find((link) => sameUndirectedLink(edge, link));
    if (existing) {
      edge = existing;
    }

    const vertices = uniquePoints(edges.concat(canLink).flatMap((ele) => [ele.origin, ele.target]));
    for (const ele of edges.concat(canLink)) {
      for (const vertex of vertices) {
        if (containsUndirected(edges.concat(canLink), new Link(ele.origin, vertex))
          && containsUndirected(edges.concat(canLink), new Link(ele.target, vertex))) {
          if (new Triangle([ele.origin, ele.target, vertex]).cover(edge.origin)) {
            throw new Error('Inside an existing field.');
          }
        }
      }
    }

    const jetIndex = jetLinks.findIndex((link) => sameUndirectedLink(edge, link));
    if (jetIndex >= 0) {
      return drawOtherLinks(jetLinks[jetIndex], jetLinks, links, edges.concat(canLink));
    }
    canLink.push(edge);
  }

  removeLink(jetLinks, jetLink);
  if (jetLinks.length > 0) {
    return drawOtherLinks(jetLinks[0], jetLinks, links, edges.concat(canLink, [jetLink]));
  }
  return edges.concat(canLink, [jetLink]);
}

function genOuterLinksSet(index, link, triangle) {
  const sets = [
    [new Link(triangle.A, triangle.B), new Link(triangle.A, triangle.B, { reverse: true })],
    [new Link(triangle.B, triangle.C), new Link(triangle.B, triangle.C, { reverse: true })],
    [new Link(triangle.C, triangle.A), new Link(triangle.C, triangle.A, { reverse: true })]
  ];
  sets[index] = [link];
  return cartesianProduct(sets);
}

function crossProduct(p0, p1, p2) {
  return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
}

function comparePoints(a, b) {
  return a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
}

function sameUndirectedLink(a, b) {
  return (a.origin === b.origin && a.target === b.target) || (a.origin === b.target && a.target === b.origin);
}

function sameDirectedLink(a, b) {
  return a.origin === b.origin && a.target === b.target;
}

function containsUndirected(links, target) {
  return links.some((link) => sameUndirectedLink(link, target));
}

function removeLink(links, target) {
  const index = links.findIndex((link) => sameUndirectedLink(link, target));
  if (index >= 0) {
    links.splice(index, 1);
  }
}

function removePoint(points, target) {
  const index = points.indexOf(target);
  if (index >= 0) {
    points.splice(index, 1);
  }
}

function uniquePoints(points) {
  return [...new Set(points)];
}

function uniqueLinks(links) {
  const result = [];
  for (const link of links) {
    if (!containsUndirected(result, link)) {
      result.push(link);
    }
  }
  return result;
}

function uniqueDirectedLinks(links) {
  const result = [];
  for (const link of links) {
    if (!result.some((existing) => sameDirectedLink(existing, link))) {
      result.push(link);
    }
  }
  return result;
}

function cartesianProduct(arrays) {
  return arrays.reduce((acc, values) => acc.flatMap((prefix) => values.map((value) => [...prefix, value])), [[]]);
}

function addMap(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function baseResult() {
  return {
    key: 0,
    links: [],
    outDegreeA: 0,
    outDegreeB: 0,
    outDegreeC: 0,
    inDegreeA: 0,
    inDegreeB: 0,
    inDegreeC: 0
  };
}

function canonicalTriangleKey(triangle) {
  return [triangle.A.id, triangle.B.id, triangle.C.id].sort().join('|');
}

function getTriangleMap(map, triangle) {
  return map.get(triangle);
}

function compareJetLinks(a, b) {
  if (a.triangle.cover(b.origin)) return 1;
  if (b.triangle.cover(a.origin)) return -1;
  return 0;
}


// src/planner/planner.js

function planMultiField(input) {
  const upstreamResult = findUpstreamPlan(input?.portals ?? []);
  const portals = upstreamResult.portals.map(normalizePortal);
  if (upstreamResult.status !== 'ok') {
    return emptyResult(portals, upstreamResult.reason);
  }

  const orderedLinks = orderLinks(upstreamResult.links.map((link) => ({
    id: `${link.origin.id}->${link.target.id}`,
    from: link.origin.id,
    to: link.target.id,
    fromPortal: link.origin.portal,
    toPortal: link.target.portal
  })));

  if (!validateNonCrossingLinks(orderedLinks)) {
    return emptyResult(portals, 'Upstream planner produced a crossing plan for this portal set.');
  }

  const fieldCount = Math.max(0, orderedLinks.length - portals.length + 1);
  const plan = {
    status: 'ok',
    portals,
    anchors: [],
    orderedLinks,
    fieldCount,
    linkCount: orderedLinks.length,
    maxKey: upstreamResult.maxKey,
    maxOutDegree: upstreamResult.maxOutDegree
  };
  const score = scorePlan(plan);
  const requiredKeys = summarizeRequiredKeys(portals, orderedLinks);

  return {
    ...plan,
    score,
    requiredKeys
  };
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
  return resolveIitcPortal(guid, data);
}

function resolveIitcPortal(guid, data = {}, windowRef = undefined) {
  const marker = data.portal ?? data.marker ?? windowRef?.portals?.[guid];
  const details = data.portalDetails ?? data.details ?? {};
  const markerData = marker?.options?.data ?? marker?.options ?? data.options?.data ?? data.options ?? {};
  const latLng = data.latLng ?? marker?.getLatLng?.() ?? marker?._latlng ?? {};
  const lngLat = details.locationE6
    ? {
        lat: details.locationE6.latE6 / 1e6,
        lng: details.locationE6.lngE6 / 1e6
      }
    : {};
  return normalizePortal({
    id: guid,
    name: details.title ?? markerData.title ?? markerData.name ?? data.title ?? data.name ?? guid,
    lat: latLng.lat ?? lngLat.lat ?? markerData.lat ?? data.lat,
    lng: latLng.lng ?? lngLat.lng ?? markerData.lng ?? data.lng
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
    installPortalDetailsButton(windowRef, plugin);
    renderSelection();
  };

  plugin.addPortal = function addPortal(portal) {
    store.add(portal);
    renderSelection();
    clearOutput();
  };

  plugin.addIitcPortal = function addIitcPortal(guid, data) {
    plugin.addPortal(resolveIitcPortal(guid, data, windowRef));
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

function installPortalDetailsButton(windowRef, plugin) {
  if (plugin.portalDetailsButtonInstalled) {
    return;
  }
  plugin.portalDetailsButtonInstalled = true;

  const renderButton = (data = {}) => {
    const guid = data.guid ?? data.portalGuid ?? windowRef.selectedPortal;
    const container = windowRef.document.querySelector('#portaldetails') ?? windowRef.document.querySelector('.portal_details');
    if (!guid || !container || container.querySelector('[data-iitc-mfp-add]')) {
      return;
    }

    const button = windowRef.document.createElement('button');
    button.type = 'button';
    button.textContent = 'Add to multi-field plan';
    button.setAttribute('data-iitc-mfp-add', guid);
    button.addEventListener('click', () => {
      plugin.addIitcPortal(guid, data);
      button.textContent = 'Added to multi-field plan';
      button.disabled = true;
    });
    container.append(button);
  };

  if (typeof windowRef.addHook === 'function') {
    windowRef.addHook('portalDetailsUpdated', renderButton);
  }

  windowRef.document.addEventListener('click', () => {
    windowRef.setTimeout?.(() => renderButton({ guid: windowRef.selectedPortal }), 0);
  });
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
