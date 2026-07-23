/**
 * Mask Canvas Editor — Frontend Extension
 *
 * The node body IS the interactive canvas editor.
 * No slider widgets, no modal popups — everything happens
 * directly on the node via mouse interaction.
 *
 * The actual input image is loaded from ComfyUI temp storage
 * and drawn as the canvas background with transforms applied.
 *
 * Drag to pan, scroll to zoom, shift+scroll to rotate.
 * Flip buttons and reset are drawn in a toolbar at the bottom.
 * Transform state is persisted through a hidden bridge widget.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "MaskCanvasEditor";

const DEFAULT_STATE = {
  scale: 1.0,
  rotation: 0,
  flipH: false,
  flipV: false,
  offsetX: 0,
  offsetY: 0,
};

const TOOLBAR_H = 32;

// ── Global wheel listener (once) ───────────────────────────
function setupWheelListener() {
  if (!app.canvasEl || window._mceWheelInited) return;
  window._mceWheelInited = true;

  app.canvasEl.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey || !app.graph) return;
    const gm = app.canvas.graph_mouse;
    if (!gm) return;

    const nodes = app.graph._nodes || [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.type !== NODE_TYPE || n.flags?.collapsed) continue;
      if (gm[0] < n.pos[0] || gm[0] > n.pos[0] + n.size[0] ||
          gm[1] < n.pos[1] || gm[1] > n.pos[1] + n.size[1]) continue;
      if (gm[1] >= n.pos[1] + n.size[1] - TOOLBAR_H) break;

      e.preventDefault();
      const prev = JSON.stringify(n._state);
      if (e.shiftKey) {
        n._state.rotation += e.deltaY > 0 ? -5 : 5;
        n._state.rotation = Math.max(-180, Math.min(180, n._state.rotation));
      } else {
        n._state.scale += e.deltaY > 0 ? -0.05 : 0.05;
        n._state.scale = Math.max(0.01, Math.min(10, Math.round(n._state.scale * 100) / 100));
      }
      // Only dirty if state actually changed
      const now = JSON.stringify(n._state);
      if (now !== prev) {
        const sw = n.widgets?.find((w) => w.name === "transform_state");
        if (sw) sw.value = now;
        n.graph._version = (n.graph._version || 0) + 1;
        n.setDirtyCanvas(true, true);
      }
      return;
    }
  }, { passive: false });
}

// ── Helpers ────────────────────────────────────────────────
function getStateWidget(node) {
  return node.widgets?.find((w) => w.name === "transform_state");
}

function stateChanged(node) {
  node.graph._version = (node.graph._version || 0) + 1;
  node.setDirtyCanvas(true, true);
}

// ─────────────────────────────────────────────────────────────
//  Extension
// ─────────────────────────────────────────────────────────────
app.registerExtension({
  name: "MaskCanvasEditor.Extension",

  setup() {
    setupWheelListener();
  },

  beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
    if (nodeData.name !== NODE_TYPE) return;

    // ── Prototype: onDrawForeground ────────────────────────
    const origOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origOnDrawForeground?.apply(this, arguments);
      if (this.flags?.collapsed) return;

      const W = this.size[0];
      const H = this.size[1];
      const canvasH = Math.max(0, H - TOOLBAR_H);
      if (!W || !H || canvasH <= 0) return;

      const s = this.__mce_state || DEFAULT_STATE;
      const cx = W / 2;
      const cy = canvasH / 2;

      // ── Background fill ──
      ctx.fillStyle = "#11111b";
      ctx.fillRect(0, 0, W, canvasH);

      // ── Check connections ──
      const hasImage = this.inputs?.[1]?.link != null;
      const hasMask = this.inputs?.[0]?.link != null;

      if (!hasImage || !hasMask) {
        ctx.fillStyle = "#585b70";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Connect image + mask", W / 2, canvasH / 2 - 8);
        ctx.fillStyle = "#45475a";
        ctx.font = "12px sans-serif";
        ctx.fillText("then queue the workflow", W / 2, canvasH / 2 + 16);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        drawToolbar(this, ctx, W, H);
        return;
      }

      // ── Mask window ──
      const mw = Math.min(W * 0.5, canvasH * 0.5, 200);
      const mh = mw;
      const mx = cx - mw / 2;
      const my = cy - mh / 2;

      this.__mce_maskRect = { x: mx, y: my, w: mw, h: mh };

      // ── Draw the transformed background ──
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s.scale, s.scale);
      ctx.rotate((s.rotation * Math.PI) / 180);
      if (s.flipH) ctx.scale(-1, 1);
      if (s.flipV) ctx.scale(1, -1);
      ctx.translate(s.offsetX, s.offsetY);

      if (this.__mce_img && this.__mce_img.complete && this.__mce_img.naturalWidth > 0) {
        ctx.drawImage(
          this.__mce_img,
          -this.__mce_imgW / 2, -this.__mce_imgH / 2,
          this.__mce_imgW, this.__mce_imgH,
        );
        // Image border
        ctx.strokeStyle = "rgba(203, 166, 247, 0.2)";
        ctx.lineWidth = 1;
        ctx.strokeRect(
          -this.__mce_imgW / 2, -this.__mce_imgH / 2,
          this.__mce_imgW, this.__mce_imgH,
        );
      } else {
        drawGrid(ctx, W, canvasH);
      }
      ctx.restore();

      // ── Mask overlay ──
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, W, my);
      ctx.fillRect(0, my + mh, W, canvasH - (my + mh));
      ctx.fillRect(0, my, mx, mh);
      ctx.fillRect(mx + mw, my, W - (mx + mw), mh);

      // ── Mask border ──
      ctx.strokeStyle = "#89b4fa";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(mx, my, mw, mh);
      ctx.setLineDash([]);

      // ── Corner markers ──
      ctx.strokeStyle = "#cba6f7";
      ctx.lineWidth = 3;
      const cl = 16;
      const corner = (x, y, dx1, dy1, dx2, dy2) => {
        ctx.beginPath();
        ctx.moveTo(x + dx1, y + dy1); ctx.lineTo(x, y); ctx.lineTo(x + dx2, y + dy2);
        ctx.stroke();
      };
      corner(mx, my, cl, 0, 0, cl);
      corner(mx + mw, my, -cl, 0, 0, cl);
      corner(mx, my + mh, cl, 0, 0, -cl);
      corner(mx + mw, my + mh, -cl, 0, 0, -cl);

      // ── Crosshair ──
      ctx.strokeStyle = "rgba(203, 166, 247, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, my); ctx.lineTo(cx, my + mh);
      ctx.moveTo(mx, cy); ctx.lineTo(mx + mw, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Info text inside mask area ──
      ctx.fillStyle = "rgba(198, 160, 246, 0.7)";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      const infoParts = [
        `${Math.round(mw)}×${Math.round(mh)}`,
      ];
      if (this.__mce_img && this.__mce_img.complete && this.__mce_img.naturalWidth > 0) {
        infoParts.push(`${this.__mce_imgW}×${this.__mce_imgH}`);
      }
      infoParts.push(`S:${s.scale.toFixed(2)}`);
      infoParts.push(`R:${s.rotation.toFixed(0)}°`);
      if (s.flipH) infoParts.push("H");
      if (s.flipV) infoParts.push("V");
      ctx.fillText(infoParts.join("  "), mx + 4, my + mh + 14);

      // ── Toolbar ──
      drawToolbar(this, ctx, W, H);
    };

    // ── Prototype: onMouseDown ─────────────────────────────
    const origOnMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      if (origOnMouseDown?.apply(this, arguments)) return true;
      const H = this.size[1];
      const canvasH = Math.max(0, H - TOOLBAR_H);

      if (pos[1] >= 0 && pos[1] < canvasH) {
        this.__mce_dragging = true;
        this.__mce_dragStart = [pos[0], pos[1]];
        this.__mce_dragOffStart = [
          this.__mce_state?.offsetX || 0,
          this.__mce_state?.offsetY || 0,
        ];
        return true;
      }

      if (this.__mce_toolbarBtns) {
        for (const btn of this.__mce_toolbarBtns) {
          if (pos[0] >= btn.x && pos[0] <= btn.x + btn.w &&
              pos[1] >= btn.y && pos[1] <= btn.y + btn.h) {
            if (btn.action === "flipH") this.__mce_state.flipH = !this.__mce_state.flipH;
            else if (btn.action === "flipV") this.__mce_state.flipV = !this.__mce_state.flipV;
            else if (btn.action === "reset") {
              this.__mce_state = { ...DEFAULT_STATE };
              // Also reset the stored preview state when resetting
            }
            const sw = getStateWidget(this);
            if (sw) sw.value = JSON.stringify(this.__mce_state);
            stateChanged(this);
            return true;
          }
        }
      }
      return false;
    };

    // ── Prototype: onMouseMove ─────────────────────────────
    const origOnMouseMove = nodeType.prototype.onMouseMove;
    nodeType.prototype.onMouseMove = function (e, pos) {
      if (!this.__mce_dragging) return origOnMouseMove?.apply(this, arguments);
      const dx = pos[0] - this.__mce_dragStart[0];
      const dy = pos[1] - this.__mce_dragStart[1];
      const sens = 1.0 / Math.max(this.__mce_state.scale, 0.1);
      this.__mce_state.offsetX = Math.round(this.__mce_dragOffStart[0] + dx * sens);
      this.__mce_state.offsetY = Math.round(this.__mce_dragOffStart[1] + dy * sens);
      this.__mce_state.offsetX = Math.max(-8192, Math.min(8192, this.__mce_state.offsetX));
      this.__mce_state.offsetY = Math.max(-8192, Math.min(8192, this.__mce_state.offsetY));
      return true;
    };

    // ── Prototype: onMouseUp ───────────────────────────────
    const origOnMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function () {
      if (this.__mce_dragging) {
        this.__mce_dragging = false;
        const sw = getStateWidget(this);
        if (sw) sw.value = JSON.stringify(this.__mce_state);
        stateChanged(this);
        return true;
      }
      return origOnMouseUp?.apply(this, arguments);
    };

    // ── Prototype: onRemoved ───────────────────────────────
    const origOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__mce_img = null;
      origOnRemoved?.apply(this, arguments);
    };
  },

  nodeCreated(node) {
    if (node.type !== NODE_TYPE) return;

    // ── Init state ──
    node.__mce_state = { ...DEFAULT_STATE };
    node.__mce_img = null;
    node.__mce_imgW = 0;
    node.__mce_imgH = 0;

    // ── Hidden bridge widget for serialization ─────────────
    const sw = node.addWidget("text", "transform_state", "{}", () => {}, {});
    sw.hidden = true;
    sw.computeSize = () => [0, 0];
    sw.draw = () => {};
    sw.serializeValue = () => JSON.stringify(node.__mce_state);

    // Restore saved state from workflow JSON
    try {
      const v = sw.value;
      if (v && v !== "{}") {
        const parsed = JSON.parse(v);
        node.__mce_state = { ...DEFAULT_STATE, ...parsed };
      }
    } catch (_) {}

    // ── Node size ──
    node.size = [360, 420];
    node.minSize = [300, 320];

    // ── onExecuted: receive preview image from Python ──────
    node.onExecuted = function (message) {
      const preview = message?.mce_preview?.[0];
      if (!preview) return;
      const url = `/view?filename=${preview.filename}&subfolder=${preview.subfolder || ""}&type=${preview.type || "temp"}&t=${Date.now()}`;
      if (url === this.__mce_previewUrl) return;
      this.__mce_previewUrl = url;

      const img = new Image();
      img.onload = () => {
        this.__mce_img = img;
        this.__mce_imgW = img.naturalWidth;
        this.__mce_imgH = img.naturalHeight;
        this.setDirtyCanvas(true, true);
      };
      img.onerror = () => {};
      img.src = url;
    };
  },
});

// ── Toolbar drawing (standalone function) ─────────────────
function drawToolbar(node, ctx, W, H) {
  const toolY = H - TOOLBAR_H;
  ctx.fillStyle = "#181825";
  ctx.fillRect(0, toolY, W, TOOLBAR_H);
  ctx.strokeStyle = "#313244";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, toolY);
  ctx.lineTo(W, toolY);
  ctx.stroke();

  const s = node.__mce_state || DEFAULT_STATE;
  const btns = [];
  const btnH = TOOLBAR_H - 8;
  const btnY = toolY + 4;
  let x = 6;

  const addBtn = (w, label, bg, fg, action) => {
    ctx.fillStyle = bg;
    ctx.fillRect(x, btnY, w, btnH);
    ctx.fillStyle = fg;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, btnY + btnH / 2);
    btns.push({ x, y: btnY, w, h: btnH, action });
    x += w + 6;
  };

  addBtn(60, "↔ H",
    s.flipH ? "#89b4fa" : "#313244",
    s.flipH ? "#1e1e2e" : "#cdd6f4",
    "flipH");
  addBtn(60, "↕ V",
    s.flipV ? "#a6e3a1" : "#313244",
    s.flipV ? "#1e1e2e" : "#cdd6f4",
    "flipV");
  addBtn(50, "↺ R", "#45475a", "#cdd6f4", "reset");

  node.__mce_toolbarBtns = btns;

  ctx.textAlign = "right";
  ctx.fillStyle = "#6c7086";
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `S:${s.scale.toFixed(2)}  R:${s.rotation.toFixed(0)}°` +
    `  X:${s.offsetX}  Y:${s.offsetY}`,
    W - 8, toolY + TOOLBAR_H / 2
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ── Grid drawing (standalone function) ────────────────────
function drawGrid(ctx, W, H) {
  const ext = Math.max(W, H) * 2;
  const step = 64;
  const s = -ext;
  const e = ext;

  for (let y = s; y < e; y += step) {
    for (let x = s; x < e; x += step) {
      const parity = ((Math.floor(x / step) + Math.floor(y / step)) & 1) === 0;
      ctx.fillStyle = parity ? "#2a2a3a" : "#1e1e2e";
      ctx.fillRect(x, y, step, step);
    }
  }

  ctx.strokeStyle = "rgba(137, 180, 250, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = s; x <= e; x += step) { ctx.moveTo(x, s); ctx.lineTo(x, e); }
  for (let y = s; y <= e; y += step) { ctx.moveTo(s, y); ctx.lineTo(e, y); }
  ctx.stroke();

  ctx.strokeStyle = "rgba(137, 180, 250, 0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(40, 0);
  ctx.moveTo(0, -40); ctx.lineTo(0, 40);
  ctx.stroke();

  ctx.fillStyle = "#89b4fa";
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(137, 180, 250, 0.6)";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Queue workflow to load preview", 0, -18);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}
