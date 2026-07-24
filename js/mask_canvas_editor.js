/**
 * Mask Canvas Editor — Frontend Extension
 *
 * Compact node with floating DOM canvas editor.
 * Auto-loads images from upstream LoadImage nodes when opening,
 * so you can edit without queueing the workflow first.
 * Mask is always treated as rectangular bbox (no shape cropping).
 *
 * Coordinate system: original image pixel space, zoom-to-fit display.
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

const CANVAS_W = 960;
const CANVAS_H = 600;

// ─────────────────────────────────────────────────────────────
//  Graph helpers
// ─────────────────────────────────────────────────────────────

/** Find the upstream node ID connected to a given input index. */
function getUpstreamNodeId(node, inputIdx) {
  const input = node.inputs?.[inputIdx];
  if (!input?.link) return null;
  const link = app.graph.links?.[input.link];
  if (!link) return null;
  return link.origin_id;
}

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
      this.__mce_origW = 0;
      this.__mce_origH = 0;
      this.__mce_bboxW = 0;
      this.__mce_bboxH = 0;
      this.__mce_hasQueueResult = false;

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

    // ── onDrawForeground (thumbnail) ──────────────────────
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
          ctx.beginPath();
          const r = 4;
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
          const s = Math.min(W / this.__mce_imgW, thumbH / this.__mce_imgH, 1);
          ctx.drawImage(this.__mce_img, (W - this.__mce_imgW * s) / 2, 20 + (thumbH - this.__mce_imgH * s) / 2, this.__mce_imgW * s, this.__mce_imgH * s);
          ctx.restore();
        }
      }
    };

    // ── onExecuted (when workflow runs) ────────────────────
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
        this.__mce_hasQueueResult = true;
        this.setDirtyCanvas(true, true);
      };
      img.src = url;
    };

    // ── Load images via /mce/load API ────────────────────
    nodeType.prototype._loadFromUpstream = function () {
      return new Promise((resolve) => {
        const imageNodeId = getUpstreamNodeId(this, 1);
        const maskNodeId = getUpstreamNodeId(this, 0);

        // Try to read filenames from LoadImage widgets directly (works without queue)
        let imageFilename = null;
        let maskFilename = null;
        if (imageNodeId) {
          const upNode = app.graph.getNodeById(imageNodeId);
          if (upNode) {
            const w = upNode.widgets?.find((x) => x.name === "image");
            if (w) imageFilename = w.value;
          }
        }
        if (maskNodeId && maskNodeId !== imageNodeId) {
          const upNode = app.graph.getNodeById(maskNodeId);
          if (upNode) {
            const w = upNode.widgets?.find((x) => x.name === "image");
            if (w) maskFilename = w.value;
          }
        }

        if (!imageNodeId && !imageFilename) {
          resolve(false);
          return;
        }

        const params = new URLSearchParams();
        if (imageFilename) params.set("image_filename", imageFilename);
        if (maskFilename) params.set("mask_filename", maskFilename);
        if (!imageFilename && imageNodeId) params.set("image_node_id", imageNodeId);
        if (maskNodeId) params.set("mask_node_id", maskNodeId);
        params.set("t", Date.now());

        fetch(`/mce/load?${params.toString()}`)
          .then((r) => r.json())
          .then((data) => {
            if (!data.success) {
              resolve(false);
              return;
            }

            const imgInfo = data.image;

            if (imgInfo && imgInfo.url) {
              this.__mce_origW = imgInfo.width || 0;
              this.__mce_origH = imgInfo.height || 0;
              const mi = data.mask;
              this.__mce_bboxW = (mi && mi.width) || imgInfo.width || 0;
              this.__mce_bboxH = (mi && mi.height) || imgInfo.height || 0;

              const img = new Image();
              img.onload = () => {
                this.__mce_img = img;
                this.__mce_imgW = img.naturalWidth;
                this.__mce_imgH = img.naturalHeight;
                if (!this.__mce_origW) this.__mce_origW = img.naturalWidth;
                if (!this.__mce_origH) this.__mce_origH = img.naturalHeight;
                this.__mce_hasQueueResult = false;
                this.setDirtyCanvas(true, true);
                resolve(true);
              };
              img.onerror = () => resolve(false);
              img.src = imgInfo.url + "&t=" + Date.now();
            } else {
              resolve(false);
            }
          })
          .catch(() => resolve(false));
      });
    };

    // ── Floating Editor Panel ──────────────────────────────
    nodeType.prototype._openEditor = async function () {
      if (this.__mce_panel && document.body.contains(this.__mce_panel)) {
        this.__mce_panel.style.zIndex = 10000;
        return;
      }

      const self = this;
      const state = this.__mce_state;

      // Attempt auto-load from upstream if no queue result yet
      if (!this.__mce_hasQueueResult && !this.__mce_img) {
        await this._loadFromUpstream();
      }

      // ── Panel ──
      const panel = document.createElement("div");
      panel.id = `mce-panel-${this.id}`;
      panel.style.cssText = `
        position:fixed; top:60px; left:60px; z-index:9998;
        background:#1e1e2e; border-radius:12px; overflow:hidden;
        display:flex; flex-direction:column;
        width:min(800px,90vw); height:min(600px,85vh);
        box-shadow:0 24px 80px rgba(0,0,0,.6);
        border:1px solid rgba(69,71,90,.3); resize:both;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#cdd6f4;
      `;
      this.__mce_panel = panel;

      // ── Header ──
      const header = m("div", { style: `display:flex;align-items:center;gap:10px;padding:10px 14px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;flex-wrap:wrap;cursor:move;` });
      header.appendChild(m("span", { style: "font-weight:700;font-size:15px;color:#cdd6f4;margin-right:8px;" }, "🎨 Mask Canvas Editor"));

      const flipHBtn = mkBtn(state.flipH ? "↔ H ✓" : "↔ H", state.flipH ? "#89b4fa" : "#313244", state.flipH ? "#1e1e2e" : "#cdd6f4",
        () => { state.flipH = !state.flipH; updFlip(); render(); });
      const flipVBtn = mkBtn(state.flipV ? "↕ V ✓" : "↕ V", state.flipV ? "#a6e3a1" : "#313244", state.flipV ? "#1e1e2e" : "#cdd6f4",
        () => { state.flipV = !state.flipV; updFlip(); render(); });
      const resetBtn = mkBtn("↺ Reset", "#45475a", "#cdd6f4", () => {
        state.scale = 1; state.rotation = 0; state.flipH = false; state.flipV = false;
        state.offsetX = 0; state.offsetY = 0; updFlip(); syncSliders(); updInfo(); render();
      });
      const reloadBtn = mkBtn("🔄 Reload", "#313244", "#cdd6f4", async () => {
        reloadBtn.disabled = true; reloadBtn.textContent = "🔄 Loading...";
        await self._loadFromUpstream();
        reloadBtn.disabled = false; reloadBtn.textContent = "🔄 Reload";
        render(); updInfo();
      });
      header.appendChild(flipHBtn); header.appendChild(flipVBtn); header.appendChild(resetBtn); header.appendChild(reloadBtn);
      const sp2 = m("div", { style: "flex:1" }); header.appendChild(sp2);
      const closeBtn = mkBtn("✕", "transparent", "#6c7086", () => closeP(false));
      closeBtn.style.fontSize = "16px";
      header.appendChild(closeBtn);

      header.onpointerdown = (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        const sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
        const mv = (ev) => { panel.style.left = Math.max(0, ev.clientX - sx) + "px"; panel.style.top = Math.max(0, ev.clientY - sy) + "px"; };
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", () => document.removeEventListener("pointermove", mv), { once: true });
      };

      // ── Body ──
      const body = m("div", { style: "flex:1;min-height:0;display:flex;overflow:hidden;" });
      const cw = m("div", { style: "flex:1;min-width:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#11111b;" });
      const canvas = m("canvas", { style: "cursor:grab;", width: CANVAS_W, height: CANVAS_H });
      cw.appendChild(canvas);
      body.appendChild(cw);

      // ── Sidebar ──
      const sidebar = m("div", { style: `width:200px;flex-shrink:0;background:#181825;border-left:1px solid #313244;display:flex;flex-direction:column;padding:14px;gap:12px;font-size:13px;` });

      function infoText() {
        const oW = self.__mce_origW || self.__mce_imgW || 0;
        const oH = self.__mce_origH || self.__mce_imgH || 0;
        const bW = self.__mce_bboxW || 0;
        const bH = self.__mce_bboxH || 0;
        let t = `Display: ${CANVAS_W}×${CANVAS_H}\n`;
        if (oW && oH) t += `Image: ${oW}×${oH}\n`;
        if (bW && bH) t += `Crop size: ${bW}×${bH}\n`;
        if (!self.__mce_hasQueueResult && !self.__mce_img) t += `\n(Queue once for\nprecise mask info)`;
        return t;
      }

      sidebar.innerHTML = `
        <div style="font-weight:600;font-size:14px;border-bottom:1px solid #313244;padding-bottom:8px;">Controls</div>
        <div><label style="display:flex;justify-content:space-between;">Scale <span id="mv-s" style="color:#89b4fa;">${state.scale.toFixed(2)}</span></label>
          <input type="range" id="ms-s" min="0.1" max="5" step="0.01" value="${state.scale}" style="width:100%;accent-color:#89b4fa;"></div>
        <div><label style="display:flex;justify-content:space-between;">Rotation <span id="mv-r" style="color:#a6e3a1;">${state.rotation.toFixed(1)}°</span></label>
          <input type="range" id="ms-r" min="-180" max="180" step="0.5" value="${state.rotation}" style="width:100%;accent-color:#a6e3a1;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset X <span id="mv-ox" style="color:#fab387;">${state.offsetX}</span></label>
          <input type="range" id="ms-ox" min="-8192" max="8192" step="1" value="${state.offsetX}" style="width:100%;accent-color:#fab387;"></div>
        <div><label style="display:flex;justify-content:space-between;">Offset Y <span id="mv-oy" style="color:#f9e2af;">${state.offsetY}</span></label>
          <input type="range" id="ms-oy" min="-8192" max="8192" step="1" value="${state.offsetY}" style="width:100%;accent-color:#f9e2af;"></div>
        <pre id="mv-info" style="background:#11111b;border-radius:6px;padding:8px;font-size:11px;line-height:1.5;color:#6c7086;margin:0;white-space:pre-wrap;">${infoText()}</pre>
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid #313244;color:#6c7086;font-size:11px;line-height:1.5;">
          <div>🖱 <b>Drag</b> to pan</div><div>🖱 <b>Scroll</b> to zoom</div><div>🖱 <b>Shift+Scroll</b> to rotate</div>
          <div>⌨ <b>R</b> reset</div><div style="margin-top:6px;">Mask is always rectangular.<br>Load via "🔄 Reload" without queue.</div>
        </div>
      `;
      body.appendChild(sidebar);

      // ── Footer ──
      const footer = m("div", { style: "display:flex;align-items:center;gap:10px;padding:10px 14px;background:#181825;border-top:1px solid #313244;flex-shrink:0;" });
      const stxt = m("span", { style: "font-size:11px;color:#6c7086;flex:1;" }, self.__mce_img ? "Loaded" : "Connect LoadImage & queue once");
      footer.appendChild(stxt);
      footer.appendChild(mkBtn("Cancel", "#313244", "#cdd6f4", () => closeP(false)));
      footer.appendChild(mkBtn("✅ Apply", "#89b4fa", "#1e1e2e", () => closeP(true)));

      panel.appendChild(header); panel.appendChild(body); panel.appendChild(footer);
      document.body.appendChild(panel);

      let zoom = 1;

      function updFlip() {
        flipHBtn.textContent = state.flipH ? "↔ H ✓" : "↔ H";
        flipHBtn.style.background = state.flipH ? "#89b4fa" : "#313244";
        flipHBtn.style.color = state.flipH ? "#1e1e2e" : "#cdd6f4";
        flipVBtn.textContent = state.flipV ? "↕ V ✓" : "↕ V";
        flipVBtn.style.background = state.flipV ? "#a6e3a1" : "#313244";
        flipVBtn.style.color = state.flipV ? "#1e1e2e" : "#cdd6f4";
      }
      function setV(id, val) { const e = panel.querySelector(`#${id}`); if (e) e.textContent = val; }
      function updInfo() {
        setV("mv-s", state.scale.toFixed(2));
        setV("mv-r", state.rotation.toFixed(1) + "°");
        setV("mv-ox", state.offsetX);
        setV("mv-oy", state.offsetY);
        const b = panel.querySelector("#mv-info");
        if (b) b.textContent = infoText();
      }
      function syncSliders() {
        panel.querySelector("#ms-s").value = state.scale;
        panel.querySelector("#ms-r").value = state.rotation;
        panel.querySelector("#ms-ox").value = state.offsetX;
        panel.querySelector("#ms-oy").value = state.offsetY;
      }

      // ── Canvas render ──
      function render() {
        const ctx = canvas.getContext("2d");
        const W = CANVAS_W, H = CANVAS_H;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#11111b";
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2, cy = H / 2;
        const origW = self.__mce_origW || self.__mce_imgW || W;
        const origH = self.__mce_origH || self.__mce_imgH || H;
        const bboxW = self.__mce_bboxW || Math.round(Math.min(W * 0.3, 200));
        const bboxH = self.__mce_bboxH || Math.round(Math.min(H * 0.3, 200));

        zoom = Math.max(0.05, Math.min(W * 0.85 / Math.max(origW, 1), H * 0.85 / Math.max(origH, 1), 5.0));
        self.__mce_zoom = zoom;

        // ── Background image + transforms ──
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(zoom, zoom);
        ctx.scale(state.scale, state.scale);
        ctx.rotate((state.rotation * Math.PI) / 180);
        if (state.flipH) ctx.scale(-1, 1);
        if (state.flipV) ctx.scale(1, -1);
        ctx.translate(state.offsetX, state.offsetY);

        if (self.__mce_img && self.__mce_img.complete && self.__mce_img.naturalWidth > 0) {
          ctx.drawImage(self.__mce_img, -origW / 2, -origH / 2, origW, origH);
          ctx.strokeStyle = "rgba(203,166,247,0.2)";
          ctx.lineWidth = 1 / (zoom * Math.max(state.scale, 0.01));
          ctx.strokeRect(-origW / 2, -origH / 2, origW, origH);
        } else {
          drawGrid(ctx, W / zoom, H / zoom);
          ctx.fillStyle = "rgba(137,180,250,0.6)";
          ctx.font = `${16 / zoom}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Connect LoadImage and queue once,", 0, -20 / zoom);
          ctx.fillText("or click 🔄 Reload", 0, 10 / zoom);
          ctx.textAlign = "start";
          ctx.textBaseline = "alphabetic";
        }
        ctx.restore();

        // ── Mask window ──
        const mw = bboxW * zoom;
        const mh = bboxH * zoom;
        const mx = cx - mw / 2, my = cy - mh / 2;

        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, W, my); ctx.fillRect(0, my + mh, W, H - (my + mh));
        ctx.fillRect(0, my, mx, mh); ctx.fillRect(mx + mw, my, W - (mx + mw), mh);

        ctx.strokeStyle = "#89b4fa";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(mx, my, mw, mh);
        ctx.setLineDash([]);

        ctx.strokeStyle = "#cba6f7";
        ctx.lineWidth = 3;
        const cl = Math.min(16, mw * 0.2, mh * 0.2);
        if (cl >= 6) {
          const cn = (x, y, d1x, d1y, d2x, d2y) => { ctx.beginPath(); ctx.moveTo(x + d1x, y + d1y); ctx.lineTo(x, y); ctx.lineTo(x + d2x, y + d2y); ctx.stroke(); };
          cn(mx, my, cl, 0, 0, cl); cn(mx + mw, my, -cl, 0, 0, cl);
          cn(mx, my + mh, cl, 0, 0, -cl); cn(mx + mw, my + mh, -cl, 0, 0, -cl);
        }

        ctx.strokeStyle = "rgba(203,166,247,0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(cx, my); ctx.lineTo(cx, my + mh); ctx.moveTo(mx, cy); ctx.lineTo(mx + mw, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "rgba(198,160,246,0.7)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(
          `Crop:${bboxW}×${bboxH}  S:${state.scale.toFixed(2)}  R:${state.rotation.toFixed(0)}°${state.flipH?" H":""}${state.flipV?" V":""}`,
          mx + 4, my + mh + 14
        );

        const label = `${CANVAS_W}×${CANVAS_H}`;
        ctx.font = "bold 11px monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(W - lw - 14, H - 26, lw + 10, 20);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(label, W - lw - 9, H - 11);
        ctx.textAlign = "start";
      }

      // ── Sliders ──
      function bindSl(slId, vId, key, parse, fmt) {
        const sl = panel.querySelector(`#${slId}`);
        if (!sl) return;
        sl.addEventListener("input", () => { state[key] = parse(sl.value); setV(vId, fmt(state[key])); render(); });
      }
      bindSl("ms-s", "mv-s", "scale", parseFloat, v => v.toFixed(2));
      bindSl("ms-r", "mv-r", "rotation", parseFloat, v => v.toFixed(1) + "°");
      bindSl("ms-ox", "mv-ox", "offsetX", v => parseInt(v) || 0, v => v);
      bindSl("ms-oy", "mv-oy", "offsetY", v => parseInt(v) || 0, v => v);

      // ── Mouse drag ──
      let dragging = false, dsx = 0, dsy = 0, dox = 0, doy = 0;
      canvas.addEventListener("mousedown", (e) => { dragging = true; dsx = e.clientX; dsy = e.clientY; dox = state.offsetX; doy = state.offsetY; canvas.style.cursor = "grabbing"; });
      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const sens = 1 / (zoom * Math.max(state.scale, 0.1));
        state.offsetX = Math.max(-8192, Math.min(8192, dox + Math.round((e.clientX - dsx) * sens)));
        state.offsetY = Math.max(-8192, Math.min(8192, doy + Math.round((e.clientY - dsy) * sens)));
        syncSliders(); updInfo(); render();
      });
      window.addEventListener("mouseup", () => { if (dragging) { dragging = false; canvas.style.cursor = "grab"; } });

      // ── Wheel ──
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.shiftKey) { state.rotation += e.deltaY > 0 ? -5 : 5; state.rotation = Math.max(-180, Math.min(180, state.rotation)); panel.querySelector("#ms-r").value = state.rotation; }
        else { state.scale += e.deltaY > 0 ? -0.05 : 0.05; state.scale = Math.max(0.01, Math.min(10, Math.round(state.scale * 100) / 100)); panel.querySelector("#ms-s").value = state.scale; }
        updInfo(); render();
      }, { passive: false });

      // ── Keyboard ──
      const kd = (e) => {
        if (!document.body.contains(panel)) { document.removeEventListener("keydown", kd); return; }
        if (e.key === "Escape") closeP(false);
        if (e.key === "Enter" && !e.shiftKey) closeP(true);
        if (e.key === "r" && !e.ctrlKey && !e.metaKey) resetBtn.onclick();
      };
      document.addEventListener("keydown", kd);

      // ── Close ──
      function closeP(apply) {
        if (apply) {
          const sw = self.widgets?.find((w) => w.name === "transform_state");
          if (sw) sw.value = JSON.stringify(state);
          if (self.graph) self.graph._version = (self.graph._version || 0) + 1;
        }
        document.removeEventListener("keydown", kd);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        self.__mce_panel = null;
      }

      render();
    };
  },
});

