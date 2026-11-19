// Walk: at every width from a small phone to a 2560 screen, every button label fits on one line with
// its spaces, every dropdown chevron sits level with its label, the header menu stays clear of the
// search, account and cart icons, no picture is drawn at a different shape from its file, no photo
// leaves a gap in the frame it is meant to fill, no text runs over other text or sits on a picture
// it was not laid over on purpose, no text is cut off by its box, and the page never scrolls sideways.
// WIDTH_SHOTS=<folder> also saves the top of each page at every width, to look at before reporting.
//
// Exists because the other walks measure 390px and 1440px only, and on one build every one of
// these reached the client between those widths: a button squeezed onto two lines at a 1000px
// laptop, the header menu running under the icons from 768px to 1180px after its "More" overflow
// broke, chevrons lifted 12px when their tap target grew, and a quiz's budget answers reading
// "AROUND$530" because flex dropped the spaces around a price.
//   PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run widths
// Pages: design/seo-pages.json, or WIDTH_PAGES. Steps of a multi-step form that start hidden are
// opened and measured if they carry data-step. A page that could not be loaded is NOT CHECKED and
// exits 1: it is never a pass. design/widths.json (optional) lists text clipped or overlapping on
// purpose: { "cutOffOk": ["selector"], "overlapOk": ["selector"] }.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCookies, onPasswordPage } from "./preview-session.mjs";
import { withPreview } from "./seo-walk.mjs";
import { isMain } from "../platform.mjs";
import { pageList, statusOk } from "./page-list.mjs";
import { pacedGoto, pacedFetch } from "./pace.mjs";


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Phones to large tablets as well as laptops: a hero photo sized for 390px left bands down both
// sides from about 420px to 767px on one build, and no width between 390 and 768 was checked.
export const WIDTHS = [320, 360, 390, 414, 480, 540, 600, 640, 700, 767, 768, 820, 900, 990, 1024, 1100, 1180, 1280, 1300, 1366, 1440, 1600, 1920, 2560];
export const BUTTONS = '.button, .button-secondary, [class*="btn"]:is(a, button)';

function pagesToCheck() {
  // one page per type only: 24 widths of every state page would be hundreds of loads (scripts/qa/pace.mjs)
  return pageList(process.env.WIDTH_PAGES ? "WIDTH_PAGES" : "BUTTON_PAGES", { states: false });
}

// Runs in the page: labels of visible buttons whose text runs over more than one line or out of the box.
export function wrappedButtons(selector) {
  const st = document.createElement("style");
  st.textContent = "* { content-visibility: visible !important; }";
  document.head.appendChild(st);
  return [...document.querySelectorAll(selector)].filter((b) => {
    if (!b.getClientRects().length || !b.textContent.trim()) return false;
    const cs = getComputedStyle(b);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    // a skip link or screen-reader label hidden with clip (shown only on keyboard focus) is not seen
    if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) return false;
    // Only text a sighted visitor sees: a screen-reader label clipped to 1px wraps by design.
    const seen = (el) => { for (let e = el; e && e !== b.parentElement; e = e.parentElement) { const r = e.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2 || +getComputedStyle(e).opacity === 0) return false; } return true; };
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    const tops = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !seen(n.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 4) tops.add(Math.round(r.top));
    }
    return tops.size > 1 || (tops.size > 0 && b.scrollWidth > b.clientWidth + 1);
  }).map((b) => b.textContent.trim().replace(/\s+/g, " ").slice(0, 40));
}

