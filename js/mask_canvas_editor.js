/**
 * Mask Canvas Editor — Frontend Extension
 *
 * Adds an interactive canvas editor modal to the MaskCanvasEditor node.
 * The editor shows a grid pattern (representing the background image)
 * behind a fixed mask outline, and allows interactive manipulation
 * via mouse drag (pan), scroll wheel (zoom), buttons (flip), and slider (rotation).
 */

import { app } from "../../scripts/app.js";

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────
const NODE_TYPE = "MaskCanvasEditor";
const EXTENSION_NAME = "MaskCanvasEditor.Extension";

// Widget names matching the Python INPUT_TYPES keys
const WIDGET_SCALE = "scale";
const WIDGET_ROTATION = "rotation";
const WIDGET_FLIP_H = "flip_horizontal";
const WIDGET_FLIP_V = "flip_vertical";
const WIDGET_OFFSET_X = "offset_x";
const WIDGET_OFFSET_Y = "offset_y";

// ─────────────────────────────────────────────────────────────
//  Widget helper — find a widget by name
// ─────────────────────────────────────────────────────────────
function findWidget(node, name) {
  return node.widgets.find((w) => w.name === name);
}

function getWidgetValue(node, name, fallback) {
  const w = findWidget(node, name);
  return w != null ? w.value : fallback;
}

function setWidgetValue(node, name, value) {
  const w = findWidget(node, name);
  if (w) {
    w.value = value;
    // Some ComfyUI versions need the callback fired for UI updates
    if (w.callback) w.callback(value);
  }
}

// ─────────────────────────────────────────────────────────────
//  Canvas Editor Modal
// ─────────────────────────────────────────────────────────────
class CanvasEditorModal {
  constructor(node) {
    this.node = node;
    this.overlay = null;
    this.canvas = null;
    this.ctx = null;

    // Current transform state (read from node widgets)
    this.scale = getWidgetValue(node, WIDGET_SCALE, 1.0);
    this.rotation = getWidgetValue(node, WIDGET_ROTATION, 0.0);
    this.flipH = getWidgetValue(node, WIDGET_FLIP_H, false);
    this.flipV = getWidgetValue(node, WIDGET_FLIP_V, false);
    this.offsetX = getWidgetValue(node, WIDGET_OFFSET_X, 0);
    this.offsetY = getWidgetValue(node, WIDGET_OFFSET_Y, 0);

    // Drag state
    this.dragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragOffsetXStart = 0;
    this.dragOffsetYStart = 0;

    // Canvas dimensions
    this.canvasW = 800;
    this.canvasH = 600;

    // Mask bbox dimensions (estimated — will be updated from node if available)
    this.maskW = 512;
    this.maskH = 512;

    // Animation frame
    this._raf = null;
  }

