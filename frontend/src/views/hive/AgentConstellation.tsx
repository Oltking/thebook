import { useEffect, useRef } from 'react';

export interface HiveNode {
  label: string;
  color: string;
  live: boolean;
  weight: number; // 0..1, drives orbit radius + size
}

/**
 * The living hive canvas. Nodes (agents) orbit the central hub (thebook), pulse
 * while alive, and fire particles along links when they act or talk to each
 * other. Purely presentational; it takes real node data and animates it.
 */
export function AgentConstellation({ nodes }: { nodes: HiveNode[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<HiveNode[]>(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0, H = 0, DPR = 1;
    let hub = { x: 0, y: 0, r: 15 };
    let orbits: { base: number; d: number; ph: number; speed: number; r: number }[] = [];
    let pulses: { src: number; to: number; t: number; a2a: boolean }[] = [];
    // Ambient energy: faint drifting motes so the field feels alive even with no
    // agents yet. Not labelled entities, just the hum of the hive.
    let motes: { ang: number; rad: number; sp: number; sz: number; c: string }[] = [];

    const rebuild = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      // Hub sits right-of-centre so the headline breathes on the left.
      hub = { x: W * 0.72, y: H * 0.46, r: 15 };
      const n = nodesRef.current;
      orbits = n.map((node, i) => ({
        base: (i / Math.max(1, n.length)) * Math.PI * 2 + i * 0.7,
        d: 0.18 + node.weight * 0.2,
        ph: Math.random() * 6.28,
        speed: reduce ? 0 : (0.05 + Math.random() * 0.04) * (i % 2 ? 1 : -1),
        r: 4 + node.weight * 5,
      }));
      pulses = [];
      const R = Math.min(W, H);
      const cols = ['rgba(29,185,84,', 'rgba(154,120,75,', 'rgba(139,148,139,'];
      motes = Array.from({ length: 26 }, () => ({
        ang: Math.random() * 6.28,
        rad: R * (0.12 + Math.random() * 0.55),
        sp: (reduce ? 0 : 1) * (0.02 + Math.random() * 0.06) * (Math.random() < 0.5 ? 1 : -1),
        sz: 0.6 + Math.random() * 1.6,
        c: cols[Math.floor(Math.random() * cols.length)],
      }));
    };

    const posOf = (i: number, t: number) => {
      const o = orbits[i];
      const ang = o.base + t * o.speed;
      const R = Math.min(W, H) * o.d;
      return { x: hub.x + Math.cos(ang) * R * 1.35, y: hub.y + Math.sin(ang) * R };
    };

    let last = 0, acc = 0, T = 0, raf = 0;

    const frame = (ts: number) => {
      const dt = Math.min((ts - last) / 1000 || 0, 0.05); last = ts; T += dt;
      const n = nodesRef.current;
      ctx.clearRect(0, 0, W, H);

      // ambient motes drifting around the hub
      for (const m of motes) {
        m.ang += m.sp * dt;
        const mx = hub.x + Math.cos(m.ang) * m.rad;
        const my = hub.y + Math.sin(m.ang) * m.rad * 0.82;
        const tw = 0.25 + (Math.sin(T * 1.5 + m.rad) * 0.5 + 0.5) * 0.4;
        ctx.fillStyle = m.c + tw.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(mx, my, m.sz, 0, 6.28); ctx.fill();
      }

      // spokes hub -> node
      for (let i = 0; i < n.length; i++) {
        const p = posOf(i, T);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      // a couple of A2A chords between adjacent nodes
      for (let i = 0; i + 1 < n.length; i += 2) {
        const p1 = posOf(i, T), p2 = posOf(i + 1, T);
        ctx.strokeStyle = 'rgba(154,120,75,0.14)';
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }

      // hub glow + core
      const hg = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, 58);
      hg.addColorStop(0, 'rgba(29,185,84,0.42)'); hg.addColorStop(1, 'rgba(29,185,84,0)');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hub.x, hub.y, 58, 0, 6.28); ctx.fill();
      // hexagon hub
      ctx.fillStyle = '#EAF0F2';
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k - Math.PI / 6;
        const px = hub.x + Math.cos(a) * hub.r, py = hub.y + Math.sin(a) * hub.r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(234,240,242,0.45)';
      ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('thebook', hub.x, hub.y + 32);

      // travelling pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        const pu = pulses[i]; pu.t += dt * 0.9;
        const from = posOf(pu.src, T);
        const to = pu.a2a ? posOf(pu.to, T) : hub;
        const px = from.x + (to.x - from.x) * pu.t, py = from.y + (to.y - from.y) * pu.t;
        ctx.fillStyle = pu.a2a ? '#9A784B' : '#1DB954';
        ctx.shadowBlur = 12; ctx.shadowColor = ctx.fillStyle;
        ctx.beginPath(); ctx.arc(px, py, 3, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
        if (pu.t >= 1) pulses.splice(i, 1);
      }

      // nodes
      for (let i = 0; i < n.length; i++) {
        const node = n[i]; const p = posOf(i, T);
        const beat = node.live ? 1 + Math.sin(T * 2 + orbits[i].ph) * 0.16 : 1;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 24);
        g.addColorStop(0, node.color + (node.live ? '88' : '44')); g.addColorStop(1, node.color + '00');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, 24, 0, 6.28); ctx.fill();
        ctx.fillStyle = node.color;
        if (node.live) { ctx.shadowBlur = 14; ctx.shadowColor = node.color; }
        ctx.beginPath(); ctx.arc(p.x, p.y, orbits[i].r * beat, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(234,240,242,0.7)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(node.label, p.x, p.y + orbits[i].r + 12);
      }

      acc += dt;
      if (!reduce && acc > 1.1 && n.length > 0) {
        acc = 0;
        const src = Math.floor(Math.random() * n.length);
        const a2a = n.length > 1 && Math.random() < 0.4;
        let to = src; if (a2a) { to = (src + 1) % n.length; }
        pulses.push({ src, to, t: 0, a2a });
      }
      raf = requestAnimationFrame(frame);
    };

    rebuild();
    const onResize = () => rebuild();
    window.addEventListener('resize', onResize);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}
