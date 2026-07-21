"""
ComfyUI Mask Canvas Image Node
A custom node that provides canvas-like visual editing for positioning
an image behind a mask region, with support for scale, rotation, flip, and offset.
"""

from .py.nodes.mask_canvas_editor import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