  // ── Open the modal ────────────────────────────────────────
  open() {
    if (this.overlay) return;

    // Re-read widget state
    this.readWidgets();

    // Create overlay
    this.overlay = document.createElement("div");
    this.overlay.id = "mask-canvas-editor-overlay";
    this.overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      z-index: 2147483600;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
    `;

    // Prevent background scroll
    document.body.style.overflow = "hidden";

    // Build the modal content
    this.overlay.innerHTML = this._buildHTML();

    document.body.appendChild(this.overlay);

    // Get canvas ref
    this.canvas = this.overlay.querySelector("#mask-canvas-editor-canvas");
    this.ctx = this.canvas.getContext("2d");

    // Size canvas to fit
    this._resizeCanvas();
    window.addEventListener("resize", this._onResize);

    // Wire up events
    this._bindEvents();

    // Start render loop
    this._startRender();

    // Sync initial state to info panel
    this._updateInfoPanel();
  }

  // ── Close the modal ───────────────────────────────────────
  close(applyChanges = true) {
    if (!this.overlay) return;

    if (applyChanges) {
      this.writeWidgets();
    }

    this._stopRender();
    window.removeEventListener("resize", this._onResize);
    document.body.style.overflow = "";

    this.overlay.remove();
    this.overlay = null;
    this.canvas = null;
    this.ctx = null;
  }

  // ── Build the dialog HTML ─────────────────────────────────
  _buildHTML() {
    return `
      <div style="
        background: #1e1e2e;
        border: 1px solid #45475a;
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 95vw;
        max-height: 95vh;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      ">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;color:#cdd6f4;">
          <h3 style="margin:0;font-size:16px;">
            🎨 Mask Canvas Editor
          </h3>
          <div style="display:flex;gap:8px;">
            <button id="mce-btn-reset" style="
              background:#313244;color:#cdd6f4;border:1px solid #45475a;
              border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;
            ">↺ Reset</button>
            <button id="mce-btn-close" style="
              background:#313244;color:#cdd6f4;border:1px solid #45475a;
              border-radius:6px;padding:4px 12px;cursor:pointer;font-size:16px;
            ">✕</button>
          </div>
        </div>

        <!-- Main area: Canvas + Controls side by side -->
        <div style="display:flex;gap:12px;flex:1;min-height:0;">
          <!-- Canvas -->
          <div style="
            flex:1;
            background:#11111b;
            border-radius:8px;
            overflow:hidden;
            display:flex;
            align-items:center;
            justify-content:center;
            min-width:400px;
          ">
            <canvas id="mask-canvas-editor-canvas"
                    style="display:block;max-width:100%;max-height:100%;cursor:grab;">
            </canvas>
          </div>

          <!-- Control panel -->
          <div style="
            width:220px;
            background:#181825;
            border-radius:8px;
            padding:12px;
            display:flex;
            flex-direction:column;
            gap:10px;
            color:#cdd6f4;
            font-size:13px;
            overflow-y:auto;
          ">
            <div style="font-weight:600;font-size:14px;border-bottom:1px solid #313244;padding-bottom:6px;">
              Controls
            </div>

            <!-- Scale -->
            <div>
              <label style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span>Scale</span>
                <span id="mce-info-scale" style="color:#89b4fa;">1.00</span>
              </label>
              <input type="range" id="mce-scale" min="0.1" max="5" step="0.01" value="${this.scale}"
                     style="width:100%;accent-color:#89b4fa;">
            </div>

            <!-- Rotation -->
            <div>
              <label style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span>Rotation</span>
                <span id="mce-info-rotation" style="color:#a6e3a1;">0.0°</span>
              </label>
              <input type="range" id="mce-rotation" min="-180" max="180" step="0.5" value="${this.rotation}"
                     style="width:100%;accent-color:#a6e3a1;">
            </div>

            <!-- Flip buttons -->
            <div>
              <label style="margin-bottom:2px;display:block;">Flip</label>
              <div style="display:flex;gap:6px;">
                <button id="mce-flip-h" class="mce-flip-btn ${this.flipH ? 'active' : ''}" style="
                  flex:1;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;
                  background:${this.flipH ? '#89b4fa' : '#313244'};
                  color:${this.flipH ? '#1e1e2e' : '#cdd6f4'};
                  border:1px solid ${this.flipH ? '#89b4fa' : '#45475a'};
                ">↔ H-Flip</button>
                <button id="mce-flip-v" class="mce-flip-btn" style="
                  flex:1;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;
                  background:${this.flipV ? '#a6e3a1' : '#313244'};
                  color:${this.flipV ? '#1e1e2e' : '#cdd6f4'};
                  border:1px solid ${this.flipV ? '#a6e3a1' : '#45475a'};
                ">↕ V-Flip</button>
              </div>
            </div>

            <!-- Offsets -->
            <div>
              <label style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span>Offset X</span>
                <span id="mce-info-offset-x" style="color:#fab387;">${this.offsetX}</span>
              </label>
              <input type="range" id="mce-offset-x" min="-2048" max="2048" step="1" value="${this.offsetX}"
                     style="width:100%;accent-color:#fab387;">
            </div>

            <div>
              <label style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span>Offset Y</span>
                <span id="mce-info-offset-y" style="color:#f9e2af;">${this.offsetY}</span>
              </label>
              <input type="range" id="mce-offset-y" min="-2048" max="2048" step="1" value="${this.offsetY}"
                     style="width:100%;accent-color:#f9e2af;">
            </div>

            <!-- Hint text -->
            <div style="
              margin-top:auto;padding-top:10px;border-top:1px solid #313244;
              color:#6c7086;font-size:11px;line-height:1.5;
            ">
              <div>🖱 <b>Drag</b> canvas to pan</div>
              <div>🖱 <b>Scroll</b> to zoom</div>
              <div>🖱 <b>Shift+Scroll</b> to rotate</div>
              <div style="margin-top:6px;">Mask is the fixed window — the background image moves behind it.</div>
            </div>
          </div>
        </div>

        <!-- Footer buttons -->
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button id="mce-btn-cancel" style="
            background:#313244;color:#cdd6f4;border:1px solid #45475a;
            border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px;
          ">Cancel</button>
          <button id="mce-btn-apply" style="
            background:#89b4fa;color:#1e1e2e;border:none;
            border-radius:6px;padding:6px 20px;cursor:pointer;font-size:13px;font-weight:600;
          ">Apply</button>
        </div>
      </div>
    `;
  }

  // ── Resize canvas to fit container ────────────────────────
  _resizeCanvas() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const padding = 40;
    this.canvasW = Math.max(300, rect.width - padding);
    this.canvasH = Math.max(200, rect.height - padding);
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    this.maskW = Math.min(this.canvasW * 0.5, this.canvasH * 0.5, 512);
    this.maskH = this.maskW;
  }

  _onResize = () => {
    this._resizeCanvas();
  };

  // ── Bind DOM events ───────────────────────────────────────
  _bindEvents() {
    // Canvas mouse events
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });

    // Touch events (mobile/tablet)
    this.canvas.addEventListener("touchstart", this._onTouchStart, { passive: false });
    window.addEventListener("touchmove", this._onTouchMove, { passive: false });
    window.addEventListener("touchend", this._onTouchEnd);

    // Slider events
    this._bindSlider("mce-scale", WIDGET_SCALE, "mce-info-scale", (v) => parseFloat(v));
    this._bindSlider("mce-rotation", WIDGET_ROTATION, "mce-info-rotation", (v) => parseFloat(v).toFixed(1) + "°");
    this._bindSlider("mce-offset-x", WIDGET_OFFSET_X, "mce-info-offset-x", (v) => parseInt(v));
    this._bindSlider("mce-offset-y", WIDGET_OFFSET_Y, "mce-info-offset-y", (v) => parseInt(v));

    // Flip buttons
    this._bindFlipButton("mce-flip-h", WIDGET_FLIP_H);
    this._bindFlipButton("mce-flip-v", WIDGET_FLIP_V);

    // Action buttons
    this.overlay.querySelector("#mce-btn-apply").addEventListener("click", () => this.close(true));
    this.overlay.querySelector("#mce-btn-cancel").addEventListener("click", () => this.close(false));
    this.overlay.querySelector("#mce-btn-close").addEventListener("click", () => this.close(true));
    this.overlay.querySelector("#mce-btn-reset").addEventListener("click", () => this._resetAll());

    // Close on overlay click (but not on modal click)
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close(true);
    });

    // Keyboard shortcuts
    this._onKeyDown = (e) => {
      if (e.key === "Escape") this.close(true);
      if (e.key === "Enter" && !e.shiftKey) this.close(true);
      if (e.key === "r" && e.ctrlKey) {
        e.preventDefault();
        this._resetAll();
      }
    };
    window.addEventListener("keydown", this._onKeyDown);
  }

  _unbindEvents() {
    this.canvas?.removeEventListener("mousedown", this._onMouseDown);
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("mouseup", this._onMouseUp);
    this.canvas?.removeEventListener("wheel", this._onWheel);
    this.canvas?.removeEventListener("touchstart", this._onTouchStart);
    window.removeEventListener("touchmove", this._onTouchMove);
    window.removeEventListener("touchend", this._onTouchEnd);
    window.removeEventListener("keydown", this._onKeyDown);
  }

  // ── Slider binding ────────────────────────────────────────
  _bindSlider(sliderId, widgetName, infoId, formatFn) {
    const slider = this.overlay.querySelector(`#${sliderId}`);
    const info = this.overlay.querySelector(`#${infoId}`);
    if (!slider || !info) return;

    slider.addEventListener("input", () => {
      const val = formatFn ? formatFn(slider.value) : slider.value;
      this[this._widgetToProp(widgetName)] = typeof val === "string" ? parseFloat(val) : val;
      if (info) info.textContent = val;
    });
  }

