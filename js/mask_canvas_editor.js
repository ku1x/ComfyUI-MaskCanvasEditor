/**
 * Mask Canvas Editor — Frontend Extension
 *
 * The node body IS the interactive canvas editor.
 * No slider widgets, no modal popups — everything happens
 * directly on the node via mouse interaction.
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

// ── Global wheel listener ──────────────────────────────────
// ComfyUI/LiteGraph doesn't consistently support onMouseWheel
// on node prototypes. We use a single global wheel listener
// on the canvas DOM element that checks all our nodes.
function setupWheelListener() {
  if (!app.canvasEl || window._mceWheelInited) return;
  window._mceWheelInited = true;

  app.canvasEl.addEventListener("wheel", (e) => {
    // Don't intercept if the user is zooming the graph (Ctrl+Wheel)
    // or if no graph exists
    if (e.ctrlKey || e.metaKey) return;
    if (!app.graph) return;

    // Graph mouse position (in node-space coordinates)
    // Note: app.canvas.graph_mouse may be undefined in some versions
    const gm = app.canvas.graph_mouse;
    if (!gm) return;

    // Check all our nodes top-down (last drawn = highest z-index ≈ last in array)
    const nodes = app.graph._nodes || [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.type !== NODE_TYPE || n.flags?.collapsed) continue;

      const nx = n.pos[0];
      const ny = n.pos[1];
      const nw = n.size[0];
      const nh = n.size[1];

      if (gm[0] >= nx && gm[0] <= nx + nw &&
          gm[1] >= ny && gm[1] <= ny + nh) {
        // Check toolbar area — ignore wheel there
        if (gm[1] >= ny + nh - 32) break;

        e.preventDefault();

        if (e.shiftKey) {
          n._state.rotation += e.deltaY > 0 ? -5 : 5;
          n._state.rotation = Math.max(-180, Math.min(180, n._state.rotation));
        } else {
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          n._state.scale = Math.max(0.01, Math.min(10, n._state.scale + delta));
          n._state.scale = Math.round(n._state.scale * 100) / 100;
        }

        // Sync to hidden widget
        const sw = n.widgets?.find((w) => w.name === "transform_state");
        if (sw) sw.value = JSON.stringify(n._state);
        if (n.graph) n.graph._version = (n.graph._version || 0) + 1;

        // Force redraw of this node
        n.setDirtyCanvas(true, true);
        return;
      }
    }
  }, { passive: false });
}

// ─────────────────────────────────────────────────────────────
//  Extension
// ─────────────────────────────────────────────────────────────
app.registerExtension({
  name: "MaskCanvasEditor.Extension",

  setup() {
    setupWheelListener();
  },

  nodeCreated(node) {
    if (node.type !== NODE_TYPE) return;

    // ── State ──────────────────────────────────────────────
    node._state = { ...DEFAULT_STATE };
    node._dragging = false;
    node._dragStart = [0, 0];
    node._dragStateStart = [0, 0];

    // ── Hidden bridge widget for serialization ─────────────
    // "transform_state" matches the Python hidden input name
    const stateWidget = node.addWidget("text", "transform_state", "{}", () => {}, {});
    stateWidget.hidden = true;
    stateWidget.serializeValue = function () {
      return JSON.stringify(node._state);
    };
    stateWidget.computeSize = () => [0, 0];
    stateWidget.draw = () => {};

    // Load saved state from workflow JSON
    const savedSerialized = stateWidget.value;
    if (savedSerialized && savedSerialized !== "{}") {
      try {
        const parsed = JSON.parse(savedSerialized);
        node._state = { ...DEFAULT_STATE, ...parsed };
      } catch (_) {}
    }

    // ── Set initial node size ─────────────────────────────
    node.size = [360, 400];
    node.minSize = [300, 320];

    const TOOLBAR_H = 32;

    // ── Sync state to hidden widget ───────────────────────
    function syncState() {
      stateWidget.value = JSON.stringify(node._state);
      if (node.graph) {
        node.graph._version = (node.graph._version || 0) + 1;
      }
    }

    // ── Drawing ─────────────────────────────────────────────
    node.onDrawForeground = function (ctx) {
      if (this.flags?.collapsed) return;

      const W = this.size[0];
      const H = this.size[1];
      const canvasH = H - TOOLBAR_H;

      if (!W || !H || canvasH <= 0) return;

      const s = this._state;
      const cx = W / 2;
      const cy = canvasH / 2;

      // ── Background ──
      ctx.fillStyle = "#11111b";
      ctx.fillRect(0, 0, W, canvasH);

      // ── Check if image and mask are connected ──
      const hasImage = this.inputs?.[1]?.link != null;
      const hasMask = this.inputs?.[0]?.link != null;

      if (!hasImage || !hasMask) {
        ctx.fillStyle = "#585b70";
        ctx.font = "14px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Connect image + mask", W / 2, canvasH / 2);
        ctx.font = "12px -apple-system, sans-serif";
        ctx.fillStyle = "#45475a";
        ctx.fillText("then interact directly on this node", W / 2, canvasH / 2 + 22);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
        this._drawToolbar(ctx, W, H, TOOLBAR_H);
        return;
      }

      // ── Compute mask window (proportional to node) ──
      const mw = Math.min(W * 0.5, canvasH * 0.5, 200);
      const mh = mw;
      const mx = cx - mw / 2;
      const my = cy - mh / 2;

      this._canvasMaskRect = { x: mx, y: my, w: mw, h: mh };

      // ── Draw the transformed grid (background image) ──
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s.scale, s.scale);
      ctx.rotate((s.rotation * Math.PI) / 180);
      if (s.flipH) ctx.scale(-1, 1);
      if (s.flipV) ctx.scale(1, -1);
      ctx.translate(s.offsetX, s.offsetY);
      this._drawGrid(ctx, W, canvasH);
      ctx.restore();

      // ── Draw mask overlay ──
      // Semi-transparent dark overlay outside mask
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, W, my);                         // top
      ctx.fillRect(0, my + mh, W, canvasH - (my + mh)); // bottom
      ctx.fillRect(0, my, mx, mh);                       // left
      ctx.fillRect(mx + mw, my, W - (mx + mw), mh);     // right

      // Mask border (dashed)
      ctx.strokeStyle = "#89b4fa";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(mx, my, mw, mh);
      ctx.setLineDash([]);

      // Corner markers
      ctx.strokeStyle = "#cba6f7";
      ctx.lineWidth = 3;
      const cl = 16;
      const c = (x1, y1, x2, y2) => {
        ctx.beginPath();
        ctx.moveTo(x1[0], x1[1]);
        ctx.lineTo(x1[0] + x2[0], x1[1] + x2[1]);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1[0], x1[1]);
        ctx.lineTo(x1[0] + y2[0], x1[1] + y2[1]);
        ctx.stroke();
      };
      c([mx, my], [cl, 0], [0, cl]);
      c([mx + mw, my], [-cl, 0], [0, cl]);
      c([mx, my + mh], [cl, 0], [0, -cl]);
      c([mx + mw, my + mh], [-cl, 0], [0, -cl]);

      // Crosshair
      ctx.strokeStyle = "rgba(203, 166, 247, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, my); ctx.lineTo(cx, my + mh);
      ctx.moveTo(mx, cy); ctx.lineTo(mx + mw, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Status text
      ctx.fillStyle = "rgba(198, 160, 246, 0.7)";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(
        `${Math.round(mw)}×${Math.round(mh)}  ` +
        `S:${s.scale.toFixed(2)}  R:${s.rotation.toFixed(0)}°` +
        (s.flipH ? "  H" : "") + (s.flipV ? "  V" : ""),
        mx + 4, my + mh + 14
      );

      // ── Draw toolbar ──
      this._drawToolbar(ctx, W, H, TOOLBAR_H);
    };

    // ── Toolbar ─────────────────────────────────────────────
    node._drawToolbar = function (ctx, W, H, toolbarH) {
      const toolY = H - toolbarH;
      ctx.fillStyle = "#181825";
      ctx.fillRect(0, toolY, W, toolbarH);
      ctx.strokeStyle = "#313244";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, toolY);
      ctx.lineTo(W, toolY);
      ctx.stroke();

      const s = this._state;
      const btnH = toolbarH - 8;
      const btnY = toolY + 4;
      const gap = 6;
      let x = gap;

      this._toolbarBtns = [];

      const drawBtn = (w, label, bg, fg, action) => {
        ctx.fillStyle = bg;
        ctx.fillRect(x, btnY, w, btnH);
        ctx.fillStyle = fg;
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + w / 2, btnY + btnH / 2);
        this._toolbarBtns.push({ x, y: btnY, w, h: btnH, action });
        x += w + gap;
      };

      drawBtn(60, "↔ H",
        s.flipH ? "#89b4fa" : "#313244",
        s.flipH ? "#1e1e2e" : "#cdd6f4",
        "flipH");
      drawBtn(60, "↕ V",
        s.flipV ? "#a6e3a1" : "#313244",
        s.flipV ? "#1e1e2e" : "#cdd6f4",
        "flipV");
      drawBtn(50, "↺ R", "#45475a", "#cdd6f4", "reset");

      // Transform info on the right
      ctx.textAlign = "right";
      ctx.fillStyle = "#6c7086";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `S:${s.scale.toFixed(2)}  R:${s.rotation.toFixed(0)}°` +
        `  X:${s.offsetX}  Y:${s.offsetY}`,
        W - 8, toolY + toolbarH / 2
      );
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    };

    // ── Grid ────────────────────────────────────────────────
    node._drawGrid = function (ctx, W, H) {
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
      for (let x = s; x <= e; x += step) ctx.moveTo(x, s), ctx.lineTo(x, e);
      for (let y = s; y <= e; y += step) ctx.moveTo(s, y), ctx.lineTo(e, y);
      ctx.stroke();

      // Center crosshair
      ctx.strokeStyle = "rgba(137, 180, 250, 0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-40, 0); ctx.lineTo(40, 0);
      ctx.moveTo(0, -40); ctx.lineTo(0, 40);
      ctx.stroke();

      ctx.fillStyle = "#89b4fa";
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    };

    // ── Mouse down ──────────────────────────────────────────
    node.onMouseDown = function (e, pos) {
      const H = this.size[1];
      const canvasH = H - TOOLBAR_H;

      // Canvas area → start drag
      if (pos[1] >= 0 && pos[1] < canvasH) {
        this._dragging = true;
        this._dragStart = [pos[0], pos[1]];
        this._dragStateStart = [this._state.offsetX, this._state.offsetY];
        return true;
      }

      // Toolbar buttons
      if (pos[1] >= canvasH && this._toolbarBtns) {
        for (const btn of this._toolbarBtns) {
          if (pos[0] >= btn.x && pos[0] <= btn.x + btn.w &&
              pos[1] >= btn.y && pos[1] <= btn.y + btn.h) {
            if (btn.action === "flipH") {
              this._state.flipH = !this._state.flipH;
            } else if (btn.action === "flipV") {
              this._state.flipV = !this._state.flipV;
            } else if (btn.action === "reset") {
              this._state = { ...DEFAULT_STATE };
            }
            syncState();
            return true;
          }
        }
      }

      return false;
    };

    // ── Mouse move ──────────────────────────────────────────
    node.onMouseMove = function (e, pos) {
      if (!this._dragging) return;
      const dx = pos[0] - this._dragStart[0];
      const dy = pos[1] - this._dragStart[1];
      const sens = 1.0 / Math.max(this._state.scale, 0.1);
      this._state.offsetX = Math.round(this._dragStateStart[0] + dx * sens);
      this._state.offsetY = Math.round(this._dragStateStart[1] + dy * sens);
      this._state.offsetX = Math.max(-8192, Math.min(8192, this._state.offsetX));
      this._state.offsetY = Math.max(-8192, Math.min(8192, this._state.offsetY));
      return true;
    };

    // ── Mouse up ────────────────────────────────────────────
    node.onMouseUp = function () {
      if (this._dragging) {
        this._dragging = false;
        syncState();
      }
    };

    // ── Cleanup ─────────────────────────────────────────────
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      if (origOnRemoved) {
        origOnRemoved.apply(this, arguments);
      }
    };
  },
});