// ── Utilities ─────────────────────────────────────────────
function m(tag, attrs, text) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
function mkBtn(label, bg, fg, onClick) {
  const btn = m("button", { style: `padding:6px 12px;border-radius:6px;border:1px solid rgba(69,71,90,.4);background:${bg};color:${fg};cursor:pointer;font-size:12px;font-weight:600;` }, label);
  btn.onclick = onClick;
  return btn;
}
function drawGrid(ctx, W, H) {
  const ext = Math.max(W, H) * 2;
  const step = Math.max(32, Math.min(128, Math.min(W, H) / 8));
  for (let y = -ext; y < ext; y += step) for (let x = -ext; x < ext; x += step) {
    ctx.fillStyle = ((Math.floor(x / step) + Math.floor(y / step)) & 1) === 0 ? "#2a2a3a" : "#1e1e2e";
    ctx.fillRect(x, y, step, step);
  }
  ctx.strokeStyle = "rgba(137,180,250,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -ext; x <= ext; x += step) { ctx.moveTo(x, -ext); ctx.lineTo(x, ext); }
  for (let y = -ext; y <= ext; y += step) { ctx.moveTo(-ext, y); ctx.lineTo(ext, y); }
  ctx.stroke();
  ctx.strokeStyle = "rgba(137,180,250,0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(40, 0); ctx.moveTo(0, -40); ctx.lineTo(0, 40);
  ctx.stroke();
  ctx.fillStyle = "#89b4fa";
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();
}