// Runs in the page: the header menu's last visible link ends before the first header icon starts,
// and the header fits the screen. Any header: Horizon's #header-component, else the first
// <header>, else [data-header]. On one build a custom header was never checked, because this only
// knew Horizon's. Generic: the main nav's last visible link is the menu end, and visible elements
// after the nav (search, account, cart) are the icons.
export function headerClash() {
  const hdr = document.querySelector("#header-component") || document.querySelector("header") || document.querySelector("[data-header]");
  if (!hdr) return [];
  const out = [];
  // seen by a visitor: laid out, not hidden, and not inside a faded-out dropdown or overlay
  const shown = (e) => {
    if (!e.getClientRects().length || !(e.getBoundingClientRect().width > 0) || getComputedStyle(e).visibility === "hidden") return false;
    for (let x = e; x && x !== hdr.parentElement; x = x.parentElement) if (+getComputedStyle(x).opacity === 0) return false;
    return true;
  };
  let links = [...hdr.querySelectorAll(".menu-list__list-item")].filter((l) => !l.slot && shown(l));
  let icons = [...hdr.querySelectorAll(".header__column--right > *")].filter(shown);
  if (!links.length || !icons.length) {
    // the main nav: the visible one with the most links
    const navs = [...hdr.querySelectorAll("nav")].filter(shown);
    const nav = navs.sort((a, b) => b.querySelectorAll("a").length - a.querySelectorAll("a").length)[0];
    if (nav) {
      links = [...nav.querySelectorAll("a")].filter(shown);
      const after = [...hdr.querySelectorAll("*")].filter((e) => !nav.contains(e) && !e.contains(nav) && (nav.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && shown(e));
      // the outermost of them only, so a cart button and its svg count once
      icons = after.filter((e) => !after.some((o) => o !== e && o.contains(e)));
      // an icon sits on the same row as the menu; a second header row (a search bar) is not one
      const nr = nav.getBoundingClientRect();
      icons = icons.filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > nr.top && r.top < nr.bottom; });
    }
  }
  if (links.length && icons.length) {
    const end = Math.max(...links.map((l) => l.getBoundingClientRect().right));
    const start = Math.min(...icons.map((i) => i.getBoundingClientRect().left));
    if (end > start + 1) out.push(`header menu runs ${Math.round(end - start)}px under the icons`);
  }
  for (const i of icons) if (i.getBoundingClientRect().right > document.documentElement.clientWidth + 1) { out.push("header icons run off the screen"); break; }
  // A dropdown's chevron sits level with its label. It rose 12px when its tap target grew to 24px
  // for WCAG and Horizon's translateY(-50%) came with it.
  for (const l of links) {
    const svg = l.querySelector(".menu-list__disclosure svg"), title = l.querySelector(".menu-list__link-title");
    if (!svg || !title || !svg.getClientRects().length) continue;
    const a = svg.getBoundingClientRect(), t = title.getBoundingClientRect();
    const off = Math.round((a.top + a.height / 2) - (t.top + t.height / 2));
    if (Math.abs(off) > 3) { out.push(`menu chevron sits ${Math.abs(off)}px ${off < 0 ? "above" : "below"} its label`); break; }
  }
  return out;
}

// Runs in the page: pictures drawn at a different shape from the file. On one build a header
// logo, held at a set height in a flex row with max-width: 100%, was narrowed by the row at laptop
// widths while its height stayed, so it squashed sideways. Only object-fit: fill (the default)
// stretches; cover and contain keep the shape on purpose.
export function squashedImages() {
  const out = [];
  for (const img of document.querySelectorAll("img")) {
    if (!img.getClientRects().length || !img.complete || !img.naturalWidth || !img.naturalHeight) continue;
    const cs = getComputedStyle(img);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.objectFit !== "fill") continue;
    // the content box: padding and borders are not the picture
    const w = img.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = img.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w < 24 || h < 24) continue;
    const drawn = w / h, file = img.naturalWidth / img.naturalHeight;
    if (Math.abs(drawn / file - 1) > 0.03) {
      let name = img.getAttribute("alt") || "";
      try { const u = new URL(img.currentSrc || img.src); if (/^https?:$/.test(u.protocol)) name = u.pathname.split("/").pop() || name; } catch {}
      out.push(name.slice(0, 60) || "(no name)");
    }
  }
  return out;
}