  // ── Flip button binding ───────────────────────────────────
  _bindFlipButton(btnId, widgetName) {
    const btn = this.overlay.querySelector(`#${btnId}`);
    if (!btn) return;

    btn.addEventListener("click", () => {
      const prop = this._widgetToProp(widgetName);
      this[prop] = !this[prop];
      btn.classList.toggle("active", this[prop]);
      btn.style.background = this[prop]
        ? (widgetName === WIDGET_FLIP_H ? "#89b4fa" : "#a6e3a1")
        : "#313244";
      btn.style.color = this[prop] ? "#1e1e2e" : "#cdd6f4";
      btn.style.borderColor = this[prop]
        ? (widgetName === WIDGET_FLIP_H ? "#89b4fa" : "#a6e3a1")
        : "#45475a";
    });
  }

  // ── Map widget name to internal prop name ─────────────────
  _widgetToProp(name) {
    const map = {
      [WIDGET_SCALE]: "scale",
      [WIDGET_ROTATION]: "rotation",
      [WIDGET_FLIP_H]: "flipH",
      [WIDGET_FLIP_V]: "flipV",
      [WIDGET_OFFSET_X]: "offsetX",
      [WIDGET_OFFSET_Y]: "offsetY",
    };
    return map[name] || name;
  }

  // ── Reset all transforms ──────────────────────────────────
  _resetAll() {
    this.scale = 1.0;
    this.rotation = 0.0;
    this.flipH = false;
    this.flipV = false;
    this.offsetX = 0;
    this.offsetY = 0;

    // Update sliders
    const sliders = {
      "mce-scale": this.scale,
      "mce-rotation": this.rotation,
      "mce-offset-x": this.offsetX,
      "mce-offset-y": this.offsetY,
    };
    for (const [id, val] of Object.entries(sliders)) {
      const el = this.overlay?.querySelector(`#${id}`);
      if (el) el.value = val;
    }

    // Update flip buttons
    const flips = {
      "mce-flip-h": this.flipH,
      "mce-flip-v": this.flipV,
    };
    for (const [id, active] of Object.entries(flips)) {
      const el = this.overlay?.querySelector(`#${id}`);
      if (el) {
        el.classList.toggle("active", active);
        el.style.background = active ? "#89b4fa" : "#313244";
        el.style.color = active ? "#1e1e2e" : "#cdd6f4";
        el.style.borderColor = active ? "#89b4fa" : "#45475a";
      }
    }

    this._updateInfoPanel();
  }

