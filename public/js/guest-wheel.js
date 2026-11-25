'use strict';
/**
 * The prize wheel on a guest's phone. The server picks the prize; this only draws the wheel and animates it
 * so the pointer (at the top) stops on the slice the server chose.
 */
(function () {
  const TAU = Math.PI * 2;
  // brand slices: [fill, text]
  const SLICES = [['#f58746', '#fff'], ['#414141', '#fff'], ['#fbd3b8', '#414141'], ['#6b6b6b', '#fff'], ['#e0662a', '#fff'], ['#f3ece3', '#414141']];
  const mod = (a, n) => ((a % n) + n) % n;

  function layout(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    return weights.map(w => { const width = total ? w / total * TAU : 0; const o = { start: acc, width }; acc += width; return o; });
  }

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let segs = [], rot = 0;

    function draw() {
      const size = canvas.clientWidth; if (!size) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size);
      const c = size / 2, R = size / 2 - 10;
      ctx.beginPath(); ctx.arc(c, c, R + 7, 0, TAU); ctx.fillStyle = '#414141'; ctx.fill();
      if (!segs.length) { ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.fillStyle = '#f3ece3'; ctx.fill(); return; }
      // with an odd number of slices the first and last would share a colour: skip one shade
      const colorAt = i => SLICES[(i === segs.length - 1 && segs.length % SLICES.length === 1 && i > 0 ? i + 1 : i) % SLICES.length];
      const lay = layout(segs.map(s => s.w));
      segs.forEach((s, i) => {
        const a0 = rot + lay[i].start;
        ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, R, a0, a0 + lay[i].width); ctx.closePath();
        ctx.fillStyle = colorAt(i)[0]; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2; ctx.stroke();
      });
      const fs = Math.max(11, Math.min(20, R * 0.09)), maxW = R * 0.6;
      ctx.font = '700 ' + fs + 'px system-ui,sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      segs.forEach((s, i) => {
        if (lay[i].width * R * 0.7 < fs * 1.1) return;
        let t = s.name;
        if (ctx.measureText(t).width > maxW) { while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); t += '…'; }
        ctx.save(); ctx.translate(c, c); ctx.rotate(rot + lay[i].start + lay[i].width / 2);
        ctx.fillStyle = colorAt(i)[1]; ctx.fillText(t, R - 14, 0); ctx.restore();
      });
    }

    /** spin to slice `winner` of `newSegs`; resolves when the wheel has stopped */
    function spinTo(newSegs, winner) {
      segs = newSegs;
      const lay = layout(segs.map(s => s.w)), from = rot;
      const jitter = (Math.random() - 0.5) * 0.7 * lay[winner].width;
      const target = -Math.PI / 2 - (lay[winner].start + lay[winner].width / 2 + jitter);
      const delta = mod(target - from, TAU) + TAU * 6;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const dur = reduce ? 1200 : 5500;
      return new Promise(done => {
        let t0 = null;
        function frame(t) {
          if (t0 === null) t0 = t;
          const p = Math.min(1, (t - t0) / dur);
          rot = from + delta * (1 - Math.pow(1 - p, 4)); draw();
          if (p < 1) requestAnimationFrame(frame); else done();
        }
        requestAnimationFrame(frame);
      });
    }

    window.addEventListener('resize', draw);
    return { set(s) { segs = s || []; draw(); }, spinTo, draw };
  }

  window.GuestWheel = { create };
})();