// Runs in the page: photos that leave a gap in the frame they fill. A positioned photo covering most
// of a clipped frame (a hero slide, a tile, a banner) must cover all of it: on one build the phone
// hero photo was sized by height, so on large phones it stopped short and left bands down both
// sides. Contained pictures (product shots, logos) are left alone, and so is a photo that covers
// under 60% of its frame (one placed beside text on purpose). data-qa-partial opts a photo out.
export function uncoveredPhotos() {
  const out = [];
  for (const img of document.querySelectorAll("img")) {
    if (!img.getClientRects().length || !img.complete || !img.naturalWidth || img.closest("[data-qa-partial]")) continue;
    const cs = getComputedStyle(img);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.objectFit === "contain" || cs.objectFit === "scale-down") continue;
    if (cs.position !== "absolute" && cs.position !== "fixed") continue;
    let frame = img.parentElement;
    while (frame && frame !== document.body && getComputedStyle(frame).overflow.indexOf("hidden") < 0 && getComputedStyle(frame).overflow.indexOf("clip") < 0) frame = frame.parentElement;
    if (!frame || frame === document.body) continue;
    // a slide or panel that is faded out is not on screen
    let seen = true;
    for (let e = img; e && e !== frame.parentElement; e = e.parentElement) if (+getComputedStyle(e).opacity === 0) { seen = false; break; }
    if (!seen) continue;
    const f = frame.getBoundingClientRect(), r = img.getBoundingClientRect();
    if (f.width < 80 || f.height < 80) continue;
    const ix = Math.max(0, Math.min(f.right, r.right) - Math.max(f.left, r.left));
    const iy = Math.max(0, Math.min(f.bottom, r.bottom) - Math.max(f.top, r.top));
    if ((ix * iy) / (f.width * f.height) < 0.6) continue;
    const gaps = [["left", r.left - f.left], ["right", f.right - r.right], ["top", r.top - f.top], ["bottom", f.bottom - r.bottom]].filter(([, g]) => g > 2);
    if (!gaps.length) continue;
    let name = img.getAttribute("alt") || "";
    try { const u = new URL(img.currentSrc || img.src); if (/^https?:$/.test(u.protocol)) name = u.pathname.split("/").pop() || name; } catch {}
    out.push(`${(name || "(no name)").slice(0, 50)} leaves ${gaps.map(([s, g]) => `${Math.round(g)}px at the ${s}`).join(", ")}`);
  }
  return out;
}

