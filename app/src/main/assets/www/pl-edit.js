/* ════════════════════════════════════════════════════════════════════
   PLAYLIST EDIT MODE  (long-press → edit)
   - 플레이리스트 상세의 곡 행을 길게 누르면 edit 상태가 된다.
   - edit 행 옆(아래/위)에 Liquid Glass 컨텍스트 메뉴(곡 삭제 / 즐겨찾기)가 나타난다.
   - edit 행은 세로로 드래그해 순서를 바꾼다. 범위는 목록(#pl-track-list) 안으로 제한된다.
   - 다른 행들은 translate3d 만으로(레이아웃 재계산 없음) 순차적·유기적으로 자리를 비켜 주고, 서로 겹치지 않는다.
   성능 원칙: 드래그 중 DOM 읽기는 시작 시 1회, 이후는 transform 쓰기뿐 / rAF 1회 / 배경 캔버스 정지.
════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var LONG_MS = 420;          // 롱프레스 인식 시간
    var MOVE_TOL = 9;           // 롱프레스 중 허용 이동(px) — 넘으면 스크롤로 간주
    var DRAG_START = 4;         // edit 행 드래그 시작 임계(px)
    var STAGGER = 24;           // 이웃 행 이동 시작 간격(ms)
    var BOTTOM_SAFE = 150;      // 하단 도크(네이티브 글래스) 영역
    var TOP_SAFE = 64;

    var NATIVE = !!window.GlassBridge;
    var $ = function (id) { return document.getElementById(id); };
    var E = { on: false, plId: null, trackId: null, row: null, press: null, cand: null, drag: null, suppress: false };

    function listEl() { return $('pl-track-list'); }
    function menuEl() { return $('pl-edit-menu'); }
    function rowsOf() { var l = listEl(); return l ? Array.prototype.slice.call(l.querySelectorAll('.pl-track')) : []; }
    function curPl() { return typeof plById === 'function' ? plById(E.plId) : null; }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    /* ── 스크롤 헬퍼 (앱: 문서 스크롤 / 브라우저 단독: #main) ── */
    function scrollPos() { var m = $('main'); return (window.scrollY || 0) + (m ? m.scrollTop : 0); }
    function scrollBy(dy) {
        if (document.documentElement.classList.contains('glass-native')) window.scrollBy(0, dy);
        else { var m = $('main'); if (m) m.scrollTop += dy; }
    }

    /* ════════ 진입 / 종료 ════════ */
    function enterEdit(row) {
        if (E.on || !row || !row.isConnected) return;
        var plId = (typeof PL !== 'undefined') ? PL.curId : null;
        if (!plId) return;
        E.on = true; E.plId = plId; E.row = row; E.trackId = row.dataset.tid;
        E.suppress = true;
        document.documentElement.classList.add('pl-editing');
        listEl().classList.add('is-editing');
        row.classList.add('editing');
        window.__plDragging = false;
        refreshMenu();
        placeMenu();
        showMenu(true);
    }

    function exitEdit(silent) {
        if (!E.on && !E.press) return;
        clearPress();
        if (E.drag) { cancelDragNow(); }
        if (E.row) E.row.classList.remove('editing', 'dragging', 'settling');
        var l = listEl(); if (l) l.classList.remove('is-editing', 'pl-reordering');
        document.documentElement.classList.remove('pl-editing');
        window.__plDragging = false;
        showMenu(false);
        E.on = false; E.row = null; E.trackId = null; E.cand = null; E.drag = null;
    }
    window.plEditExit = exitEdit;

    /* ════════ 컨텍스트 메뉴 ════════ */
    function showMenu(on) {
        var m = menuEl(); if (!m) return;
        m.classList.toggle('on', !!on);
    }

    function refreshMenu() {
        var m = menuEl(); if (!m) return;
        var fav = typeof isFav === 'function' && isFav(E.trackId);
        var f = m.querySelector('[data-act="fav"]');
        if (f) {
            f.classList.toggle('on', fav);
            var lb = f.querySelector('.pl-edit-lb'); if (lb) lb.textContent = fav ? '즐겨찾기 해제' : '즐겨찾기';
            var p = f.querySelector('path');
            if (p) p.setAttribute('fill', fav ? 'currentColor' : 'none');
        }
    }

    /** 행 옆(아래 → 위 → 행 위에 겹쳐서) 로 메뉴를 놓는다. position: fixed 라 스크롤 잠금 상태에서 좌표가 고정이다. */
    function placeMenu() {
        var m = menuEl(), row = E.row; if (!m || !row) return;
        var r = row.getBoundingClientRect();
        var w = 200, h = 112;
        var x = clamp(r.right - w - 6, 8, innerWidth - w - 8);
        var bottomLimit = innerHeight - BOTTOM_SAFE;
        var y = r.bottom + 8;
        if (y + h > bottomLimit) y = r.top - h - 8;
        if (y < TOP_SAFE) y = clamp(r.top + r.height / 2 - h / 2, TOP_SAFE, Math.max(TOP_SAFE, bottomLimit - h));
        m.style.left = Math.round(x) + 'px';
        m.style.top = Math.round(y) + 'px';
    }

    function onMenuAct(act) {
        if (!E.on) return;
        if (act === 'fav') {
            var pl = curPl(); if (!pl) return;
            var t = pl.tracks.find(function (x) { return x.id === E.trackId; });
            if (t && typeof toggleFavTrack === 'function') toggleFavTrack(t);
            refreshMenu();
        } else if (act === 'del') {
            deleteCurrent();
        }
    }
    window.__plEditAct = function (i) {      // 네이티브 글래스 메뉴 → DOM
        var b = menuEl() && menuEl().querySelectorAll('.pl-edit-item')[i];
        if (b) onMenuAct(b.dataset.act);
    };

    /* ════════ 삭제 ════════ */
    function syncQueueAfterEdit(oldTracks) {
        // 재생 중인 큐가 이 플레이리스트에서 만들어진 복사본이면 변경 사항을 같이 반영한다.
        var pl = curPl(); if (!pl || typeof S === 'undefined') return;
        var same = S.q.length === oldTracks.length && S.q.every(function (t, i) { return t.id === oldTracks[i].id; });
        if (!same) return;
        var cur = S.track && S.track.id;
        S.q = pl.tracks.slice();
        var ni = cur ? S.q.findIndex(function (t) { return t.id === cur; }) : -1;
        if (ni >= 0) S.idx = ni;
        else if (S.idx >= S.q.length) S.idx = S.q.length - 1;   // 현재 곡이 삭제됨: 재생은 계속, 다음 곡은 이어서
    }

    function renumber() {
        rowsOf().forEach(function (r, i) {
            r.dataset.i = i;
            var n = r.querySelector('.pl-track-num'); if (n) n.textContent = i + 1;
        });
    }

    function refreshHeader(pl) {
        var cnt = $('pl-detail-count'); if (cnt) cnt.textContent = pl.tracks.length + '곡';
        var cover = $('pl-detail-cover'); if (!cover) return;
        var thumbs = pl.tracks.slice(0, 4).map(function (t) { return trackThumbSrc(t); });
        var sig = thumbs.join('|');
        if (cover.dataset.sig === sig) return;
        cover.dataset.sig = sig;
        cover.className = 'pl-detail-cover' + (thumbs.length === 1 ? ' single' : '');
        cover.innerHTML = thumbs.map(function (src) { return '<img src="' + esc(src) + '" alt="">'; }).join('');
    }

    function deleteCurrent() {
        var pl = curPl(), row = E.row; if (!pl || !row) return;
        var id = E.trackId;
        var old = pl.tracks.slice();
        var title = (old.find(function (t) { return t.id === id; }) || {}).title || '';
        showMenu(false);
        var h = row.offsetHeight;
        row.style.height = h + 'px';
        row.style.overflow = 'hidden';
        void row.offsetHeight;
        row.classList.add('removing');
        row.style.height = '0px';
        row.style.paddingTop = '0px'; row.style.paddingBottom = '0px';
        var done = false;
        var finish = function () {
            if (done) return; done = true;
            pl.tracks = pl.tracks.filter(function (t) { return t.id !== id; });
            plSave();
            syncQueueAfterEdit(old);
            exitEdit(true);
            if (row.parentNode) row.parentNode.removeChild(row);
            if (!pl.tracks.length) { plRenderDetail(pl.id); } else { renumber(); refreshHeader(pl); }
            if (typeof syncPlayingHighlights === 'function') syncPlayingHighlights();
            toast('곡을 삭제했어요' + (title ? ' · ' + (title.length > 22 ? title.slice(0, 22) + '…' : title) : ''));
        };
        row.addEventListener('transitionend', function (e) { if (e.propertyName === 'height') finish(); });
        setTimeout(finish, 360);
    }

    /* ════════ 롱프레스 ════════ */
    function clearPress() {
        if (E.press) { clearTimeout(E.press.timer); E.press = null; }
    }

    function onDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        var row = e.target.closest && e.target.closest('.pl-track');
        if (E.on) {
            if (row && row === E.row) {                       // edit 행: 드래그 후보
                E.cand = { id: e.pointerId, x: e.clientX, y: e.clientY };
                try { row.setPointerCapture(e.pointerId); } catch (_) { }
            } else {                                          // 다른 곳 터치 → edit 종료
                exitEdit();
                E.suppress = true;                            // 이어지는 click 으로 곡이 재생되지 않게
            }
            return;
        }
        if (!row || e.target.closest('.pl-track-del')) return;
        E.suppress = false;
        clearPress();
        E.press = {
            id: e.pointerId, x: e.clientX, y: e.clientY, row: row,
            timer: setTimeout(function () {
                var p = E.press; E.press = null;
                if (!p || !p.row.isConnected) return;
                enterEdit(p.row);
                if (E.on) E.cand = { id: p.id, x: p.lx != null ? p.lx : p.x, y: p.ly != null ? p.ly : p.y, fromPress: true };
            }, LONG_MS)
        };
    }

    function onMove(e) {
        var p = E.press;
        if (p && e.pointerId === p.id) {
            p.lx = e.clientX; p.ly = e.clientY;
            if (Math.abs(e.clientX - p.x) > MOVE_TOL || Math.abs(e.clientY - p.y) > MOVE_TOL) clearPress();
            return;
        }
        if (!E.on) return;
        if (E.drag) {
            if (e.pointerId !== E.drag.pid) return;
            E.drag.lastY = e.clientY;
            queueApply();
            return;
        }
        var c = E.cand;
        if (c && e.pointerId === c.id && Math.abs(e.clientY - c.y) > DRAG_START) startDrag(e.pointerId, c.y, e.clientY);
    }

    function onUp(e) {
        var p = E.press;
        if (p && e.pointerId === p.id) clearPress();
        if (E.cand && e.pointerId === E.cand.id) E.cand = null;
        if (E.drag && e.pointerId === E.drag.pid) endDrag();
    }

    /* ════════ 드래그 & 정렬 ════════ */
    function startDrag(pid, y0, y) {
        var rows = rowsOf(), from = rows.indexOf(E.row);
        if (from < 0 || rows.length < 2) { E.cand = null; return; }
        var rects = rows.map(function (r) { return { top: r.offsetTop, h: r.offsetHeight }; });
        var n = rows.length;
        var gap = Math.max(0, rects[1].top - (rects[0].top + rects[0].h));
        var listTop = rects[0].top, listBottom = rects[n - 1].top + rects[n - 1].h;
        E.drag = {
            pid: pid, rows: rows, from: from, to: from, rects: rects, gap: gap,
            startY: y0, lastY: y, baseScroll: scrollPos(),
            minDy: listTop - rects[from].top,
            maxDy: (listBottom - rects[from].h) - rects[from].top,
            dy: 0, shifts: rows.map(function () { return 0; }), raf: 0, auto: 0, autoRaf: 0
        };
        E.cand = null;
        window.__plDragging = true;
        showMenu(false);
        listEl().classList.add('pl-reordering');
        E.row.classList.remove('settling');
        E.row.classList.add('dragging');
        queueApply();
    }

    function queueApply() {
        var d = E.drag; if (!d || d.raf) return;
        d.raf = requestAnimationFrame(applyDrag);
    }

    /** to 위치에 놓았을 때 각 행이 가질 이동량(px). 균일하지 않은 높이도 누적 계산해 겹치지 않게 한다. */
    function layoutShifts(d, to) {
        var n = d.rows.length, order = [], i;
        for (i = 0; i < n; i++) if (i !== d.from) order.push(i);
        order.splice(to, 0, d.from);
        var top = d.rects[0].top, out = new Array(n);
        for (var p = 0; p < n; p++) {
            var idx = order[p];
            out[idx] = top - d.rects[idx].top;
            top += d.rects[idx].h + d.gap;
        }
        return out;
    }

    function applyDrag() {
        var d = E.drag; if (!d) return;
        d.raf = 0;
        var dy = (d.lastY - d.startY) + (scrollPos() - d.baseScroll);
        var clamped = clamp(dy, d.minDy, d.maxDy);
        d.dy = clamped;
        E.row.style.transform = 'translate3d(0,' + clamped + 'px,0) scale(1.03)';

        /* 목표 위치: 드래그 행의 중심에서 가장 가까운 슬롯 */
        var r = d.rects[d.from], center = r.top + clamped + r.h / 2, best = d.from, bd = 1e9;
        for (var j = 0; j < d.rects.length; j++) {
            var dist = Math.abs(center - (d.rects[j].top + d.rects[j].h / 2));
            if (dist < bd) { bd = dist; best = j; }
        }
        if (best !== d.to) { d.to = best; applyShifts(d); }

        /* 가장자리 자동 스크롤: 이미 목록 경계에 닿았으면 더 이상 스크롤하지 않는다 */
        var v = 0;
        if (d.lastY < TOP_SAFE + 50 && dy > d.minDy) v = -Math.ceil((TOP_SAFE + 50 - d.lastY) / 6);
        else if (d.lastY > innerHeight - BOTTOM_SAFE - 20 && dy < d.maxDy) v = Math.ceil((d.lastY - (innerHeight - BOTTOM_SAFE - 20)) / 6);
        d.auto = clamp(v, -16, 16);
        if (d.auto && !d.autoRaf) d.autoRaf = requestAnimationFrame(autoScroll);
    }

    function autoScroll() {
        var d = E.drag; if (!d) return;
        d.autoRaf = 0;
        if (!d.auto) return;
        var before = scrollPos();
        scrollBy(d.auto);
        if (scrollPos() === before) { d.auto = 0; return; }   // 문서 끝: 더 갈 곳이 없으면 루프 종료(다음 이동 때 재개)
        queueApply();                                   // 스크롤 변화량을 반영해 다시 계산(경계에 닿으면 auto 가 0 이 된다)
        d.autoRaf = requestAnimationFrame(autoScroll);
    }

    /** 이웃 행 이동: 이동 방향의 "선두" 행부터 STAGGER 간격으로 출발 → 앞 행이 먼저 비켜 줘서 겹치지 않는다. */
    function applyShifts(d) {
        var next = layoutShifts(d, d.to), up = [], down = [], i;
        for (i = 0; i < d.rows.length; i++) {
            if (i === d.from) continue;
            var diff = next[i] - d.shifts[i];
            if (Math.abs(diff) < .5) continue;
            (diff > 0 ? down : up).push(i);
        }
        down.sort(function (a, b) { return b - a; });   // 아래로 이동: 아래쪽(큰 인덱스)이 선두
        up.sort(function (a, b) { return a - b; });     // 위로 이동: 위쪽(작은 인덱스)이 선두
        var apply = function (list) {
            list.forEach(function (idx, rank) {
                var el = d.rows[idx];
                el.style.transitionDelay = Math.min(rank, 6) * STAGGER + 'ms';
                el.style.transform = Math.abs(next[idx]) < .5 ? '' : 'translate3d(0,' + next[idx] + 'px,0)';
            });
        };
        apply(down); apply(up);
        d.shifts = next;
    }

    function endDrag() {
        var d = E.drag; if (!d) return;
        if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; applyDrag(); }
        if (d.autoRaf) { cancelAnimationFrame(d.autoRaf); d.autoRaf = 0; }
        d.auto = 0;
        var finalShift = layoutShifts(d, d.to)[d.from];
        var row = E.row;
        row.classList.remove('dragging');
        row.classList.add('settling');
        row.style.transitionDelay = '0ms';
        row.style.transform = Math.abs(finalShift) < .5 ? '' : 'translate3d(0,' + finalShift + 'px,0)';
        var done = false;
        var commit = function () {
            if (done) return; done = true;
            commitOrder(d);
        };
        row.addEventListener('transitionend', function h(e) {
            if (e.propertyName !== 'transform') return;
            row.removeEventListener('transitionend', h); commit();
        });
        setTimeout(commit, 420);
    }

    function commitOrder(d) {
        var l = listEl(); if (!E.drag || E.drag !== d || !l) return;
        var pl = curPl(), rows = d.rows;
        /* 전환 없이 한 번에: 최종 위치와 같은 자리에 DOM 을 재배치 → 시각 변화 0 */
        rows.forEach(function (r) { r.style.transition = 'none'; r.style.transform = ''; r.style.transitionDelay = ''; r.classList.remove('settling'); });
        if (d.to !== d.from && pl) {
            var old = pl.tracks.slice();
            var mv = pl.tracks.splice(d.from, 1)[0];
            pl.tracks.splice(d.to, 0, mv);
            plSave();
            var moved = rows[d.from];
            if (d.to > d.from) l.insertBefore(moved, rows[d.to].nextSibling); else l.insertBefore(moved, rows[d.to]);
            renumber();
            refreshHeader(pl);
            syncQueueAfterEdit(old);
            if (typeof syncPlayingHighlights === 'function') syncPlayingHighlights();
        }
        void l.offsetHeight;
        requestAnimationFrame(function () { rows.forEach(function (r) { r.style.transition = ''; }); });
        l.classList.remove('pl-reordering');
        window.__plDragging = false;
        E.drag = null;
        if (E.on && E.row) { refreshMenu(); placeMenu(); showMenu(true); }
    }

    function cancelDragNow() {
        var d = E.drag; if (!d) return;
        if (d.raf) cancelAnimationFrame(d.raf);
        if (d.autoRaf) cancelAnimationFrame(d.autoRaf);
        d.rows.forEach(function (r) { r.style.transition = 'none'; r.style.transform = ''; r.style.transitionDelay = ''; r.classList.remove('dragging', 'settling'); });
        void listEl().offsetHeight;
        requestAnimationFrame(function () { d.rows.forEach(function (r) { r.style.transition = ''; }); });
        E.drag = null;
    }

    /* ════════ 이벤트 연결 ════════ */
    function init() {
        var l = listEl(); if (!l) return;
        l.addEventListener('pointerdown', onDown);
        l.addEventListener('pointermove', onMove);
        l.addEventListener('pointerup', onUp);
        l.addEventListener('pointercancel', function (e) {
            if (E.press && e.pointerId === E.press.id) clearPress();
            if (E.cand && e.pointerId === E.cand.id) E.cand = null;
            if (E.drag && e.pointerId === E.drag.pid) endDrag();
        });
        l.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        /* edit 행을 잡은 손가락은 스크롤이 아니라 드래그다 (롱프레스 직후 이어지는 제스처 포함) */
        l.addEventListener('touchmove', function (e) {
            if ((E.cand || E.drag) && e.cancelable) e.preventDefault();
        }, { passive: false });
        /* 롱프레스/edit 중 발생하는 click 이 곡 재생으로 이어지지 않게 캡처 단계에서 차단 */
        l.addEventListener('click', function (e) {
            if (E.on || E.suppress) {
                e.stopPropagation(); e.preventDefault();
                if (!E.on) E.suppress = false;
            }
        }, true);
        /* 목록 밖(헤더, 내비 등)을 누르면 edit 종료 */
        document.addEventListener('pointerdown', function (e) {
            if (!E.on) return;
            if (e.target.closest && (e.target.closest('#pl-track-list') || e.target.closest('#pl-edit-menu'))) return;
            exitEdit();
        }, true);
        var m = menuEl();
        if (m) m.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('.pl-edit-item');
            if (b) { e.stopPropagation(); onMenuAct(b.dataset.act); }
        });
        window.addEventListener('resize', function () { if (E.on && !E.drag) { placeMenu(); } }, { passive: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