  // ── Update info panel ─────────────────────────────────────
  _updateInfoPanel() {
    const infos = {
      "mce-info-scale": this.scale.toFixed(2),
      "mce-info-rotation": this.rotation.toFixed(1) + "°",
      "mce-info-offset-x": this.offsetX,
      "mce-info-offset-y": this.offsetY,
    };
    for (const [id, val] of Object.entries(infos)) {
      const el = this.overlay?.querySelector(`#${id}`);
      if (el) el.textContent = val;
    }
  }

  // ── Read state from node widgets ──────────────────────────
  readWidgets() {
    this.scale = getWidgetValue(this.node, WIDGET_SCALE, 1.0);
    this.rotation = getWidgetValue(this.node, WIDGET_ROTATION, 0.0);
    this.flipH = getWidgetValue(this.node, WIDGET_FLIP_H, false);
    this.flipV = getWidgetValue(this.node, WIDGET_FLIP_V, false);
    this.offsetX = getWidgetValue(this.node, WIDGET_OFFSET_X, 0);
    this.offsetY = getWidgetValue(this.node, WIDGET_OFFSET_Y, 0);
  }

  // ── Write state back to node widgets ──────────────────────
  writeWidgets() {
    setWidgetValue(this.node, WIDGET_SCALE, this.scale);
    setWidgetValue(this.node, WIDGET_ROTATION, this.rotation);
    setWidgetValue(this.node, WIDGET_FLIP_H, this.flipH);
    setWidgetValue(this.node, WIDGET_FLIP_V, this.flipV);
    setWidgetValue(this.node, WIDGET_OFFSET_X, Math.round(this.offsetX));
    setWidgetValue(this.node, WIDGET_OFFSET_Y, Math.round(this.offsetY));

    // Mark node as dirty so it shows "queued" state
    if (this.node.graph) {
      this.node.graph._version = (this.node.graph._version || 0) + 1;
    }
  }