// Runs in the page: flex boxes whose words run together. Flex drops the spaces between a text run
// and an inline element (a price from the money filter prints its own <span>), so "Around $530"
// rendered as "AROUND$530". Measured on screen: a space in the source must leave a gap.
export function joinedWords() {
  const st = document.createElement("style");
  st.textContent = "* { content-visibility: visible !important; }";
  document.head.appendChild(st);
  // A multi-step form shows one step at a time; open every data-step so later answers are measured too.
  document.querySelectorAll("[data-step][hidden]").forEach((q) => { q.hidden = false; });
  const box = (n) => { if (n.nodeType === 1) return n.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(n); const rs = [...r.getClientRects()]; return rs.length ? rs.at(-1) : null; };
  const firstBox = (n) => { if (n.nodeType === 1) return n.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(n); return r.getClientRects()[0] || null; };
  const out = [];
  for (const e of document.querySelectorAll("button, a, label")) {
    if (!e.getClientRects().length || !/flex|grid/.test(getComputedStyle(e).display)) continue;
    const kids = [...e.childNodes].filter((n) => (n.nodeType === 3 && n.textContent.trim()) || (n.nodeType === 1 && n.textContent.trim()));
    for (let i = 1; i < kids.length; i++) {
      const A = kids[i - 1], B = kids[i];
      // a space in the source between two pieces of a label...
      const spaced = /\s$/.test(A.textContent) || /^\s/.test(B.textContent) || (A.nextSibling !== B && A.nextSibling?.nodeType === 3 && !A.nextSibling.textContent.trim() && A.nextSibling.textContent.length);
      if (!spaced) continue;
      const ra = box(A), rb = firstBox(B);
      if (!ra || !rb || Math.abs(ra.top - rb.top) > 4) continue;
      // ...must leave a gap on screen, unless the flex gap already does
      if (rb.left - ra.right < 2 && (parseFloat(getComputedStyle(e).columnGap) || 0) < 2) { out.push(e.textContent.replace(/\s+/g, " ").trim().slice(0, 40)); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- text that clashes or is cut off
//
// On builds QA found text running over other text, a caption sitting on a product photo it was never
// meant to cover, and labels cut off mid-word inside a box too small for them. The page gives the
// boxes (textBoxes, cutOffCandidates); the rules are pure functions below, so they are tested.

// design/widths.json, when the brand has one:
//   "cutOffOk":  ["selector"]   text clipped on purpose (a product title the theme clamps to two lines)
//   "overlapOk": ["selector"]   text that overlaps on purpose
export function widthsConfig(root = ROOT) {
  const file = join(root, "design", "widths.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

const cross = (a, b) => [Math.min(a[2], b[2]) - Math.max(a[0], b[0]), Math.min(a[3], b[3]) - Math.max(a[1], b[1])];

/**
 * Pairs of text boxes from different blocks that cover each other by more than `min` pixels across
 * and by more than half the shorter line's height. A box is { n: text node index, b: block
 * index, r: [left, top, right, bottom], s: snippet }, its height already trimmed to the font size.
 * Lines of one block are never compared, and a heading set with a line height under 1 (a display
 * font's lines stacked into each other on purpose) is not a clash: text run over text covers most
 * of a line.
 */
export function textOverlaps(boxes, { min = 3, share = 0.5 } = {}) {
  const sorted = [...boxes].sort((a, b) => a.r[1] - b.r[1]);
  const out = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].r[1] < a.r[3]; j++) {
      const b = sorted[j];
      if (a.b === b.b || a.n === b.n) continue;
      const [w, h] = cross(a.r, b.r);
      if (w > min && h > Math.max(min, share * Math.min(a.r[3] - a.r[1], b.r[3] - b.r[1]))) {
        const key = [Math.min(a.n, b.n), Math.max(a.n, b.n)].join(",");
        if (!out.has(key)) out.set(key, a.n < b.n ? [a, b] : [b, a]);
      }
    }
  }
  return [...out.values()];
}

/** Text boxes that sit on a picture by more than `min` pixels both ways: [text box, picture] pairs, one per text node and picture. */
export function textOnPictures(boxes, pictures, { min = 3 } = {}) {
  const out = new Map();
  for (const t of boxes) for (const p of pictures) {
    const [w, h] = cross(t.r, p.r);
    if (w > min && h > min && !out.has(`${t.n},${p.i}`)) out.set(`${t.n},${p.i}`, [t, p]);
  }
  return [...out.values()];
}

/**
 * Text cut off by its own box: the text is wider or taller than the box (overflow hidden or clip)
 * shows. An item is { s, sw, cw, sh, ch, clipX, clipY, marked, label, ok }. Text that ends in an
 * ellipsis or is clamped to a set number of lines (marked) is shortened by the theme on purpose (a
 * long product title, a breadcrumb, a review excerpt), so it only counts on a button or a header menu
 * link (label), where "Add to ca..." is a bug. Two pixels of slack: sub-pixel rounding and descenders are not cut off.
 */
export function cutOff(items, { slack = 2 } = {}) {
  return items.filter((x) => !x.ok && x.cw > 0 && (!x.marked || x.label) && ((x.clipX && x.sw > x.cw + slack) || (x.clipY && x.ch > 0 && x.sh > x.ch + slack)));
}

// Runs in the page: every visible line of text as a box, and every visible picture. Hidden text
// (display, visibility, opacity, a clip, a transparent colour, a box of 2px or less), text in a fixed
// layer (a chat button, a cookie bar), text off the side of the page and text clipped away by an
// ancestor's overflow do not count. Elements are kept on window for designedOverlay.
export function textBoxes(okSelectors) {
  const st = document.createElement("style");
  st.textContent = "* { content-visibility: visible !important; }";
  document.head.appendChild(st);
  const vis = new Map();
  const seen = (e) => {
    if (vis.has(e)) return vis.get(e);
    let ok = true;
    if (!e.getClientRects().length) ok = false;
    else {
      const cs = getComputedStyle(e);
      if (cs.visibility !== "visible" || cs.display === "none" || +cs.opacity === 0 || cs.position === "fixed") ok = false;
      else if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) ok = false;
      else { const r = e.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) ok = false; }
      if (ok && e.parentElement && e.parentElement !== document.documentElement) ok = seen(e.parentElement);
    }
    vis.set(e, ok);
    return ok;
  };
  // the rectangle left after the element and every ancestor that clips (a scroller is not one: the page itself can
  // be a scroller, and a rail's cards sit side by side)
  const clipOf = (e, r) => {
    let [l, t, rr, b] = r;
    for (let x = e; x && x !== document.documentElement; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (/hidden|clip/.test(cs.overflowX + cs.overflowY)) {
        const c = x.getBoundingClientRect();
        if (/hidden|clip/.test(cs.overflowX)) { l = Math.max(l, c.left); rr = Math.min(rr, c.right); }
        if (/hidden|clip/.test(cs.overflowY)) { t = Math.max(t, c.top); b = Math.min(b, c.bottom); }
      }
      if (rr - l <= 1 || b - t <= 1) return null;
    }
    return [l, t, rr, b];
  };
  const blockOf = (e) => { for (let x = e; x; x = x.parentElement) if (!/^inline|^contents$/.test(getComputedStyle(x).display)) return x; return document.body; };
  const ids = new Map();
  const id = (e) => { if (!ids.has(e)) ids.set(e, ids.size); return ids.get(e); };
  const W = document.documentElement.clientWidth;
  const texts = [], els = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const e = n.parentElement;
    if (!e || !n.textContent.trim() || e.closest("script, style, noscript, template, select, option, textarea, svg")) continue;
    // a closed details shows its summary only (the content-visibility rule above lets the rest lay out)
    if (e.closest("details:not([open])") && !e.closest("summary")) continue;
    if (okSelectors.length && e.closest(okSelectors.join(", "))) continue;
    if (!seen(e)) continue;
    const cs = getComputedStyle(e);
    if (/rgba\(.*,\s*0\)$/.test(cs.color) || cs.color === "transparent") continue;
    const fs = parseFloat(cs.fontSize) || 0;
    const range = document.createRange(); range.selectNodeContents(n);
    const idx = els.length;
    let any = false;
    for (const q of range.getClientRects()) {
      if (q.width <= 1 || q.height <= 4 || q.right <= 0 || q.left >= W) continue;
      const inset = Math.max(0, (q.height - fs) / 2);
      const r = clipOf(e, [q.left, q.top + inset, q.right, q.bottom - inset]);
      if (!r) continue;
      any = true;
      texts.push({ n: idx, b: id(blockOf(e)), r: [r[0] + scrollX, r[1] + scrollY, r[2] + scrollX, r[3] + scrollY].map(Math.round), s: n.textContent.trim().replace(/\s+/g, " ").slice(0, 30) });
    }
    if (any) els.push(e);
  }
  const pictures = [], pics = [];
  for (const p of document.querySelectorAll("img, video")) {
    if (!seen(p) || (p.closest("details:not([open])") && !p.closest("summary"))) continue;
    const q = p.getBoundingClientRect();
    if (q.width < 24 || q.height < 24) continue;
    const r = clipOf(p, [q.left, q.top, q.right, q.bottom]);
    if (!r || r[2] - r[0] < 24 || r[3] - r[1] < 24) continue;
    let name = p.getAttribute("alt") || "";
    try { const u = new URL(p.currentSrc || p.src); if (/^https?:$/.test(u.protocol)) name = u.pathname.split("/").pop() || name; } catch {}
    pictures.push({ i: pics.length, r: [r[0] + scrollX, r[1] + scrollY, r[2] + scrollX, r[3] + scrollY].map(Math.round), s: (name || "(no name)").slice(0, 50) });
    pics.push(p);
  }
  window.__qaText = els; window.__qaPics = pics;
  return { texts, pictures };
}

