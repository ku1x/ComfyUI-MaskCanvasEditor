/**
 * Mask Canvas Editor — Frontend Extension
 *
 * Compact node with a floating DOM-based canvas editor panel.
 * Inspired by ComfyUI-ZhiHui's drawing board pattern:
 * - Node body is small (240×80), shows a button + thumbnail
 * - Floating window with full interactive canvas opens on click
 * - Drag to pan, scroll to zoom, shift+scroll to rotate
 * - Flip/reset toolbar, Apply button writes state back
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

const PANEL_W = 800;
const PANEL_H = 560;
const CANVAS_W = 960;
const CANVAS_H = 540;

// ─────────────────────────────────────────────────────────────
//  Extension
// ─────────────────────────────────────────────────────────────
app.registerExtension({
  name: "MaskCanvasEditor.Extension",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    // ── onNodeCreated ──────────────────────────────────────
    const origOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);
      this.size = [240, 80];
      this.__mce_state = { ...DEFAULT_STATE };
      this.__mce_img = null;
      this.__mce_imgW = 0;
      this.__mce_imgH = 0;

      // Hidden bridge widget for transform_state
      const sw = this.addWidget("text", "transform_state", "{}", () => {}, {});
      sw.hidden = true;
      sw.computeSize = () => [0, -4];
      sw.draw = () => {};
      sw.serializeValue = () => JSON.stringify(this.__mce_state);

      // Restore saved state
      try {
        const v = sw.value;
        if (v && v !== "{}") {
          this.__mce_state = { ...DEFAULT_STATE, ...JSON.parse(v) };
        }
      } catch (_) {}

      // Add the open button widget
      this.addWidget("button", "🎨 Open Canvas Editor", null, () => {
        this._openEditor();
      });

      // Node size hint at bottom
      this.onResize?.(this.size);
    };

    // ── onConfigure (restore state from workflow JSON) ────
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      origConfigure?.apply(this, arguments);
      const sw = this.widgets?.find((w) => w.name === "transform_state");
      if (sw && sw.value && sw.value !== "{}") {
        try {
          this.__mce_state = { ...DEFAULT_STATE, ...JSON.parse(sw.value) };
        } catch (_) {}
      }
    };

    // ── onDrawForeground (tiny thumbnail preview) ──────────
    const origFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origFg?.apply(this, arguments);
      if (this.flags?.collapsed) return;

      // Draw a small thumbnail if we have a preview image
      if (this.__mce_img && this.__mce_img.complete && this.__mce_img.naturalWidth > 0) {
        const W = this.size[0];
        const H = this.size[1];
        const thumbH = H - 38; // leave room for button widget
        if (thumbH > 20) {
          ctx.save();
          // Clip to rounded rect
          const r = 4;
          ctx.beginPath();
          ctx.moveTo(r, 20); ctx.lineTo(W - r, 20);
          ctx.quadraticCurveTo(W, 20, W, 20 + r);
          ctx.lineTo(W, 20 + thumbH - r);
          ctx.quadraticCurveTo(W, 20 + thumbH, W - r, 20 + thumbH);
          ctx.lineTo(r, 20 + thumbH);
          ctx.quadraticCurveTo(0, 20 + thumbH, 0, 20 + thumbH - r);
          ctx.lineTo(0, 20 + r);
          ctx.quadraticCurveTo(0, 20, r, 20);
          ctx.closePath();
          ctx.clip();

          // Draw image scaled to fit
          const iw = this.__mce_imgW;
          const ih = this.__mce_imgH;
          const scale = Math.min(W / iw, thumbH / ih, 1);
          const dw = iw * scale;
          const dh = ih * scale;
          const dx = (W - dw) / 2;
          const dy = 20 + (thumbH - dh) / 2;

          ctx.fillStyle = "#11111b";
          ctx.fillRect(0, 20, W, thumbH);
          ctx.drawImage(this.__mce_img, dx, dy, dw, dh);

          ctx.restore();
        }
      }
    };

    // ── onExecuted ─────────────────────────────────────────
    const origExec = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExec?.apply(this, arguments);
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
      img.src = url;
    };

    // ── Floating Editor Panel ──────────────────────────────
    nodeType.prototype._openEditor = function () {
      if (this.__mce_panel && document.body.contains(this.__mce_panel)) {
        this.__mce_panel.style.zIndex = 10000;
        return;
      }

      const self = this;
      const img = this.__mce_img;
      const state = this.__mce_state;

      // ── Create the floating panel ──
      const panel = document.createElement("div");
      panel.id = `mce-panel-${this.id}`;
      panel.style.cssText = `
        position:fixed; top:60px; left:60px; z-index:9998;
        background:#1e1e2e; border-radius:12px; overflow:hidden;
        display:flex; flex-direction:column;
        width:min(${PANEL_W}px,90vw); height:min(${PANEL_H}px,85vh);
        box-shadow:0 24px 80px rgba(0,0,0,.6);
        border:1px solid rgba(69,71,90,.3);
        resize:both;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        color:#cdd6f4;
      `;
      this.__mce_panel = panel;

      // ── Header ──
      const header = document.createElement("div");
      header.style.cssText = `
        display:flex; align-items:center; gap:10px;
        padding:10px 14px; background:#181825;
        border-bottom:1px solid #313244; flex-shrink:0; flex-wrap:wrap;
        cursor:move;
      `;

      const title = document.createElement("span");
      title.textContent = "🎨 Mask Canvas Editor";
      title.style.cssText = "font-weight:700;font-size:15px;color:#cdd6f4;margin-right:8px;";
      header.appendChild(title);

      // Flip buttons
      const flipHBtn = document.createElement("button");
      flipHBtn.textContent = state.flipH ? "↔ H  ✓" : "↔ H";
      flipHBtn.style.cssText = btnStyle(state.flipH ? "#89b4fa" : "#313244", state.flipH ? "#1e1e2e" : "#cdd6f4");
      flipHBtn.onclick = () => { state.flipH = !state.flipH; flipHBtn.textContent = state.flipH ? "↔ H  ✓" : "↔ H"; updateBtnStyle(flipHBtn, state.flipH ? "#89b4fa" : "#313244", state.flipH ? "#1e1e2e" : "#cdd6f4"); renderPanelCanvas(); };
      header.appendChild(flipHBtn);

      const flipVBtn = document.createElement("button");
      flipVBtn.textContent = state.flipV ? "↕ V  ✓" : "↕ V";
      flipVBtn.style.cssText = btnStyle(state.flipV ? "#a6e3a1" : "#313244", state.flipV ? "#1e1e2e" : "#cdd6f4");
      flipVBtn.onclick = () => { state.flipV = !state.flipV; flipVBtn.textContent = state.flipV ? "↕ V  ✓" : "↕ V"; updateBtnStyle(flipVBtn, state.flipV ? "#a6e3a1" : "#313244", state.flipV ? "#1e1e2e" : "#cdd6f4"); renderPanelCanvas(); };
      header.appendChild(flipVBtn);

      // Reset button
      const resetBtn = document.createElement("button");
      resetBtn.textContent = "↺ Reset";
      resetBtn.style.cssText = btnStyle("#45475a", "#cdd6f4");
      resetBtn.onclick = () => {
        state.scale = 1; state.rotation = 0;
        state.flipH = false; state.flipV = false;
        state.offsetX = 0; state.offsetY = 0;
        flipHBtn.textContent = "↔ H"; updateBtnStyle(flipHBtn, "#313244", "#cdd6f4");
        flipVBtn.textContent = "↕ V"; updateBtnStyle(flipVBtn, "#313244", "#cdd6f4");
        updateInfo();
        renderPanelCanvas();
      };
      header.appendChild(resetBtn);

      // Spacer
      const spacer = document.createElement("div");
      spacer.style.flex = "1";
      header.appendChild(spacer);

      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "✕";
      closeBtn.style.cssText = `
        padding:4px 10px; border-radius:6px; border:none;
        background:transparent; color:#6c7086; cursor:pointer; font-size:16px;
      `;
      closeBtn.onclick = () => closePanel(false);
      header.appendChild(closeBtn);

      // Drag to move
      header.onpointerdown = (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        const sx = e.clientX - panel.offsetLeft;
        const sy = e.clientY - panel.offsetTop;
        const onMove = (ev) => {
          panel.style.left = Math.max(0, ev.clientX - sx) + "px";
          panel.style.top = Math.max(0, ev.clientY - sy) + "px";
        };
        const onUp = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      };

      // ── Body: Canvas area ──
      const body = document.createElement("div");
      body.style.cssText = "flex:1;min-height:0;display:flex;overflow:hidden;";

      const canvasWrap = document.createElement("div");
      canvasWrap.style.cssText = `
        flex:1; min-width:0; overflow:hidden;
        display:flex; align-items:center; justify-content:center;
        background:#11111b;
      `;

      const canvas = document.createElement("canvas");
      canvas.style.cssText = "cursor:grab;";
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      canvasWrap.appendChild(canvas);

      body.appendChild(canvasWrap);

      // ── Sidebar ──
      const sidebar = document.createElement("div");
      sidebar.style.cssText = `
        width:200px; flex-shrink:0; background:#181825;
        border-left:1px solid #313244;
        display:flex; flex-direction:column; padding:14px;
        gap:12px; font-size:13px;
      `;

      sidebar.innerHTML = `
        <div style="font-weight:600;font-size:14px;border-bottom:1px solid #313244;padding-bottom:8px;">Controls</div>
        <div><label style="display:flex;justify-content:space-between;">Scale <span id="mce-val-scale" style="color:#89b4fa;">${state.scale.toFixed(2)}</span></label>
          <input type="range" id="mce-sl-scale" min="0.1" max="5" step="0.01" value="${state.scale}" style="width:100%;accent-color:#89b4fa;"></div>
        <div><label style="display:flex;justify-content:space-between;">Rotation <span id="mce-val-rot" style="color:#a6e3a1;">${state.rotation.toFixed(1)}°</span></label>
          <input type="range" id="mce-sl-rot" min="-180" max="180" step="0.5" value="${state.rotation}" style="width:100%;accent-color:#a6e3a1;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset X <span id="mce-val-ox" style="color:#fab387;">${state.offsetX}</span></label>
          <input type="range" id="mce-sl-ox" min="-2048" max="2048" step="1" value="${state.offsetX}" style="width:100%;accent-color:#fab387;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset Y <span id="mce-val-oy" style="color:#f9e2af;">${state.offsetY}</span></label>
          <input type="range" id="mce-sl-oy" min="-2048" max="2048" step="1" value="${state.offsetY}" style="width:100%;accent-color:#f9e2af;"></div>
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid #313244;color:#6c7086;font-size:11px;line-height:1.5;">
          <div>🖱 <b>Drag</b> to pan</div>
          <div>🖱 <b>Scroll</b> to zoom</div>
          <div>🖱 <b>Shift+Scroll</b> to rotate</div>
          <div style="margin-top:6px;">The mask is the fixed window —<br>the background image moves behind it.</div>
        </div>
      `;

      body.appendChild(sidebar);

      // ── Footer ──
      const footer = document.createElement("div");
      footer.style.cssText = `
        display:flex; align-items:center; gap:10px;
        padding:10px 14px; background:#181825;
        border-top:1px solid #313244; flex-shrink:0;
      `;

      const statusText = document.createElement("span");
      statusText.style.cssText = "font-size:11px;color:#6c7086;flex:1;";
      statusText.textContent = "Position the image behind the mask";
      footer.appendChild(statusText);

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = btnStyle("#313244", "#cdd6f4");
      cancelBtn.onclick = () => closePanel(false);
      footer.appendChild(cancelBtn);

      const applyBtn = document.createElement("button");
      applyBtn.textContent = "✅ Apply";
      applyBtn.style.cssText = `
        padding:8px 20px; border-radius:8px; border:none;
        background:#89b4fa; color:#1e1e2e; cursor:pointer;
        font-weight:600; font-size:13px;
      `;
      applyBtn.onclick = () => closePanel(true);
      footer.appendChild(applyBtn);

      // ── Assemble ──
      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      document.body.appendChild(panel);

      // ── Helper functions ──
      function updateInfo() {
        const els = {
          "mce-val-scale": state.scale.toFixed(2),
          "mce-val-rot": state.rotation.toFixed(1) + "°",
          "mce-val-ox": state.offsetX,
          "mce-val-oy": state.offsetY,
        };
        for (const [id, val] of Object.entries(els)) {
          const el = panel.querySelector(`#${id}`);
          if (el) el.textContent = val;
        }
      }

      function renderPanelCanvas() {
        const ctx = canvas.getContext("2d");
        const W = CANVAS_W, H = CANVAS_H;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#11111b";
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2, cy = H / 2;
        const mw = Math.min(W * 0.5, H * 0.5, 300);
        const mh = mw;
        const mx = cx - mw / 2, my = cy - mh / 2;

        // ── Draw background image with transforms ──
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(state.scale, state.scale);
        ctx.rotate((state.rotation * Math.PI) / 180);
        if (state.flipH) ctx.scale(-1, 1);
        if (state.flipV) ctx.scale(1, -1);
        ctx.translate(state.offsetX, state.offsetY);

        if (self.__mce_img && self.__mce_img.complete && self.__mce_img.naturalWidth > 0) {
          ctx.drawImage(self.__mce_img, -self.__mce_imgW / 2, -self.__mce_imgH / 2, self.__mce_imgW, self.__mce_imgH);
          ctx.strokeStyle = "rgba(203,166,247,0.2)";
          ctx.lineWidth = 1;
          ctx.strokeRect(-self.__mce_imgW / 2, -self.__mce_imgH / 2, self.__mce_imgW, self.__mce_imgH);
        } else {
          // Grid fallback
          drawGrid(ctx, W, H);
        }
        ctx.restore();

        // ── Mask overlay ──
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, W, my);
        ctx.fillRect(0, my + mh, W, H - (my + mh));
        ctx.fillRect(0, my, mx, mh);
        ctx.fillRect(mx + mw, my, W - (mx + mw), mh);

        // Mask border
        ctx.strokeStyle = "#89b4fa";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(mx, my, mw, mh);
        ctx.setLineDash([]);

        // Corner markers
        ctx.strokeStyle = "#cba6f7";
        ctx.lineWidth = 3;
        const cl = 16;
        const c = (x, y, dx1, dy1, dx2, dy2) => {
          ctx.beginPath(); ctx.moveTo(x + dx1, y + dy1); ctx.lineTo(x, y); ctx.lineTo(x + dx2, y + dy2); ctx.stroke();
        };
        c(mx, my, cl, 0, 0, cl);
        c(mx + mw, my, -cl, 0, 0, cl);
        c(mx, my + mh, cl, 0, 0, -cl);
        c(mx + mw, my + mh, -cl, 0, 0, -cl);

        // Crosshair
        ctx.strokeStyle = "rgba(203,166,247,0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(cx, my); ctx.lineTo(cx, my + mh);
        ctx.moveTo(mx, cy); ctx.lineTo(mx + mw, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Info label
        ctx.fillStyle = "rgba(198,160,246,0.7)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(
          `${Math.round(mw)}×${Math.round(mh)}  S:${state.scale.toFixed(2)}  R:${state.rotation.toFixed(0)}°${state.flipH?" H":""}${state.flipV?" V":""}`,
          mx + 4, my + mh + 14
        );

        // Canvas size label (bottom-right)
        const label = `${CANVAS_W} × ${CANVAS_H}`;
        ctx.font = "bold 12px monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(W - lw - 14, H - 26, lw + 10, 20);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(label, W - lw - 9, H - 11);
        ctx.textAlign = "start";
      }

      // ── Slider events ──
      const bindSlider = (slId, valId, key, parseFn, formatFn) => {
        const sl = panel.querySelector(`#${slId}`);
        const vl = panel.querySelector(`#${valId}`);
        if (!sl) return;
        sl.addEventListener("input", () => {
          const v = parseFn(sl.value);
          state[key] = v;
          if (vl) vl.textContent = formatFn ? formatFn(v) : v;
          renderPanelCanvas();
        });
      };
      bindSlider("mce-sl-scale", "mce-val-scale", "scale", parseFloat, (v) => v.toFixed(2));
      bindSlider("mce-sl-rot", "mce-val-rot", "rotation", parseFloat, (v) => v.toFixed(1) + "°");
      bindSlider("mce-sl-ox", "mce-val-ox", "offsetX", parseInt, (v) => v);
      bindSlider("mce-sl-oy", "mce-val-oy", "offsetY", parseInt, (v) => v);

      // ── Canvas mouse interaction ──
      let dragging = false, dragSX = 0, dragSY = 0, dragOX = 0, dragOY = 0;

      canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        dragSX = e.clientX; dragSY = e.clientY;
        dragOX = state.offsetX; dragOY = state.offsetY;
        canvas.style.cursor = "grabbing";
      });

      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const sens = 1 / Math.max(state.scale, 0.1);
        state.offsetX = Math.round(dragOX + (e.clientX - dragSX) * sens);
        state.offsetY = Math.round(dragOY + (e.clientY - dragSY) * sens);
        state.offsetX = Math.max(-8192, Math.min(8192, state.offsetX));
        state.offsetY = Math.max(-8192, Math.min(8192, state.offsetY));
        panel.querySelector("#mce-sl-ox").value = state.offsetX;
        panel.querySelector("#mce-sl-oy").value = state.offsetY;
        updateInfo();
        renderPanelCanvas();
      });

      window.addEventListener("mouseup", () => {
        if (dragging) {
          dragging = false;
          canvas.style.cursor = "grab";
        }
      });

      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.shiftKey) {
          state.rotation += e.deltaY > 0 ? -5 : 5;
          state.rotation = Math.max(-180, Math.min(180, state.rotation));
          panel.querySelector("#mce-sl-rot").value = state.rotation;
        } else {
          state.scale += e.deltaY > 0 ? -0.05 : 0.05;
          state.scale = Math.max(0.01, Math.min(10, Math.round(state.scale * 100) / 100));
          panel.querySelector("#mce-sl-scale").value = state.scale;
        }
        updateInfo();
        renderPanelCanvas();
      }, { passive: false });

      // ── Keyboard ──
      const onKeyDown = (e) => {
        if (!document.body.contains(panel)) {
          document.removeEventListener("keydown", onKeyDown);
          return;
        }
        if (e.key === "Escape") closePanel(false);
        if (e.key === "Enter" && !e.shiftKey) closePanel(true);
        if (e.key === "r" && !e.ctrlKey && !e.metaKey) { resetBtn.onclick(); }
      };
      document.addEventListener("keydown", onKeyDown);

      // ── Close panel ──
      function closePanel(apply) {
        if (apply) {
          self.__mce_state = state;
          // Write to hidden bridge widget
          const sw = self.widgets?.find((w) => w.name === "transform_state");
          if (sw) sw.value = JSON.stringify(state);
          if (self.graph) self.graph._version = (self.graph._version || 0) + 1;
        }
        document.removeEventListener("keydown", onKeyDown);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        self.__mce_panel = null;
      }

      // ── Initial render ──
      renderPanelCanvas();
    };
  },
});

// ── Utility functions ─────────────────────────────────────
function btnStyle(bg, fg) {
  return `padding:6px 12px;border-radius:6px;border:1px solid rgba(69,71,90,.4);background:${bg};color:${fg};cursor:pointer;font-size:12px;font-weight:600;`;
}

function updateBtnStyle(btn, bg, fg) {
  btn.style.background = bg;
  btn.style.color = fg;
}

function drawGrid(ctx, W, H) {
  const ext = Math.max(W, H) * 2;
  const step = 64;
  const s = -ext, e = ext;
  for (let y = s; y < e; y += step) {
    for (let x = s; x < e; x += step) {
      ctx.fillStyle = ((Math.floor(x / step) + Math.floor(y / step)) & 1) === 0 ? "#2a2a3a" : "#1e1e2e";
      ctx.fillRect(x, y, step, step);
    }
  }
  ctx.strokeStyle = "rgba(137,180,250,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = s; x <= e; x += step) { ctx.moveTo(x, s); ctx.lineTo(x, e); }
  for (let y = s; y <= e; y += step) { ctx.moveTo(s, y); ctx.lineTo(e, y); }
  ctx.stroke();
  ctx.strokeStyle = "rgba(137,180,250,0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(40, 0);
  ctx.moveTo(0, -40); ctx.lineTo(0, 40);
  ctx.stroke();
  ctx.fillStyle = "#89b4fa";
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();
}
