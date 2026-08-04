# Implementation prompt: image objects in the note editor

Paste the block below into Claude Code with the repo open. Adjust file paths and the storage section to match your codebase before running it.

---

## PROMPT

Add support for image objects in the Nueco note editor. Images can be captured from the camera or chosen from the gallery, and once added they behave as free-floating objects layered over and around the text box that the user can drag, rotate and resize.

### Context

React Native / Expo app. FastAPI backend on Railway, MongoDB Atlas. The app is local-first: all user actions write to local storage and update the UI immediately, with background sync. Nothing in the user's critical path waits on the network.

Read the existing note editor component and the sync layer before writing any code, and follow the existing patterns for local writes and sync queueing.

### Core requirements

1. **Add image from camera or gallery.** Use `expo-image-picker` with `allowsEditing: false`. Do not present a crop UI at any point.

2. **Never crop or alter aspect ratio.** Portrait stays portrait, landscape stays landscape. Capture the asset's intrinsic width and height at pick time and preserve that ratio through every transform. Scaling must be uniform. Never scale X and Y independently.

3. **Free positioning.** The image is not inline with the text. It sits in an object layer above the text box and can be positioned anywhere within the note canvas, including overlapping the text.

4. **Gestures:** drag to move, pinch to scale, two-finger twist to rotate. All three must work simultaneously, not as separate modes.

5. **Multiple images per note**, with sensible z-ordering.

### Technical approach

Use `react-native-gesture-handler` v2 and `react-native-reanimated` v3.

- Compose gestures with `Gesture.Simultaneous(pan, pinch, rotation)` so a user can move, scale and rotate in one continuous interaction
- All transform values must be `useSharedValue` driven and applied via `useAnimatedStyle`. Transforms run on the UI thread. Do not drive them through React state or `setState` on gesture updates, or it will be janky
- Persist to the note only on gesture end, not on every frame
- Apply transforms in the order: translate, rotate, scale

### Data model

Add an `objects` array to the note document. Each entry:

```
{
  id: string,
  type: "image",
  local_uri: string,        // available immediately after pick
  remote_url: string|null,  // populated after upload
  intrinsic_width: number,  // from the picker asset
  intrinsic_height: number,
  x: number,                // normalized 0..1, relative to canvas width
  y: number,                // normalized 0..1, relative to canvas width
  scale: number,            // uniform, relative to a base display width
  rotation: number,         // radians
  z: number,
  upload_status: "pending" | "uploaded" | "failed"
}
```

**Store positions normalized against canvas width, not in absolute pixels.** A note authored on a phone must render correctly on a tablet or a different screen size. Convert to pixels at render time using the measured canvas width.

Use canvas width for both axes so the aspect ratio of the layout is preserved rather than stretched.

### EXIF orientation

Photos from a device camera frequently carry EXIF rotation metadata. If it is not applied, portrait photos display sideways. Normalize orientation on import using `expo-image-manipulator` (a no-op manipulation is enough to bake in the correct orientation), and verify with a portrait photo taken on a real Android device, not the simulator.

This is the most likely bug in this feature. Test it explicitly.

### Selection and text editing

- Tap an image to select it. Show a selection outline with a delete control and a rotate/resize handle
- Selecting an image dismisses the keyboard and blurs the text input
- Tap anywhere on the text area to deselect and return to text editing
- Selecting an image brings it to the front
- Deleting an object is undoable via a snackbar, consistent with the note delete pattern

### Local-first behaviour

- Adding an image writes the object to the local note and renders from `local_uri` immediately. Do not wait for upload
- Upload happens in the background via the existing sync queue
- Once uploaded, populate `remote_url` and keep rendering the local file while it exists
- On upload failure, retry. Show a subtle indicator on the object, never a blocking error
- The note must remain fully usable and editable while uploads are pending

### Image storage

Before uploading, downscale to a maximum dimension of 2048px and compress to JPEG at reasonable quality, preserving aspect ratio. Original camera files are large and will make sync slow and storage costly.

Upload to the existing file storage. Use access-controlled URLs, not public or guessable ones. Deleting a note or an object must delete the associated file.

### Constraints

- Do not add a rich text editor library. The text box stays as it is; images are a separate layer
- Do not implement cropping, filters or drawing
- Clamp scale to sensible bounds (roughly 0.2x to 5x) so images cannot be lost off-canvas or blown up to nothing
- Keep objects within the note canvas bounds on drag end, or at minimum ensure some part remains reachable

### Acceptance criteria

- [ ] A portrait photo from the camera displays portrait, uncropped, correctly oriented
- [ ] A landscape photo displays landscape, uncropped
- [ ] Drag, pinch and rotate all work in a single continuous gesture
- [ ] Aspect ratio is identical before and after any transform
- [ ] Gestures are smooth on a mid-range Android device
- [ ] Positions survive app restart and render identically
- [ ] A note authored on a phone renders with correct relative positions on a tablet
- [ ] Adding an image in airplane mode works, and the image uploads when connectivity returns
- [ ] Deleting an object is undoable
- [ ] Deleting a note removes its image files from storage

Write tests for the normalized coordinate conversion and the aspect ratio preservation logic.

---

## After implementation

Three things this feature touches that live elsewhere in the repo:

1. **Export.** Note export currently assumes text. Decide whether markdown export references images, embeds them, or omits them. Update `features-multiselect-export-lock.md`.

2. **Storage audit.** Images are a new data category. Add them to the data map: where files live, retention, deletion completeness, whether URLs are access-controlled.

3. **Enrichment.** Decide whether images are sent to the model. Default to no. If yes, that is a new disclosure for the privacy policy and a new cost line.