// Runs in the page: of [text node index, picture index] pairs, the ones NOT laid over the picture on
// purpose. On purpose means: the text, or a box it sits in, is positioned absolutely over the
// picture (a hero caption, a sale badge); or the picture is a background, placed absolutely in a box
// that also holds the text (a banner); or the two share a grid cell (stacked with grid on purpose).
export function designedOverlay(pairs) {
  const out = [];
  for (const [ti, pi] of pairs) {
    const t = window.__qaText[ti], p = window.__qaPics[pi];
    if (!t || !p) continue;
    let common = t;
    while (common && !common.contains(p)) common = common.parentElement;
    if (!common) continue;
    let designed = /grid/.test(getComputedStyle(common).display);
    for (let x = t; !designed && x && x !== common; x = x.parentElement) if (/absolute|fixed|sticky/.test(getComputedStyle(x).position)) designed = true;
    // the picture's outermost absolutely placed box, if any: a background when it is placed
    // against a box that holds the text as well
    for (let x = p; !designed && x && x !== common; x = x.parentElement) {
      if (/absolute|fixed/.test(getComputedStyle(x).position)) {
        const cb = x.offsetParent || document.body;
        if (cb.contains(t)) designed = true;
      }
    }
    if (!designed) out.push([ti, pi]);
  }
  return out;
}

