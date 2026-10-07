/*
 * In-page navigation for the guide pages (index.html, doc.html, legal.html).
 *
 * A plain #hash jump lands short or long on these pages, because:
 *  1. the sticky top nav wraps to two or three rows on narrower windows, so no fixed
 *     scroll-padding value is right at every width;
 *  2. sections fill in after the jump (the model-catalog tables, the rendered markdown),
 *     which moves the target after the browser has already scrolled;
 *  3. the last sections sit too close to the end of the page to scroll up under the nav.
 *
 * This script measures the nav, scrolls to the exact spot, holds the target in place while
 * late content settles (until the reader scrolls on their own), adds just enough room after the
 * footer for the last sections, and drives the "On this page" highlight.
 *
 * Pages call JBAnchors.refresh() after they change their own content.
 */
(function () {
  'use strict';

  var GAP = 16; // px between the nav's bottom edge and a target heading
  var SETTLE_MS = 1200; // keep holding the target this long after the last correction
  var HOLD_MAX_MS = 10000;

  var root = document.documentElement;
  var nav = document.querySelector('nav.top');
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var spacer = null;
  var hold = null; // the target being held in place
  var targetId = null; // where the last navigation pointed, even before that element exists
  var readerMoved = false; // the reader scrolled or clicked since that navigation
  var toc = [];
  var lit = null;
  var frame = 0;

  function now() {
    return Date.now();
  }
  function navHeight() {
    return nav ? nav.getBoundingClientRect().height : 0;
  }
  function offset() {
    return navHeight() + GAP;
  }
  function syncNav() {
    root.style.setProperty('--nav-h', Math.round(navHeight()) + 'px');
  }

  // Exact id first, then URI-decoded, then a punctuation-blind match, so GitHub-style anchors
  // ("runtime--files--locks") still find the doc viewer's slugs ("runtime-files-locks").
  function squash(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function find(id) {
    if (!id) return null;
    var el = document.getElementById(id);
    if (!el) {
      try {
        el = document.getElementById(decodeURIComponent(id));
      } catch (e) {
        el = null;
      }
    }
    if (el) return el;
    var want = squash(id);
    if (!want) return null;
    var all = document.querySelectorAll('[id]');
    for (var i = 0; i < all.length; i++) if (squash(all[i].id) === want) return all[i];
    return null;
  }

  function pageTop(el) {
    return el.getBoundingClientRect().top + window.pageYOffset;
  }

  // Room after the footer, so `el` can scroll up to the nav even when it is the last section.
  // It only ever grows: shrinking it while the reader is near the end would yank the page.
  function makeRoom(el) {
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = '0px';
      document.body.appendChild(spacer);
    }
    var have = spacer.offsetHeight;
    var below = root.scrollHeight - have - pageTop(el);
    var need = Math.ceil(window.innerHeight - offset() - below);
    if (need > have) spacer.style.height = need + 'px';
  }

  function wantY(el) {
    var max = root.scrollHeight - window.innerHeight;
    return Math.max(0, Math.min(Math.round(pageTop(el) - offset()), max));
  }

  // Instant, whatever the page's CSS scroll-behavior says ('instant' is not accepted everywhere).
  function jump(y) {
    var prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(window.pageXOffset, y);
    root.style.scrollBehavior = prev;
  }
  function glide(y) {
    try {
      window.scrollTo({ top: y, left: window.pageXOffset, behavior: 'smooth' });
    } catch (e) {
      jump(y);
    }
  }

  function go(id, smooth) {
    targetId = id;
    readerMoved = false;
    var el = find(id);
    if (!el) {
      hold = null;
      return false;
    }
    makeRoom(el);
    var y = wantY(el);
    var t = now();
    var animate = !!smooth && !reduceMotion && Math.abs(y - window.pageYOffset) > 2;
    if (animate) glide(y);
    else jump(y);
    hold = { el: el, want: y, smooth: animate, started: t, movedAt: t, settledAt: t, lastY: window.pageYOffset };
    mark(el);
    schedule();
    return true;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(step);
  }

  // One frame of holding: follow the target if content above it moved, until things settle.
  function step() {
    frame = 0;
    if (!hold) return;
    var t = now();
    if (!hold.el.isConnected) {
      var again = find(targetId);
      if (!again) {
        hold = null;
        return;
      }
      hold.el = again;
    }
    makeRoom(hold.el);
    var want = wantY(hold.el);
    var y = window.pageYOffset;
    if (Math.abs(y - hold.lastY) > 0.5) {
      hold.movedAt = t;
      hold.lastY = y;
    }
    if (hold.smooth) {
      if (Math.abs(want - hold.want) > 1) {
        glide(want); // the target moved mid-flight: re-aim
        hold.settledAt = t;
      } else if (Math.abs(y - want) <= 1 || (t - hold.movedAt > 200 && t - hold.started > 150)) {
        hold.smooth = false; // arrived, or the glide stopped short
        hold.settledAt = t;
      }
    }
    if (!hold.smooth && Math.abs(y - want) > 1) {
      jump(want);
      hold.settledAt = t;
      hold.lastY = window.pageYOffset;
    }
    hold.want = want;
    var settled = !hold.smooth && t - hold.settledAt > SETTLE_MS && document.readyState === 'complete';
    if (settled || t - hold.started > HOLD_MAX_MS) {
      hold = null;
      return;
    }
    schedule();
  }

  // Any reader input ends the hold — their scroll always wins.
  function readerTookOver() {
    readerMoved = true;
    hold = null;
  }

  // ── "On this page" highlight ─────────────────────────────────────────────
  function collect() {
    toc = [];
    var links = document.querySelectorAll('.toc a[href^="#"]');
    for (var i = 0; i < links.length; i++) {
      var el = find(links[i].getAttribute('href').slice(1));
      if (el) toc.push({ a: links[i], el: el });
    }
  }

  function mark(el) {
    var pick = null;
    var i;
    if (el) for (i = 0; i < toc.length; i++) if (toc[i].el === el) pick = toc[i];
    if (!pick && toc.length) {
      var line = offset() + 4;
      for (i = 0; i < toc.length; i++) if (toc[i].el.getBoundingClientRect().top <= line) pick = toc[i];
      if (window.pageYOffset + window.innerHeight >= root.scrollHeight - 2) {
        // At the very end, the last section on screen is the one being read.
        for (i = toc.length - 1; i >= 0; i--) {
          if (toc[i].el.getBoundingClientRect().top < window.innerHeight) {
            pick = toc[i];
            break;
          }
        }
      }
      if (!pick) pick = toc[0];
    }
    var a = pick ? pick.a : null;
    if (a === lit) return;
    if (lit) lit.classList.remove('on');
    lit = a;
    if (a) {
      a.classList.add('on');
      reveal(a);
    }
  }

  // Keep the lit link inside the sidebar's own scroll area (never scrolls the page).
  function reveal(a) {
    var box = a.closest ? a.closest('aside') : null;
    if (!box || box.scrollHeight <= box.clientHeight + 1) return;
    var r = a.getBoundingClientRect();
    var b = box.getBoundingClientRect();
    if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top;
    else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - (b.bottom - 8);
  }

  function refresh() {
    syncNav();
    collect();
    if (hold) schedule();
    else if (targetId && !readerMoved) go(targetId, false);
    else mark(null);
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    if (!a.hash || a.hash === '#') return;
    if (a.protocol !== location.protocol || a.host !== location.host || a.pathname !== location.pathname || a.search !== location.search) return;
    var id = a.hash.slice(1);
    if (!find(id)) return;
    e.preventDefault();
    if (location.hash !== a.hash) {
      try {
        history.pushState(null, '', a.hash);
      } catch (err) {
        /* some browsers refuse pushState on file:// — the jump still happens */
      }
    }
    go(id, true);
  });

  // Typed into the address bar, or Back / Forward between sections.
  window.addEventListener('hashchange', function () {
    if (location.hash.length > 1) go(location.hash.slice(1), false);
  });

  window.addEventListener('wheel', readerTookOver, { passive: true });
  window.addEventListener('touchstart', readerTookOver, { passive: true });
  window.addEventListener('pointerdown', readerTookOver, true);
  window.addEventListener(
    'keydown',
    function (e) {
      if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End|Tab| |Spacebar)$/.test(e.key)) readerTookOver();
    },
    true
  );

  var queued = false;
  window.addEventListener(
    'scroll',
    function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        mark(hold ? hold.el : null);
      });
    },
    { passive: true }
  );

  function onResize() {
    syncNav();
    if (hold) schedule();
    else mark(null);
  }
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver && nav) new ResizeObserver(onResize).observe(nav);

  window.JBAnchors = { refresh: refresh, go: go };

  syncNav();
  collect();
  // The browser has already jumped once while parsing; take over so late content cannot shift it.
  // A target that is not rendered yet (doc.html) is landed by the page's refresh() call.
  if (location.hash.length > 1) go(location.hash.slice(1), false);
  if (!hold) mark(null);
})();
