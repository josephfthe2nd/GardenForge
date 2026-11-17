# Gallery import repair (1.3.2 development)

The user reported that the gallery picker opens but selected photos do not appear.
A regression test reproduced one failure: an undecodable first photo aborts the entire batch,
so later readable images are never imported. The user's exact photo format is not yet known.

Changes:
- Copy the chooser's FileList before async processing, disabling controls, or updating markup.
- Try the native HTML image decoder before ImageBitmap, retaining an ImageBitmap fallback.
  Safari documents native HEIC support; actual codec support in the embedded browser is not assumed.
- Bound native decode, ImageBitmap fallback, and JPEG encoding; release canvas/image resources.
- Continue past per-photo errors, show progress and file-specific errors beside the controls.
- Handle empty/iCloud-unavailable files and unsupported HEIC with actionable messages.
- Keep readable photos in memory when device storage fails so they can still be exported.
- Leave a completed scan and its original photo untouched when all imports/a retake fail.

No garden/scan schema changes, dependencies, external upload services, or provider calls are added.
Native conversion and JPEG preparation stay on the device. Existing six-photo limit remains.

Validation includes actual filechooser activation, multiple selection, mixed valid/invalid files,
ImageBitmap unavailable, stalled decoder, failed retake, storage failure, and the full existing
320px/390px/desktop/offline regression suite. iPhone Photos, HEIC decode on the user's device,
and iCloud download behavior need owner confirmation; Chromium emulation cannot prove them.

Native format reference:
https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
