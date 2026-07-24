"""Custom API routes for Mask Canvas Editor."""

import os
import numpy as np
from PIL import Image

import folder_paths
from server import PromptServer
from aiohttp import web


def get_node_from_prompt(node_id):
    """Try to find node info from the latest cached prompt."""
    try:
        prompt = PromptServer.instance.last_prompt
        if prompt and str(node_id) in prompt:
            return prompt[str(node_id)]
    except Exception:
        pass
    return None


def resolve_input_filename(node_info, input_key):
    """Read a widget value from a node_info dict."""
    if not node_info:
        return None
    inputs = node_info.get("inputs", {})
    val = inputs.get(input_key)
    if isinstance(val, str) and val:
        return val
    return None


def find_image_file(filename):
    """Search for an image file in ComfyUI's input directory structure."""
    if not filename:
        return None
    input_dir = folder_paths.get_input_directory()
    for dirpath in [input_dir]:
        full = os.path.join(dirpath, filename)
        if os.path.isfile(full):
            return full
        for root, _dirs, files in os.walk(dirpath):
            if filename in files:
                return os.path.join(root, filename)
    return None


def file_response(filename):
    """Build a response dict for a found image file."""
    full = find_image_file(filename)
    if not full:
        return None
    w, h = 0, 0
    try:
        with Image.open(full) as img:
            w, h = img.width, img.height
    except Exception:
        pass
    return {
        "url": f"/view?filename={filename}&type=input",
        "width": w,
        "height": h,
    }


def compute_mask_bbox(filename):
    """
    Open a mask image file, find the non-zero region,
    return {width, height} of the bounding box.
    Returns full image dimensions if mask is all-zero.
    """
    full = find_image_file(filename)
    if not full:
        return None
    try:
        with Image.open(full) as img:
            arr = np.array(img.convert("L"))
    except Exception:
        return None

    h, w = arr.shape
    rows = np.any(arr > 128, axis=1)
    cols = np.any(arr > 128, axis=0)

    if rows.any() and cols.any():
        y_indices = np.where(rows)[0]
        x_indices = np.where(cols)[0]
        bbox_h = int(y_indices[-1] - y_indices[0] + 1)
        bbox_w = int(x_indices[-1] - x_indices[0] + 1)
    else:
        bbox_w, bbox_h = w, h

    return {"width": bbox_w, "height": bbox_h}


@PromptServer.instance.routes.get("/mce/load")
async def mce_load(request):
    """
    Load image + mask preview for MaskCanvasEditor.

    Query params:
      image_filename    - LoadImage widget value (works without queue)
      mask_filename     - LoadImage widget value for mask
      image_node_id     - fallback: node ID from prompt cache
      mask_node_id      - fallback: node ID from prompt cache

    Returns:
      { success: true, image: {url, width, height},
        mask: {url, width, height} }
      mask.width / mask.height are the ACTUAL bbox of non-zero mask pixels,
      not the full mask image frame dimensions.
    """
    try:
        image_node_id = request.query.get("image_node_id", "")
        mask_node_id = request.query.get("mask_node_id", "")
        image_filename = request.query.get("image_filename", "")
        mask_filename = request.query.get("mask_filename", "")

        img_result = None
        mask_result = None

        # ── Direct filenames from LoadImage widgets ──
        if image_filename:
            img_result = file_response(image_filename)

        if mask_filename:
            mask_result = file_response(mask_filename)
            mask_bbox = compute_mask_bbox(mask_filename)
            if mask_bbox and mask_result:
                mask_result["width"] = mask_bbox["width"]
                mask_result["height"] = mask_bbox["height"]

        # ── Fallback: prompt cache (needs prior queue) ──
        if not img_result and image_node_id:
            info = get_node_from_prompt(image_node_id)
            if info:
                fname = resolve_input_filename(info, "image")
                if fname:
                    img_result = file_response(fname)

        if not mask_result and mask_node_id:
            info = get_node_from_prompt(mask_node_id)
            fname = None
            if info:
                fname = resolve_input_filename(info, "image")
            if not fname and image_node_id and mask_node_id == image_node_id:
                info = get_node_from_prompt(image_node_id)
                if info:
                    fname = resolve_input_filename(info, "image")
            if fname:
                mask_result = file_response(fname)
                mask_bbox = compute_mask_bbox(fname)
                if mask_bbox and mask_result:
                    mask_result["width"] = mask_bbox["width"]
                    mask_result["height"] = mask_bbox["height"]

        # No separate mask — use image full frame as mask
        if img_result and not mask_result:
            mask_result = {
                "url": img_result["url"],
                "width": img_result["width"],
                "height": img_result["height"],
            }

        if img_result:
            return web.json_response({
                "success": True,
                "image": img_result,
                "mask": mask_result or img_result,
            })
        else:
            return web.json_response({
                "success": False,
                "error": "Cannot find upstream image. "
                         "Connect a LoadImage directly or queue once.",
            })

    except Exception as e:
        return web.json_response({
            "success": False,
            "error": str(e),
        })
