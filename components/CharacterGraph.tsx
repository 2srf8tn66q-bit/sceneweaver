"use client";

// 人物关系图谱：Canvas 力导向图。悬停高亮关联人物 + tooltip，可拖拽/缩放。
// 物理引擎会冷却休眠（空闲不耗 CPU）。移植自 Claude design 的 HTML 原型。

import { useEffect, useRef } from "react";
import { buildRelations } from "@/lib/screenplay/relationships";
import type { Screenplay, Character } from "@/lib/screenplay/types";

interface Props {
  screenplay: Screenplay;
  onClose: () => void;
}

const ROLE: Record<string, { r: number; color: string }> = {
  protagonist: { r: 26, color: "#C0974A" },
  supporting: { r: 18, color: "#9C9486" },
  minor: { r: 13, color: "#6B6657" },
};

const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
function hexToRgb(hex: string) {
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

interface GNode {
  id: string; name: string; aliases: string[]; description: string;
  role: string; r: number; color: string;
  x: number; y: number; vx: number; vy: number; appear: number;
}

export default function CharacterGraph({ screenplay, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const container = canvas.parentElement!;
    const tip = tipRef.current!;
    const ctx = canvas.getContext("2d")!;

    const { appeared, edges: relEdges } = buildRelations(screenplay);
    const characters: Character[] = screenplay.characters.filter((c) => appeared.has(c.id));

    const nodes: GNode[] = characters.map((c) => {
      const role = ROLE[c.role ?? "minor"] || ROLE.minor;
      return {
        id: c.id, name: c.name, aliases: c.aliases ?? [], description: c.description ?? "",
        role: c.role ?? "minor", r: role.r, color: role.color,
        x: 0, y: 0, vx: 0, vy: 0, appear: 0,
      };
    });
    const nodeMap: Record<string, GNode> = {};
    nodes.forEach((n) => { nodeMap[n.id] = n; });
    const edges = relEdges.filter((e) => nodeMap[e.source] && nodeMap[e.target]);
    const adj: Record<string, Set<string>> = {};
    nodes.forEach((n) => { adj[n.id] = new Set(); });
    edges.forEach((e) => { adj[e.source]?.add(e.target); adj[e.target]?.add(e.source); });

    const S = {
      w: 0, h: 0, dpr: window.devicePixelRatio || 1,
      view: { scale: 1, x: 0, y: 0 },
      alpha: 1, t0: performance.now(), pulse: 0, pulseT: 0,
      hoverId: null as string | null, reveal: 0,
      drag: null as GNode | null, dragMoved: false,
      pan: null as { sx: number; sy: number; vx: number; vy: number } | null,
      raf: null as number | null, dirty: true,
    };

    function initLayout() {
      const cx = S.w / 2, cy = S.h / 2;
      const spread = Math.min(S.w, S.h) * 0.26;
      nodes.forEach((n, i) => {
        const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        n.x = cx + Math.cos(a) * spread + (Math.random() - 0.5) * 30;
        n.y = cy + Math.sin(a) * spread + (Math.random() - 0.5) * 30;
        n.vx = 0; n.vy = 0;
      });
      S.alpha = 1;
    }

    function tick() {
      const cx = S.w / 2, cy = S.h / 2;
      const springLen = 150, springK = 0.005, repulsion = 9000, centerK = 0.0022, damping = 0.86;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = repulsion / (d * d);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      edges.forEach((e) => {
        const a = nodeMap[e.source], b = nodeMap[e.target];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const disp = d - springLen;
        const f = disp * springK * e.weight;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      });
      let maxV = 0;
      nodes.forEach((n) => {
        if (n === S.drag) return;
        n.vx += (cx - n.x) * centerK; n.vy += (cy - n.y) * centerK;
        n.vx *= damping; n.vy *= damping;
        n.x += n.vx * S.alpha; n.y += n.vy * S.alpha;
        maxV = Math.max(maxV, Math.abs(n.vx) + Math.abs(n.vy));
      });
      S.alpha *= 0.97;
      if (S.alpha < 0.008 || maxV < 0.05) S.alpha = 0;
    }

    const toWorld = (sx: number, sy: number) => ({ x: (sx - S.view.x) / S.view.scale, y: (sy - S.view.y) / S.view.scale });

    function draw() {
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      ctx.clearRect(0, 0, S.w, S.h);
      ctx.save();
      ctx.translate(S.view.x, S.view.y);
      ctx.scale(S.view.scale, S.view.scale);

      const hov = S.hoverId;
      const connected = hov ? adj[hov] : null;
      const pulseScale = 1 + S.pulse * 0.12;

      edges.forEach((e) => {
        const a = nodeMap[e.source], b = nodeMap[e.target];
        if (!a || !b) return;
        const incident = e.source === hov || e.target === hov;
        const showFade = Math.min(Math.max(0, a.appear), Math.max(0, b.appear));
        let al, color, lw;
        if (!hov) {
          al = (0.1 + e.weight * 0.03) * showFade; color = "180,176,166";
          lw = (0.7 + e.weight * 0.35) / S.view.scale;
        } else if (incident) {
          al = (0.4 + e.weight * 0.08) * showFade; color = "192,151,74";
          lw = (0.9 + e.weight * 0.5) / S.view.scale;
        } else {
          al = 0.05 * showFade; color = "180,176,166"; lw = 0.7 / S.view.scale;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(${color},${al})`;
        ctx.lineWidth = lw; ctx.stroke();
        if (incident && e.label) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.font = `${12 / S.view.scale}px "PingFang SC", sans-serif`;
          ctx.fillStyle = `rgba(214,184,122,${S.reveal})`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(e.label, mx, my - 9 / S.view.scale);
        }
      });

      nodes.forEach((n) => {
        const ap = easeOutBack(Math.max(0, Math.min(1, n.appear)));
        if (ap <= 0) return;
        const isHov = n.id === hov;
        const isCon = connected?.has(n.id);
        const dim = hov && !isHov && !isCon;
        const r = n.r * ap * pulseScale;
        if (isHov || isCon) {
          const gR = r + (isHov ? 20 : 11);
          const g = ctx.createRadialGradient(n.x, n.y, r * 0.6, n.x, n.y, gR);
          const gc = isHov ? "192,151,74" : hexToRgb(n.color);
          g.addColorStop(0, `rgba(${gc},${isHov ? 0.3 : 0.16})`);
          g.addColorStop(1, `rgba(${gc},0)`);
          ctx.beginPath(); ctx.arc(n.x, n.y, gR, 0, Math.PI * 2);
          ctx.fillStyle = g; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? "#C0974A" : n.color;
        ctx.globalAlpha = dim ? 0.18 : 1; ctx.fill();
        if (isHov) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(214,184,122,0.55)";
          ctx.lineWidth = 2 / S.view.scale; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const fs = n.role === "minor" ? 12.5 : 13.5;
        ctx.font = `${isHov ? 600 : 400} ${fs / S.view.scale}px "PingFang SC", sans-serif`;
        ctx.fillStyle = dim ? "rgba(237,237,237,0.18)" : isHov ? "#fff" : "rgba(237,237,237,0.9)";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.globalAlpha = ap;
        ctx.fillText(n.name, n.x, n.y + r + 15 / S.view.scale);
        ctx.globalAlpha = 1;
      });
      ctx.restore();
    }

    function frameActive() {
      const entranceDone = nodes.every((n) => n.appear >= 1);
      return S.alpha > 0 || !entranceDone || S.pulse > 0.001 ||
        Math.abs(S.reveal - (S.hoverId ? 1 : 0)) > 0.01 || S.drag || S.pan;
    }
    function loop(now: number) {
      const elapsed = now - S.t0;
      nodes.forEach((n, i) => {
        const local = (elapsed - i * 70) / 520;
        n.appear = Math.max(0, Math.min(1, local));
      });
      if (S.pulse > 0.001) {
        S.pulseT += 16;
        S.pulse = Math.max(0, 1 - S.pulseT / 380) * Math.sin(Math.min(1, S.pulseT / 380) * Math.PI);
      }
      const target = S.hoverId ? 1 : 0;
      S.reveal += (target - S.reveal) * 0.25;
      if (Math.abs(S.reveal - target) < 0.01) S.reveal = target;
      if (S.alpha > 0) tick();
      draw();
      if (frameActive() || S.dirty) { S.dirty = false; S.raf = requestAnimationFrame(loop); }
      else S.raf = null;
    }
    function wake() { if (!S.raf) S.raf = requestAnimationFrame(loop); }

    function findNode(sx: number, sy: number) {
      const w = toWorld(sx, sy);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = w.x - n.x, dy = w.y - n.y;
        const rr = n.r + 8;
        if (dx * dx + dy * dy <= rr * rr) return n;
      }
      return null;
    }
    function showTip(n: GNode | null, clientX: number, clientY: number) {
      if (!n) { tip.style.display = "none"; return; }
      tip.style.display = "block";
      tip.style.left = clientX + 16 + "px";
      tip.style.top = clientY - 8 + "px";
      const al = n.aliases.length ? `<span style="font-weight:400;font-size:12px;color:rgba(255,255,255,.4);margin-left:6px">${n.aliases.join(" / ")}</span>` : "";
      const conn = adj[n.id]?.size || 0;
      tip.innerHTML =
        `<div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:4px">${n.name}${al}</div>` +
        (n.description ? `<div style="font-size:12px;color:rgba(255,255,255,.55);line-height:1.55">${n.description}</div>` : "") +
        (conn ? `<div style="font-size:11px;color:#C0974A;margin-top:6px">关联 ${conn} 人</div>` : "");
    }

    function onMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (S.drag) {
        const w = toWorld(sx, sy);
        S.drag.x = w.x; S.drag.y = w.y; S.drag.vx = 0; S.drag.vy = 0;
        S.dragMoved = true; S.dirty = true; wake(); return;
      }
      if (S.pan) {
        S.view.x = S.pan.vx + (e.clientX - S.pan.sx);
        S.view.y = S.pan.vy + (e.clientY - S.pan.sy);
        S.dirty = true; wake(); return;
      }
      const hit = findNode(sx, sy);
      const id = hit?.id ?? null;
      if (id !== S.hoverId) { S.hoverId = id; S.dirty = true; wake(); }
      if (hit) { canvas.style.cursor = "grab"; showTip(hit, e.clientX, e.clientY); }
      else { canvas.style.cursor = "default"; tip.style.display = "none"; }
    }
    function onDown(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const hit = findNode(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) { S.drag = hit; S.dragMoved = false; canvas.style.cursor = "grabbing"; tip.style.display = "none"; }
      else { S.pan = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y }; canvas.style.cursor = "grabbing"; }
      wake();
    }
    function onUp() {
      if (S.drag) S.alpha = Math.max(S.alpha, 0.25);
      S.drag = null; S.pan = null; canvas.style.cursor = "default"; wake();
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      S.view.scale = Math.max(0.4, Math.min(2.6, S.view.scale * factor));
      const after = toWorld(sx, sy);
      S.view.x += (after.x - before.x) * S.view.scale;
      S.view.y += (after.y - before.y) * S.view.scale;
      S.pulse = 1; S.pulseT = 0; S.dirty = true; wake();
    }
    function onLeave() {
      S.hoverId = null; S.drag = null; S.pan = null;
      tip.style.display = "none"; S.dirty = true; wake();
    }

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mouseleave", onLeave);

    function resize() {
      const rect = container.getBoundingClientRect();
      S.dpr = window.devicePixelRatio || 1;
      S.w = rect.width; S.h = rect.height;
      canvas.width = S.w * S.dpr; canvas.height = S.h * S.dpr;
      canvas.style.width = S.w + "px"; canvas.style.height = S.h + "px";
      if (nodes[0] && nodes[0].x === 0 && nodes[0].y === 0) initLayout();
      else S.alpha = Math.max(S.alpha, 0.4);
      S.dirty = true; wake();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    wake();

    return () => {
      if (S.raf) cancelAnimationFrame(S.raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mouseleave", onLeave);
      tip.style.display = "none";
    };
  }, [screenplay]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#111110", color: "#ededed" }}>
      <header className="flex items-center justify-between border-b px-5 py-3 text-sm" style={{ borderColor: "rgba(255,255,255,.06)" }}>
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-white/40 hover:text-white">← 返回工作台</button>
          <span className="h-[15px] w-px" style={{ background: "rgba(255,255,255,.1)" }} />
          <span className="font-medium">{screenplay.meta.title}</span>
          <span className="text-xs text-white/30">人物图谱</span>
        </div>
        <span className="hidden text-xs text-white/25 sm:inline">悬停查看关系 · 拖拽节点 · 滚轮缩放</span>
      </header>
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full" />
        <div className="absolute bottom-4 left-5 flex gap-4 text-[11.5px] text-white/35">
          <span><i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-full align-middle" style={{ background: "#C0974A" }} />主角</span>
          <span><i className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-middle" style={{ background: "#9C9486" }} />配角</span>
          <span><i className="mr-1.5 inline-block h-[6px] w-[6px] rounded-full align-middle" style={{ background: "#6B6657" }} />次要</span>
        </div>
      </div>
      <div ref={tipRef} style={{ position: "fixed", display: "none", pointerEvents: "none", zIndex: 100, background: "rgba(24,24,22,0.96)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 15px", maxWidth: 230, boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }} />
    </div>
  );
}