  // ─────────────────────────────────────────────────────────
  //  Mouse events
  // ─────────────────────────────────────────────────────────
  _onMouseDown = (e) => {
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragOffsetXStart = this.offsetX;
    this.dragOffsetYStart = this.offsetY;
    this.canvas.style.cursor = "grabbing";
    e.preventDefault();
  };

  _onMouseMove = (e) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    // Pixel-to-pixel mapping: canvas pixels represent a fraction of the image
    // The scale affects sensitivity — at higher zoom, each pixel moves less
    const sensitivity = 1.0 / Math.max(this.scale, 0.1);
    this.offsetX = Math.round(this.dragOffsetXStart + dx * sensitivity);
    this.offsetY = Math.round(this.dragOffsetYStart + dy * sensitivity);

    // Clamp
    this.offsetX = Math.max(-8192, Math.min(8192, this.offsetX));
    this.offsetY = Math.max(-8192, Math.min(8192, this.offsetY));

    // Update sliders
    const sliderX = this.overlay?.querySelector("#mce-offset-x");
    const sliderY = this.overlay?.querySelector("#mce-offset-y");
    if (sliderX) sliderX.value = this.offsetX;
    if (sliderY) sliderY.value = this.offsetY;

    this._updateInfoPanel();
  };

  _onMouseUp = () => {
    if (this.dragging) {
      this.dragging = false;
      if (this.canvas) this.canvas.style.cursor = "grab";
    }
  };

  // ─────────────────────────────────────────────────────────
  //  Wheel event (zoom / rotate)
  // ─────────────────────────────────────────────────────────
  _onWheel = (e) => {
    e.preventDefault();

    if (e.shiftKey) {
      // Shift+Scroll → Rotate
      this.rotation += e.deltaY > 0 ? -5 : 5;
      this.rotation = Math.max(-180, Math.min(180, this.rotation));
      this.rotation = Math.round(this.rotation * 2) / 2; // snap to 0.5

      const slider = this.overlay?.querySelector("#mce-rotation");
      if (slider) slider.value = this.rotation;
    } else {
      // Scroll → Zoom
      const zoomSpeed = 0.05;
      const delta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
      this.scale = Math.max(0.01, Math.min(10.0, this.scale + delta));
      this.scale = Math.round(this.scale * 100) / 100;

      const slider = this.overlay?.querySelector("#mce-scale");
      if (slider) slider.value = this.scale;
    }

    this._updateInfoPanel();
  };

  // ─────────────────────────────────────────────────────────
  //  Touch events
  // ─────────────────────────────────────────────────────────
  _onTouchStart = (e) => {
    if (e.touches.length === 1) {
      this.dragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
      this.dragOffsetXStart = this.offsetX;
      this.dragOffsetYStart = this.offsetY;
    }
    e.preventDefault();
  };

  _onTouchMove = (e) => {
    if (!this.dragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - this.dragStartX;
    const dy = e.touches[0].clientY - this.dragStartY;
    const sensitivity = 1.0 / Math.max(this.scale, 0.1);
    this.offsetX = Math.round(this.dragOffsetXStart + dx * sensitivity);
    this.offsetY = Math.round(this.dragOffsetYStart + dy * sensitivity);
    this.offsetX = Math.max(-8192, Math.min(8192, this.offsetX));
    this.offsetY = Math.max(-8192, Math.min(8192, this.offsetY));
    e.preventDefault();
  };

  _onTouchEnd = () => {
    this.dragging = false;
  };

  // ─────────────────────────────────────────────────────────
  //  Render loop
  // ─────────────────────────────────────────────────────────
  _startRender() {
    const loop = () => {
      this._render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopRender() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  // ── Draw a frame ──────────────────────────────────────────
  _render() {
    const ctx = this.ctx;
    const W = this.canvasW;
    const H = this.canvasH;

    if (!ctx || W <= 0 || H <= 0) return;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#11111b";
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;

    // ── Save context and apply image-space transforms ──
    ctx.save();
    ctx.translate(cx, cy);

    // Apply the SAME transforms as the user settings
    // (because the grid represents the background image)
    ctx.scale(this.scale, this.scale);
    ctx.rotate((this.rotation * Math.PI) / 180);

    if (this.flipH) ctx.scale(-1, 1);
    if (this.flipV) ctx.scale(1, -1);

    ctx.translate(this.offsetX, this.offsetY);

    // ── Draw the grid (represents the background image) ──
    this._drawGrid(ctx, W, H);

    ctx.restore();

    // ── Draw the mask outline (fixed in center) ──
    const mw = this.maskW;
    const mh = this.maskH;
    const mx = cx - mw / 2;
    const my = cy - mh / 2;

    // Semi-transparent overlay outside the mask
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, W, my);                          // top
    ctx.fillRect(0, my + mh, W, H - (my + mh));         // bottom
    ctx.fillRect(0, my, mx, mh);                        // left
    ctx.fillRect(mx + mw, my, W - (mx + mw), mh);       // right

    // Mask border
    ctx.strokeStyle = "#89b4fa";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(mx, my, mw, mh);
    ctx.setLineDash([]);

    // Mask corner markers
    const cornerLen = 20;
    ctx.strokeStyle = "#cba6f7";
    ctx.lineWidth = 3;
    // Top-left
    ctx.beginPath();
    ctx.moveTo(mx, my + cornerLen);
    ctx.lineTo(mx, my);
    ctx.lineTo(mx + cornerLen, my);
    ctx.stroke();
    // Top-right
    ctx.beginPath();
    ctx.moveTo(mx + mw - cornerLen, my);
    ctx.lineTo(mx + mw, my);
    ctx.lineTo(mx + mw, my + cornerLen);
    ctx.stroke();
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(mx, my + mh - cornerLen);
    ctx.lineTo(mx, my + mh);
    ctx.lineTo(mx + cornerLen, my + mh);
    ctx.stroke();
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(mx + mw - cornerLen, my + mh);
    ctx.lineTo(mx + mw, my + mh);
    ctx.lineTo(mx + mw, my + mh - cornerLen);
    ctx.stroke();

    // Mask label
    ctx.fillStyle = "#cba6f7";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Mask Region (${Math.round(mw)}×${Math.round(mh)})`, cx, my - 8);
    ctx.textAlign = "start";

    // Crosshair at center
    ctx.strokeStyle = "rgba(203, 166, 247, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, my);
    ctx.lineTo(cx, my + mh);
    ctx.moveTo(mx, cy);
    ctx.lineTo(mx + mw, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Draw a checkerboard grid ──────────────────────────────
  _drawGrid(ctx, W, H) {
    // Determine grid extent to cover the canvas
    // The grid is drawn in "image space" — after transforms
    // We need to cover at least the visible area
    const extent = Math.max(W, H) * 2;
    const step = 64;

    const startX = -extent;
    const startY = -extent;
    const endX = extent;
    const endY = extent;

    // Checkerboard cells
    for (let y = startY; y < endY; y += step) {
      for (let x = startX; x < endX; x += step) {
        const isEven = ((x / step + y / step) & 1) === 0;
        ctx.fillStyle = isEven ? "#2a2a3a" : "#1e1e2e";
        ctx.fillRect(x, y, step, step);
      }
    }

    // Grid lines
    ctx.strokeStyle = "rgba(137, 180, 250, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += step) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += step) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();

    // Center crosshair (image center)
    ctx.strokeStyle = "rgba(137, 180, 250, 0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-50, 0);
    ctx.lineTo(50, 0);
    ctx.moveTo(0, -50);
    ctx.lineTo(0, 50);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = "#89b4fa";
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    // Image center label
    ctx.fillStyle = "#89b4fa";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Image Center", 0, -12);
    ctx.textAlign = "start";
  }
}

// ─────────────────────────────────────────────────────────────
//  Extension Registration
// ─────────────────────────────────────────────────────────────
app.registerExtension({
  name: EXTENSION_NAME,

  beforeRegisterNodeDef(nodeType, nodeData) {
    // Only apply to our node type
    if (nodeData.name !== NODE_TYPE) return;
  },

  nodeCreated(node) {
    // Only apply to our node type
    if (node.type !== NODE_TYPE) return;

    // Add the "Open Canvas Editor" button widget
    // We use a button-like approach by adding a custom drawing on the node
    // and handling click events

    // Store a reference to the modal instance
    node._canvasEditorModal = null;

    // Add a custom button via onDrawForeground
    const origOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      // Call original if exists
      if (origOnDrawForeground) {
        origOnDrawForeground.apply(this, arguments);
      }

      // Draw the "Open Editor" button at the bottom of the node
      if (this.flags?.collapsed) return;

      const w = this.size[0];
      const h = this.size[1];
      const btnW = 160;
      const btnH = 28;
      const btnX = (w - btnW) / 2;
      const btnY = h - btnH - 8;

      // Save button position for hit detection
      this._mceBtnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };

      // Button background
      const radius = 6;
      ctx.fillStyle = "#89b4fa";
      ctx.beginPath();
      ctx.moveTo(btnX + radius, btnY);
      ctx.lineTo(btnX + btnW - radius, btnY);
      ctx.quadraticCurveTo(btnX + btnW, btnY, btnX + btnW, btnY + radius);
      ctx.lineTo(btnX + btnW, btnY + btnH - radius);
      ctx.quadraticCurveTo(btnX + btnW, btnY + btnH, btnX + btnW - radius, btnY + btnH);
      ctx.lineTo(btnX + radius, btnY + btnH);
      ctx.quadraticCurveTo(btnX, btnY + btnH, btnX, btnY + btnH - radius);
      ctx.lineTo(btnX, btnY + radius);
      ctx.quadraticCurveTo(btnX, btnY, btnX + radius, btnY);
      ctx.closePath();
      ctx.fill();

      // Button text
      ctx.fillStyle = "#1e1e2e";
      ctx.font = "bold 12px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🎨 Open Canvas Editor", btnX + btnW / 2, btnY + btnH / 2);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    };

    // Handle mouse down to detect button click
    const origOnMouseDown = node.onMouseDown;
    node.onMouseDown = function (e, localPos, canvas) {
      if (origOnMouseDown) {
        const handled = origOnMouseDown.apply(this, arguments);
        if (handled) return true;
      }

      // Check if the click is on our button
      const btn = this._mceBtnBounds;
      if (!btn) return false;

      const lx = localPos[0];
      const ly = localPos[1];

      if (lx >= btn.x && lx <= btn.x + btn.w && ly >= btn.y && ly <= btn.y + btn.h) {
        // Open the canvas editor modal
        if (!this._canvasEditorModal) {
          this._canvasEditorModal = new CanvasEditorModal(this);
        }
        this._canvasEditorModal.readWidgets();
        this._canvasEditorModal.open();
        return true; // consume the event
      }

      return false;
    };

    // Clean up on node removal
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      if (this._canvasEditorModal) {
        this._canvasEditorModal.close(false);
        this._canvasEditorModal = null;
      }
      if (origOnRemoved) {
        origOnRemoved.apply(this, arguments);
      }
    };
  },
});
