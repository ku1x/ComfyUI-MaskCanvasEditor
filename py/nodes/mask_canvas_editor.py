"""
Mask Canvas Editor Node
A ComfyUI node that provides canvas-like visual editing for positioning
an image behind a mask region.

The mask defines a crop region (window) that stays centered.
The input image serves as the background that can be transformed
(scale, rotate, flip, offset) behind the mask.
The output is the background image content cropped to the mask region,
including the mask's bounding box size.
"""

import torch
import torch.nn.functional as F
import math


class MaskCanvasEditor:
    """
    Canvas-like editor for positioning an image behind a mask.

    The mask remains centered as the "window" through which we view
    the background image. The background image can be scaled, rotated,
    flipped, and offset to position the desired content within the mask region.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
                "image": ("IMAGE",),
                "scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 10.0,
                        "step": 0.01,
                        "display": "slider",
                    },
                ),
                "rotation": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -180.0,
                        "max": 180.0,
                        "step": 0.5,
                        "display": "slider",
                    },
                ),
                "flip_horizontal": ("BOOLEAN", {"default": False}),
                "flip_vertical": ("BOOLEAN", {"default": False}),
                "offset_x": (
                    "INT",
                    {
                        "default": 0,
                        "min": -8192,
                        "max": 8192,
                        "step": 1,
                        "display": "slider",
                    },
                ),
                "offset_y": (
                    "INT",
                    {
                        "default": 0,
                        "min": -8192,
                        "max": 8192,
                        "step": 1,
                        "display": "slider",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("cropped_image", "cropped_mask")
    FUNCTION = "process"
    CATEGORY = "Mask/CanvasEditor"
    DESCRIPTION = (
        "A canvas-like editor for positioning a background image behind a mask region. "
        "The mask defines the crop window. You can scale, rotate, flip, and offset "
        "the background image to control what content appears within the mask. "
        "Use the 'Open Canvas Editor' button for interactive visual editing."
    )

    # ------------------------------------------------------------------
    #  Helper: bounding box from a binary mask
    # ------------------------------------------------------------------
    @staticmethod
    def _get_bbox(mask: torch.Tensor):
        """
        Return (y_min, y_max, x_min, x_max) for the non-zero region.
        If the mask is entirely zero, return the full image bounds.
        """
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
        bbox_h: int,
        bbox_w: int,
        img_h: int,
        img_w: int,
        y_min: int,
        y_max: int,
        x_min: int,
        x_max: int,
        scale: float,
        rotation: float,
        flip_h: bool,
        flip_v: bool,
        offset_x: int,
        offset_y: int,
        device: torch.device,
    ):
        """
        Build a (1, bbox_h, bbox_w, 2) grid for F.grid_sample.

        Each grid[y, x, :] gives the normalized [-1, 1] coordinate
        in the source image that should be sampled.

        The transformation chain (output pixel → source pixel):
          1. Output pixel in bbox-local coords
          2. Convert to absolute image coords
          3. Center relative to bbox center
          4. Apply inverse user transforms: translate, rotate, scale, flip
          5. Map to source image pixel coords
          6. Normalize to [-1, 1]
        """

        # Bounding-box center (in absolute image coordinates)
        bbox_cy = (y_min + y_max) / 2.0
        bbox_cx = (x_min + x_max) / 2.0

        # Image center
        img_cy = img_h / 2.0
        img_cx = img_w / 2.0

        # Rotation (inverse = rotate by -rotation)
        theta_rad = math.radians(rotation)
        cos_t = math.cos(theta_rad)
        sin_t = math.sin(theta_rad)

        # Flip factors (flip is its own inverse)
        fh = -1.0 if flip_h else 1.0
        fv = -1.0 if flip_v else 1.0

        # ------------------------------------------------------------------
        # Create output pixel coordinate grid
        # ------------------------------------------------------------------
        oy, ox = torch.meshgrid(
            torch.arange(bbox_h, dtype=torch.float32, device=device),
            torch.arange(bbox_w, dtype=torch.float32, device=device),
            indexing="ij",
        )

        # Convert to absolute coordinates in the original image space
        ox_abs = ox + x_min  # (H, W)
        oy_abs = oy + y_min  # (H, W)

        # Relative to bbox center
        rx = ox_abs - bbox_cx  # (H, W)
        ry = oy_abs - bbox_cy  # (H, W)

        # ---- Inverse translation ----
        rx_t = rx - offset_x
        ry_t = ry - offset_y

        # ---- Inverse rotation (rotate by -theta) ----
        # [ cos_t  sin_t] [rx_t]
        # [-sin_t  cos_t] [ry_t]
        rx_r = rx_t * cos_t + ry_t * sin_t
        ry_r = -rx_t * sin_t + ry_t * cos_t

        # ---- Inverse scaling ----
        rx_s = rx_r / scale
        ry_s = ry_r / scale

        # ---- Inverse flipping ----
        rx_f = rx_s * fh
        ry_f = ry_s * fv

        # Map to source image pixel coordinates
        ix = rx_f + img_cx  # (H, W)
        iy = ry_f + img_cy  # (H, W)

        # Normalize to [-1, 1] for grid_sample (align_corners=True convention)
        # pixel p ∈ [0, W-1]  →  g = (p / (W-1)) * 2 - 1
        gx = (ix / max(img_w - 1, 1)) * 2.0 - 1.0
        gy = (iy / max(img_h - 1, 1)) * 2.0 - 1.0

        # Stack into (1, H, W, 2) grid
        grid = torch.stack([gx, gy], dim=-1)  # (H, W, 2)
        grid = grid.unsqueeze(0)  # (1, H, W, 2)

        return grid

    # ------------------------------------------------------------------
    #  Main processing
    # ------------------------------------------------------------------
    def process(
        self,
        mask: torch.Tensor,
        image: torch.Tensor,
        scale: float,
        rotation: float,
        flip_horizontal: bool,
        flip_vertical: bool,
        offset_x: int,
        offset_y: int,
    ):
        """
        Args:
            mask:  (B, H, W)          - Mask defining the crop region
            image: (B, H, W, C)       - Background image to be manipulated
            scale: float               - Uniform scale factor
            rotation: float            - Rotation in degrees
            flip_horizontal: bool      - Horizontal flip
            flip_vertical: bool        - Vertical flip
            offset_x: int              - Horizontal offset in pixels
            offset_y: int              - Vertical offset in pixels

        Returns:
            cropped_image: (B, H', W', C)  - Transformed image cropped to mask bbox
            cropped_mask:  (B, H', W')     - Mask cropped to its bbox
        """
        batch_size = mask.shape[0]
        device = image.device

        cropped_images = []
        cropped_masks = []

        for b in range(batch_size):
            m = mask[b]  # (H, W)
            img = image[b]  # (H, W, C)

            img_h, img_w = img.shape[0], img.shape[1]

            # ---- Get bounding box ----
            y_min, y_max, x_min, x_max = self._get_bbox(m)
            bbox_h = y_max - y_min
            bbox_w = x_max - x_min

            # ---- Crop mask to bbox ----
            m_cropped = m[y_min:y_max, x_min:x_max]  # (bbox_h, bbox_w)

            # ---- Build sampling grid ----
            grid = self._build_sampling_grid(
                bbox_h=bbox_h,
                bbox_w=bbox_w,
                img_h=img_h,
                img_w=img_w,
                y_min=y_min,
                y_max=y_max,
                x_min=x_min,
                x_max=x_max,
                scale=scale,
                rotation=rotation,
                flip_h=flip_horizontal,
                flip_v=flip_vertical,
                offset_x=offset_x,
                offset_y=offset_y,
                device=device,
            )

            # ---- Sample the image ----
            # grid_sample needs input as (N, C, H_in, W_in)
            img_input = img.permute(2, 0, 1).unsqueeze(0)  # (1, C, img_h, img_w)

            sampled = F.grid_sample(
                img_input,
                grid,
                mode="bilinear",
                padding_mode="zeros",
                align_corners=True,
            )  # (1, C, bbox_h, bbox_w)

            sampled = sampled.squeeze(0).permute(1, 2, 0)  # (bbox_h, bbox_w, C)

            # ---- Apply mask ----
            # Expand mask to channel dimension
            mask_expanded = m_cropped.unsqueeze(-1)  # (bbox_h, bbox_w, 1)
            sampled_masked = sampled * mask_expanded

            cropped_images.append(sampled_masked)
            cropped_masks.append(m_cropped)

        # ---- Stack results ----
        cropped_image_batch = torch.stack(cropped_images, dim=0)  # (B, H_out, W_out, C)
        cropped_mask_batch = torch.stack(cropped_masks, dim=0)  # (B, H_out, W_out)

        return (cropped_image_batch, cropped_mask_batch)


# ------------------------------------------------------------------
#  Node registration mappings
# ------------------------------------------------------------------
NODE_CLASS_MAPPINGS = {
    "MaskCanvasEditor": MaskCanvasEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MaskCanvasEditor": "Mask Canvas Editor",
}