// Runs in the page: every visible element holding text of its own in a box that clips it (overflow
// hidden or clip, or an ellipsis), with its sizes for cutOff().
export function cutOffCandidates(okSelectors) {
  const out = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (e.closest("script, style, noscript, template, select, option, textarea, svg")) continue;
    if (e.closest("details:not([open])") && !e.closest("summary")) continue;
    const cs = getComputedStyle(e);
    const clipX = /hidden|clip/.test(cs.overflowX) || cs.textOverflow === "ellipsis", clipY = /hidden|clip/.test(cs.overflowY);
    if (!clipX && !clipY) continue;
    if (!e.getClientRects().length || cs.visibility !== "visible" || cs.display === "none") continue;
    if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) continue;
    let shown = true;
    for (let x = e; x && x !== document.documentElement; x = x.parentElement) {
      const xs = getComputedStyle(x), r = x.getBoundingClientRect();
      if (+xs.opacity === 0 || xs.visibility !== "visible" || r.width <= 2 || r.height <= 2) { shown = false; break; }
    }
    if (!shown) continue;
    out.push({
      s: e.textContent.trim().replace(/\s+/g, " ").slice(0, 40),
      sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, clipX, clipY,
      marked: cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none"),
      label: Boolean(e.closest('button, a.button, [role="button"], input[type="submit"], :is(a, button)[class*="button"], :is(a, button)[class*="btn"], header nav a, #header-component nav a')),
      ok: okSelectors.length ? Boolean(e.closest(okSelectors.join(", "))) : false,
    });
  }
  return out;
}

/**
 * Every in-page check above on the page as it is now, as plain-English findings (one per problem).
 * evaluate(fn, ...args) runs fn in the page: puppeteer's page.evaluate, or the browsers walk's
 * runner for WebKit and Firefox, so both walks check with this one copy. Note it opens hidden
 * data-step form steps, so read anything else from the page first.
 */
