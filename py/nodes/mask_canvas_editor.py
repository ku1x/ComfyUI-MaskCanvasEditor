"""
Mask Canvas Editor Node
A fully graphical ComfyUI node — the node body itself is an interactive canvas editor.
Position a background image behind a mask region with direct visual manipulation:
drag to pan, scroll to zoom, shift+scroll to rotate, buttons to flip.
No parameter sliders needed — everything is controlled through the canvas.

The input image is saved as a preview so the frontend canvas shows the actual
image as the background rather than a placeholder grid.
"""

import torch
import torch.nn.functional as F
import math
import json
import os
import numpy as np
from PIL import Image
import folder_paths


class MaskCanvasEditor:
    """
    Interactive canvas editor — the node body IS the editor.

    The mask defines a fixed "window" at the center. The background image
    is transformed behind it. All parameters (scale, rotation, flip, offset)
    are controlled by direct canvas interaction, not slider widgets.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
                "image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "transform_state": ("STRING", {"default": "{}"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("cropped_image", "cropped_mask")
    FUNCTION = "process"
    CATEGORY = "Mask/CanvasEditor"
    OUTPUT_NODE = False
    DESCRIPTION = (
        "Interactive canvas editor — the node body is a visual canvas. "
        "Drag to pan the background image behind the mask, scroll to zoom, "
        "shift+scroll to rotate. No sliders needed."
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        ts = kwargs.get("transform_state", "{}")
        return ts

    # ------------------------------------------------------------------
    #  Helper: bounding box from a binary mask
    # ------------------------------------------------------------------
    @staticmethod
    def _get_bbox(mask: torch.Tensor):
        rows = torch.any(mask > 0.5, dim=1)
        cols = torch.any(mask > 0.5, dim=0)

        if rows.any() and cols.any():
            row_indices = torch.where(rows)[0]
            col_indices = torch.where(cols)[0]
            y_min = row_indices[0].item()
            y_max = row_indices[-1].item() + 1
            x_min = col_indices[0].item()
            x_max = col_indices[-1].item() + 1
        else:
            y_min, y_max = 0, mask.shape[0]
            x_min, x_max = 0, mask.shape[1]

        return y_min, y_max, x_min, x_max

    # ------------------------------------------------------------------
    #  Helper: build the sampling grid
    # ------------------------------------------------------------------
    @staticmethod
    def _build_sampling_grid(
        bbox_h: int, bbox_w: int,
        img_h: int, img_w: int,
        y_min: int, y_max: int, x_min: int, x_max: int,
        scale: float, rotation: float,
        flip_h: bool, flip_v: bool,
        offset_x: int, offset_y: int,
        device: torch.device,
    ):
        bbox_cy = (y_min + y_max) / 2.0
        bbox_cx = (x_min + x_max) / 2.0
        img_cy = img_h / 2.0
        img_cx = img_w / 2.0

        theta_rad = math.radians(rotation)
        cos_t = math.cos(theta_rad)
        sin_t = math.sin(theta_rad)

        fh = -1.0 if flip_h else 1.0
        fv = -1.0 if flip_v else 1.0

        oy, ox = torch.meshgrid(
            torch.arange(bbox_h, dtype=torch.float32, device=device),
            torch.arange(bbox_w, dtype=torch.float32, device=device),
            indexing="ij",
        )

        ox_abs = ox + x_min
        oy_abs = oy + y_min

        rx = ox_abs - bbox_cx
        ry = oy_abs - bbox_cy

        rx_t = rx - offset_x
        ry_t = ry - offset_y

        rx_r = rx_t * cos_t + ry_t * sin_t
        ry_r = -rx_t * sin_t + ry_t * cos_t

        rx_s = rx_r / max(scale, 0.001)
        ry_s = ry_r / max(scale, 0.001)

        rx_f = rx_s * fh
        ry_f = ry_s * fv

        ix = rx_f + img_cx
        iy = ry_f + img_cy

        gx = (ix / max(img_w - 1, 1)) * 2.0 - 1.0
        gy = (iy / max(img_h - 1, 1)) * 2.0 - 1.0

        return torch.stack([gx, gy], dim=-1).unsqueeze(0)

    # ------------------------------------------------------------------
    #  Save input image preview for the frontend canvas
    # ------------------------------------------------------------------
    @staticmethod
    def _save_preview(image: torch.Tensor, unique_id: str) -> str:
        """
        Save a downsampled version of the input image to ComfyUI's temp directory.
        Returns the filename.
        """
        # Get first frame: (H, W, C) float [0,1]
        img_np = image[0].cpu().numpy()

        h, w = img_np.shape[:2]

        # Downsample for preview (max edge = 1024px)
        max_size = 1024
        if max(h, w) > max_size:
            ratio = max_size / max(h, w)
            new_w = max(1, int(w * ratio))
            new_h = max(1, int(h * ratio))
            img_pil = Image.fromarray((img_np * 255).clip(0, 255).astype(np.uint8))
            img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)
        else:
            img_pil = Image.fromarray((img_np * 255).clip(0, 255).astype(np.uint8))

        # Save to ComfyUI temp folder
        filename = f"mce_bg_{unique_id}.png"
        filepath = os.path.join(folder_paths.get_temp_directory(), filename)
        img_pil.save(filepath, compress_level=1)
        return filename

    # ------------------------------------------------------------------
    #  Main processing
    # ------------------------------------------------------------------
    def process(
        self,
        mask: torch.Tensor,
        image: torch.Tensor,
        transform_state: str = "{}",
        unique_id: str = "0",
    ):
        """
        Args:
            mask:             (B, H, W) mask defining the crop region
            image:            (B, H, W, C) background image
            transform_state:  JSON string from the JS canvas editor
            unique_id:        ComfyUI node ID (hidden input)

        Returns:
            cropped_image: (B, H', W', C)
            cropped_mask:  (B, H', W')
        """
        # Parse transform state from JS frontend
        state = json.loads(transform_state) if transform_state else {}
        scale = float(state.get("scale", 1.0))
        rotation = float(state.get("rotation", 0.0))
        flip_h = bool(state.get("flipH", False))
        flip_v = bool(state.get("flipV", False))
        offset_x = int(state.get("offsetX", 0))
        offset_y = int(state.get("offsetY", 0))

        # Save input image preview for the frontend canvas
        preview_filename = self._save_preview(image, unique_id)

        batch_size = mask.shape[0]
        device = image.device

        cropped_images = []
        cropped_masks = []

        for b in range(batch_size):
            m = mask[b]
            img = image[b]

            img_h, img_w = img.shape[0], img.shape[1]

            y_min, y_max, x_min, x_max = self._get_bbox(m)
            bbox_h = y_max - y_min
            bbox_w = x_max - x_min

            m_cropped = m[y_min:y_max, x_min:x_max]

            grid = self._build_sampling_grid(
                bbox_h=bbox_h, bbox_w=bbox_w,
                img_h=img_h, img_w=img_w,
                y_min=y_min, y_max=y_max, x_min=x_min, x_max=x_max,
                scale=scale, rotation=rotation,
                flip_h=flip_h, flip_v=flip_v,
                offset_x=offset_x, offset_y=offset_y,
                device=device,
            )

            img_input = img.permute(2, 0, 1).unsqueeze(0)

            sampled = F.grid_sample(
                img_input, grid,
                mode="bilinear", padding_mode="zeros", align_corners=True,
            )

            sampled = sampled.squeeze(0).permute(1, 2, 0)

            mask_expanded = m_cropped.unsqueeze(-1)
            sampled_masked = sampled * mask_expanded

            cropped_images.append(sampled_masked)
            cropped_masks.append(m_cropped)

        return {
            "ui": {
                "mce_preview": [{
                    "filename": preview_filename,
                    "subfolder": "",
                    "type": "temp",
                }],
            },
            "result": (
                torch.stack(cropped_images, dim=0),
                torch.stack(cropped_masks, dim=0),
            ),
        }


NODE_CLASS_MAPPINGS = {
    "MaskCanvasEditor": MaskCanvasEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MaskCanvasEditor": "Mask Canvas Editor",
}
