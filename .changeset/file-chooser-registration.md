---
"@hussmartinez/video-sdk": patch
---

`VideoToolbar` registers its file picker with the editor through a function, instead of writing to a ref the editor shares. Nothing changes for users: the toolbar's "Add videos" button still opens the picker.