export async function pageFindings(evaluate, cfg = {}) {
  const found = [];
  await evaluate(() => document.fonts.ready);
  for (const label of new Set(await evaluate(wrappedButtons, BUTTONS))) found.push(`"${label}" wraps`);
  for (const msg of await evaluate(headerClash)) found.push(msg);
  for (const label of new Set(await evaluate(joinedWords))) found.push(`"${label}" has words run together`);
  for (const name of new Set(await evaluate(squashedImages))) found.push(`picture squashed: ${name}`);
  for (const msg of new Set(await evaluate(uncoveredPhotos))) found.push(`photo gap: ${msg.replace(/\d+px/g, "Npx")}`);
  const { texts, pictures } = await evaluate(textBoxes, cfg.overlapOk || []);
  for (const [a, b] of textOverlaps(texts)) found.push(`text overlaps text: "${a.s}" and "${b.s}"`);
  const onPics = textOnPictures(texts, pictures);
  const stray = new Set((await evaluate(designedOverlay, onPics.map(([t, p]) => [t.n, p.i]))).map((x) => x.join(",")));
  for (const [t, p] of onPics) if (stray.has(`${t.n},${p.i}`)) found.push(`text sits on a picture: "${t.s}" on ${p.s}`);
  for (const x of new Set(cutOff(await evaluate(cutOffCandidates, cfg.cutOffOk || [])).map((x) => x.s))) found.push(`text cut off: "${x}"`);
  const wide = await evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (wide > 1) found.push("page scrolls sideways");
  return [...new Set(found)];
}

async function main() {
  const RAW = process.env.PREVIEW_URL || process.argv.find((a) => a.startsWith("http"));
  if (!RAW) { console.log("Nothing checked. Give it the preview URL:\n  PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run widths"); process.exit(1); }
  const base = new URL(RAW);
  const puppeteer = (await import("puppeteer-core")).default;
  const { Launcher } = await import("chrome-launcher");
  const chrome = Launcher.getInstallations()[0];
  if (!chrome) { console.log("NOT CHECKED: no Chrome found on this machine."); process.exit(1); }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const cfg = widthsConfig();
  let fails = 0, unchecked = 0;
  try {
    for (const path of pagesToCheck()) {
      const page = await browser.newPage();
      await applyCookies(page, base.toString());
      const found = {};
      for (const w of WIDTHS) {
        await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
        const res = await pacedGoto(page, withPreview(path, base), { waitUntil: "load", timeout: 90000 }).catch((e) => ({ error: e.message }));
        if (res?.error || (res && res.status && !statusOk(path, res.status()))) { unchecked++; console.log(`NOT CHECKED ${path} at ${w}px: ${res.error || res.status()}`); continue; }
        if (onPasswordPage(page.url())) { unchecked++; console.log(`NOT CHECKED ${path} at ${w}px: the store password page came back, not the page (set .storefront-password or STOREFRONT_PASSWORD)`); continue; }
        for (const msg of await pageFindings((fn, ...args) => page.evaluate(fn, ...args), cfg)) (found[msg] ||= []).push(w);
        if (process.env.WIDTH_SHOTS) {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(process.env.WIDTH_SHOTS, { recursive: true });
          const slug = (path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home").slice(0, 60);
          await page.screenshot({ path: join(process.env.WIDTH_SHOTS, `${slug}-${String(w).padStart(4, "0")}.png`) });
        }
      }
      const bad = Object.entries(found);
      fails += bad.length;
      console.log(bad.length ? `FAIL ${path}\n${bad.map(([l, ws]) => `     ${l} at ${ws.join(", ")}px`).join("\n")}` : `ok   ${path}`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`\n${fails} FAIL, ${unchecked} not checked (${WIDTHS.length} widths from ${WIDTHS[0]}px to ${WIDTHS.at(-1)}px).`);
  process.exit(fails || unchecked ? 1 : 0);
}

if (isMain(import.meta.url)) main();
