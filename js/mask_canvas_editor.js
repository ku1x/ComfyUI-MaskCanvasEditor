/**
 * Mask Canvas Editor — Frontend Extension
 *
 * Compact node with a floating DOM-based canvas editor panel.
 * Coordinate system is in ORIGINAL-IMAGE pixel space:
 * - Zoom-to-fit base transform so the full image is visible on canvas
 * - Mask window drawn at actual bbox size (from Python metadata)
 * - offsetX/Y are in original image pixel space (consistent with Python)
 * - All transforms (scale, rotation, flip) work in the same space
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
const PANEL_H = 600;
const CANVAS_W = 960;
const CANVAS_H = 600;

// ─────────────────────────────────────────────────────────────
//  Extension
// ─────────────────────────────────────────────────────────────
app.registerExtension({
  name: "MaskCanvasEditor.Extension",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const origOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);
      this.size = [240, 80];
      this.__mce_state = { ...DEFAULT_STATE };
      this.__mce_img = null;
      this.__mce_imgW = 0;
      this.__mce_imgH = 0;
      this.__mce_origW = 0;
      this.__mce_origH = 0;
      this.__mce_bboxW = 0;
      this.__mce_bboxH = 0;
      this.__mce_zoom = 1;

      // Hidden bridge widget for transform_state
      const sw = this.addWidget("text", "transform_state", "{}", () => {}, {});
      sw.hidden = true;
      sw.computeSize = () => [0, -4];
      sw.draw = () => {};
      sw.serializeValue = () => JSON.stringify(this.__mce_state);

      try {
        const v = sw.value;
        if (v && v !== "{}") {
          this.__mce_state = { ...DEFAULT_STATE, ...JSON.parse(v) };
        }
      } catch (_) {}

      this.addWidget("button", "🎨 Open Canvas Editor", null, () => {
        this._openEditor();
      });

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

    // ── onDrawForeground (thumbnail preview on compact node) ──
    const origFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origFg?.apply(this, arguments);
      if (this.flags?.collapsed) return;
      if (this.__mce_img && this.__mce_img.complete && this.__mce_img.naturalWidth > 0) {
        const W = this.size[0];
        const H = this.size[1];
        const thumbH = H - 38;
        if (thumbH > 20) {
          ctx.save();
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
          ctx.fillStyle = "#11111b";
          ctx.fillRect(0, 20, W, thumbH);
          const scale = Math.min(W / this.__mce_imgW, thumbH / this.__mce_imgH, 1);
          const dw = this.__mce_imgW * scale;
          const dh = this.__mce_imgH * scale;
          ctx.drawImage(this.__mce_img, (W - dw) / 2, 20 + (thumbH - dh) / 2, dw, dh);
          ctx.restore();
        }
      }
    };

    // ── onExecuted: receive preview + coordinate info ──────
    const origExec = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExec?.apply(this, arguments);
      const preview = message?.mce_preview?.[0];
      const info = message?.mce_info?.[0];
      if (info) {
        this.__mce_origW = info.orig_w || 0;
        this.__mce_origH = info.orig_h || 0;
        this.__mce_bboxW = info.bbox_w || 0;
        this.__mce_bboxH = info.bbox_h || 0;
      }
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
      const state = this.__mce_state;

      // ── Panel DOM ──
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

      const flipHBtn = makeBtn(state.flipH ? "↔ H ✓" : "↔ H",
        state.flipH ? "#89b4fa" : "#313244",
        state.flipH ? "#1e1e2e" : "#cdd6f4",
        () => { state.flipH = !state.flipH; updateFlipBtns(); render(); });
      const flipVBtn = makeBtn(state.flipV ? "↕ V ✓" : "↕ V",
        state.flipV ? "#a6e3a1" : "#313244",
        state.flipV ? "#1e1e2e" : "#cdd6f4",
        () => { state.flipV = !state.flipV; updateFlipBtns(); render(); });
      const resetBtn = makeBtn("↺ Reset", "#45475a", "#cdd6f4", () => {
        state.scale = 1; state.rotation = 0;
        state.flipH = false; state.flipV = false;
        state.offsetX = 0; state.offsetY = 0;
        updateFlipBtns(); syncSliders(); updateInfo(); render();
      });
      header.appendChild(flipHBtn);
      header.appendChild(flipVBtn);
      header.appendChild(resetBtn);

      const spacer = document.createElement("div");
      spacer.style.flex = "1";
      header.appendChild(spacer);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "✕";
      closeBtn.style.cssText = `
        padding:4px 10px; border-radius:6px; border:none;
        background:transparent; color:#6c7086; cursor:pointer; font-size:16px;
      `;
      closeBtn.onclick = () => closePanel(false);
      header.appendChild(closeBtn);

      header.onpointerdown = (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        const sx = e.clientX - panel.offsetLeft;
        const sy = e.clientY - panel.offsetTop;
        const onMove = (ev) => {
          panel.style.left = Math.max(0, ev.clientX - sx) + "px";
          panel.style.top = Math.max(0, ev.clientY - sy) + "px";
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", () => {
          document.removeEventListener("pointermove", onMove);
        }, { once: true });
      };

      // ── Body ──
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

      function getInfoText() {
        const oW = self.__mce_origW || self.__mce_imgW || 0;
        const oH = self.__mce_origH || self.__mce_imgH || 0;
        const bW = self.__mce_bboxW || 0;
        const bH = self.__mce_bboxH || 0;
        let t = "";
        if (oW && oH) t += `Image: ${oW}×${oH}\n`;
        if (bW && bH) t += `Mask: ${bW}×${bH}\n`;
        t += `Display: ${CANVAS_W}×${CANVAS_H}`;
        return t;
      }

      sidebar.innerHTML = `
        <div style="font-weight:600;font-size:14px;border-bottom:1px solid #313244;padding-bottom:8px;">Controls</div>
        <div><label style="display:flex;justify-content:space-between;">Scale <span id="mce-v-scale" style="color:#89b4fa;">${state.scale.toFixed(2)}</span></label>
          <input type="range" id="mce-s-scale" min="0.1" max="5" step="0.01" value="${state.scale}" style="width:100%;accent-color:#89b4fa;"></div>
        <div><label style="display:flex;justify-content:space-between;">Rotation <span id="mce-v-rot" style="color:#a6e3a1;">${state.rotation.toFixed(1)}°</span></label>
          <input type="range" id="mce-s-rot" min="-180" max="180" step="0.5" value="${state.rotation}" style="width:100%;accent-color:#a6e3a1;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset X <span id="mce-v-ox" style="color:#fab387;">${state.offsetX}</span></label>
          <input type="range" id="mce-s-ox" min="-8192" max="8192" step="1" value="${state.offsetX}" style="width:100%;accent-color:#fab387;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset Y <span id="mce-v-oy" style="color:#f9e2af;">${state.offsetY}</span></label>
          <input type="range" id="mce-s-oy" min="-8192" max="8192" step="1" value="${state.offsetY}" style="width:100%;accent-color:#f9e2af;"></div>
        <pre id="mce-info-box" style="
          background:#11111b; border-radius:6px; padding:8px;
          font-size:11px; line-height:1.5; color:#6c7086;
          margin:0; white-space:pre-wrap;
        ">${getInfoText()}</pre>
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid #313244;color:#6c7086;font-size:11px;line-height:1.5;">
          <div>🖱 <b>Drag</b> to pan</div>
          <div>🖱 <b>Scroll</b> to zoom</div>
          <div>🖱 <b>Shift+Scroll</b> to rotate</div>
          <div>⌨ <b>R</b> to reset</div>
          <div style="margin-top:6px;">Mask window size = actual crop output size.</div>
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
      statusText.textContent = "Preview matches output";
      footer.appendChild(statusText);
      footer.appendChild(makeBtn("Cancel", "#313244", "#cdd6f4", () => closePanel(false)));
      footer.appendChild(makeBtn("✅ Apply", "#89b4fa", "#1e1e2e", () => closePanel(true)));

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      document.body.appendChild(panel);

      // ── Helper state ──
      self.__mce_zoom = 1; // will be recomputed in render()

      function updateFlipBtns() {
        flipHBtn.textContent = state.flipH ? "↔ H ✓" : "↔ H";
        flipHBtn.style.background = state.flipH ? "#89b4fa" : "#313244";
        flipHBtn.style.color = state.flipH ? "#1e1e2e" : "#cdd6f4";
        flipVBtn.textContent = state.flipV ? "↕ V ✓" : "↕ V";
        flipVBtn.style.background = state.flipV ? "#a6e3a1" : "#313244";
        flipVBtn.style.color = state.flipV ? "#1e1e2e" : "#cdd6f4";
      }

      function updateInfo() {
        setText("mce-v-scale", state.scale.toFixed(2));
        setText("mce-v-rot", state.rotation.toFixed(1) + "°");
        setText("mce-v-ox", state.offsetX);
        setText("mce-v-oy", state.offsetY);
        const b = panel.querySelector("#mce-info-box");
        if (b) b.textContent = getInfoText();
      }

      function setText(id, val) {
        const el = panel.querySelector(`#${id}`);
        if (el) el.textContent = val;
      }

      function syncSliders() {
        panel.querySelector("#mce-s-scale").value = state.scale;
        panel.querySelector("#mce-s-rot").value = state.rotation;
        panel.querySelector("#mce-s-ox").value = state.offsetX;
        panel.querySelector("#mce-s-oy").value = state.offsetY;
      }

      // ── Canvas render (unified coordinate system) ─────────
      function render() {
        const ctx = canvas.getContext("2d");
        const W = CANVAS_W, H = CANVAS_H;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#11111b";
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2, cy = H / 2;

        // Original image dimensions (in actual image pixel space)
        const origW = self.__mce_origW || self.__mce_imgW || W;
        const origH = self.__mce_origH || self.__mce_imgH || H;
        // Mask bbox dimensions (in actual image pixel space)
        const bboxW = self.__mce_bboxW || Math.round(Math.min(W * 0.3, 200));
        const bboxH = self.__mce_bboxH || Math.round(Math.min(H * 0.3, 200));

        // Zoom-to-fit: show the full image centered in the canvas
        // This is the base zoom — 1 "image pixel" = zoom "canvas pixels"
        const zoom = Math.max(0.05, Math.min(
          W * 0.85 / Math.max(origW, 1),
          H * 0.85 / Math.max(origH, 1),
          5.0
        ));
        self.__mce_zoom = zoom;

        // ── Draw image with transforms ──
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(zoom, zoom);                       // base zoom (fit image to canvas)
        ctx.scale(state.scale, state.scale);          // user scale
        ctx.rotate((state.rotation * Math.PI) / 180); // user rotation
        if (state.flipH) ctx.scale(-1, 1);           // user flip H
        if (state.flipV) ctx.scale(1, -1);           // user flip V
        ctx.translate(state.offsetX, state.offsetY);  // user offset (in image pixels)

        if (self.__mce_img && self.__mce_img.complete && self.__mce_img.naturalWidth > 0) {
          // Draw preview image stretched to original image pixel dimensions
          // (ctx.drawImage handles the stretch)
          ctx.drawImage(self.__mce_img, -origW / 2, -origH / 2, origW, origH);
          // Image edge highlight
          ctx.strokeStyle = "rgba(203,166,247,0.2)";
          ctx.lineWidth = 1 / (zoom * Math.max(state.scale, 0.01));
          ctx.strokeRect(-origW / 2, -origH / 2, origW, origH);
        } else {
          drawGrid(ctx, W / zoom, H / zoom);
        }
        ctx.restore();

        // ── Mask window (canvas pixel space) ──
        const mw = bboxW * zoom;
        const mh = bboxH * zoom;
        const mx = cx - mw / 2;
        const my = cy - mh / 2;

        // Semi-transparent overlay outside mask
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, W, my);
        ctx.fillRect(0, my + mh, W, H - (my + mh));
        ctx.fillRect(0, my, mx, mh);
        ctx.fillRect(mx + mw, my, W - (mx + mw), mh);

        // Mask border (dashed)
        ctx.strokeStyle = "#89b4fa";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(mx, my, mw, mh);
        ctx.setLineDash([]);

        // Corner markers
        ctx.strokeStyle = "#cba6f7";
        ctx.lineWidth = 3;
        const cl = Math.min(16, mw * 0.2, mh * 0.2);
        if (cl >= 6) {
          const corner = (x, y, dx1, dy1, dx2, dy2) => {
            ctx.beginPath(); ctx.moveTo(x + dx1, y + dy1);
            ctx.lineTo(x, y); ctx.lineTo(x + dx2, y + dy2); ctx.stroke();
          };
          corner(mx, my, cl, 0, 0, cl);
          corner(mx + mw, my, -cl, 0, 0, cl);
          corner(mx, my + mh, cl, 0, 0, -cl);
          corner(mx + mw, my + mh, -cl, 0, 0, -cl);
        }

        // Crosshair
        ctx.strokeStyle = "rgba(203,166,247,0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(cx, my); ctx.lineTo(cx, my + mh);
        ctx.moveTo(mx, cy); ctx.lineTo(mx + mw, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Info label (bottom-left of mask)
        ctx.fillStyle = "rgba(198,160,246,0.7)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(
          `Mask:${bboxW}×${bboxH}  S:${state.scale.toFixed(2)}  R:${state.rotation.toFixed(0)}°` +
          (state.flipH ? " H" : "") + (state.flipV ? " V" : ""),
          mx + 4, my + mh + 14
        );

        // Canvas size label (bottom-right)
        const label = `${CANVAS_W} × ${CANVAS_H}`;
        ctx.font = "bold 11px monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(W - lw - 14, H - 26, lw + 10, 20);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(label, W - lw - 9, H - 11);
        ctx.textAlign = "start";
      }

      // ── Slider binding ──
      function bindSlider(slId, valId, key, parseFn, fmtFn) {
        const sl = panel.querySelector(`#${slId}`);
        if (!sl) return;
        sl.addEventListener("input", () => {
          state[key] = parseFn(sl.value);
          const v = panel.querySelector(`#${valId}`);
          if (v) v.textContent = fmtFn(state[key]);
          render();
        });
      }
      bindSlider("mce-s-scale", "mce-v-scale", "scale", parseFloat, (v) => v.toFixed(2));
      bindSlider("mce-s-rot", "mce-v-rot", "rotation", parseFloat, (v) => v.toFixed(1) + "°");
      bindSlider("mce-s-ox", "mce-v-ox", "offsetX", (v) => parseInt(v) || 0, (v) => v);
      bindSlider("mce-s-oy", "mce-v-oy", "offsetY", (v) => parseInt(v) || 0, (v) => v);

      // ── Canvas mouse drag ──
      let dragging = false, dsx = 0, dsy = 0, dox = 0, doy = 0;

      canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        dsx = e.clientX; dsy = e.clientY;
        dox = state.offsetX; doy = state.offsetY;
        canvas.style.cursor = "grabbing";
      });

      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        // Drag sensitivity: screen delta → image pixel delta
        // 1 screen pixel = 1/(zoom * scale) image pixels
        const sens = 1 / (self.__mce_zoom * Math.max(state.scale, 0.1));
        const dx = Math.round((e.clientX - dsx) * sens);
        const dy = Math.round((e.clientY - dsy) * sens);
        state.offsetX = Math.max(-8192, Math.min(8192, dox + dx));
        state.offsetY = Math.max(-8192, Math.min(8192, doy + dy));
        syncSliders();
        updateInfo();
        render();
      });

      window.addEventListener("mouseup", () => {
        if (dragging) { dragging = false; canvas.style.cursor = "grab"; }
      });

      // ── Canvas wheel ──
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.shiftKey) {
          state.rotation += e.deltaY > 0 ? -5 : 5;
          state.rotation = Math.max(-180, Math.min(180, state.rotation));
          panel.querySelector("#mce-s-rot").value = state.rotation;
        } else {
          state.scale += e.deltaY > 0 ? -0.05 : 0.05;
          state.scale = Math.max(0.01, Math.min(10, Math.round(state.scale * 100) / 100));
          panel.querySelector("#mce-s-scale").value = state.scale;
        }
        updateInfo();
        render();
      }, { passive: false });

      // ── Keyboard ──
      const onKeyDown = (e) => {
        if (!document.body.contains(panel)) {
          document.removeEventListener("keydown", onKeyDown);
          return;
        }
        if (e.key === "Escape") closePanel(false);
        if (e.key === "Enter" && !e.shiftKey) closePanel(true);
        if (e.key === "r" && !e.ctrlKey && !e.metaKey) resetBtn.onclick();
      };
      document.addEventListener("keydown", onKeyDown);

      // ── Close ──
      function closePanel(apply) {
        if (apply) {
          const sw = self.widgets?.find((w) => w.name === "transform_state");
          if (sw) sw.value = JSON.stringify(state);
          if (self.graph) self.graph._version = (self.graph._version || 0) + 1;
        }
        document.removeEventListener("keydown", onKeyDown);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        self.__mce_panel = null;
      }

      // ── Kick off ──
      render();
    };
  },
});

// ── Utilities ─────────────────────────────────────────────
function makeBtn(label, bg, fg, onClick) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.cssText = `padding:6px 12px;border-radius:6px;border:1px solid rgba(69,71,90,.4);background:${bg};color:${fg};cursor:pointer;font-size:12px;font-weight:600;`;
  btn.onclick = onClick;
  return btn;
}

function drawGrid(ctx, W, H) {
  const ext = Math.max(W, H) * 2;
  const step = Math.max(32, Math.min(128, Math.min(W, H) / 8));
  for (let y = -ext; y < ext; y += step) {
    for (let x = -ext; x < ext; x += step) {
      ctx.fillStyle = ((Math.floor(x / step) + Math.floor(y / step)) & 1) === 0 ? "#2a2a3a" : "#1e1e2e";
      ctx.fillRect(x, y, step, step);
    }
  }
  ctx.strokeStyle = "rgba(137,180,250,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -ext; x <= ext; x += step) { ctx.moveTo(x, -ext); ctx.lineTo(x, ext); }
  for (let y = -ext; y <= ext; y += step) { ctx.moveTo(-ext, y); ctx.lineTo(ext, y); }
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
