# Implementation prompt: draw feature in the note editor

Paste the block below into Claude Code with the repo open. Assumes the image objects feature from `prompt-image-objects-in-editor.md` is already implemented, since drawings reuse the same object layer.

---

## PROMPT

Add a freehand drawing feature to the Nueco note editor. The user can draw anywhere on the note canvas, and a completed drawing becomes an object that behaves exactly like an image object: draggable, rotatable and resizable, positioned freely around the text box.

### Context

React Native / Expo app. Local-first architecture: all user actions write locally and update the UI immediately, with background sync. The note editor already supports image objects rendered in a transform layer above the text box.

Read the existing image object implementation first. Drawings must reuse the same object layer, the same gesture composition, and the same normalized coordinate system. Do not build a parallel system.

### Core requirements

1. **Vector strokes, not a bitmap.** Store the actual stroke points. Never rasterize to PNG for storage. This is what makes resizing lossless, undo per stroke possible, and storage cheap.

2. **Draw mode.** The user enters draw mode explicitly, draws freely on the canvas, and exits. On exit, the session's strokes are grouped into a single drawing object with a computed bounding box.

3. **Once created, a drawing is an object.** It supports the same drag, pinch-scale and twist-rotate gestures as images, with uniform scaling only.

4. **Multiple drawings per note.** Entering draw mode again creates a new object rather than appending to the previous one.

### Technical approach

Use `@shopify/react-native-skia` for rendering. Do not use `react-native-svg` for active drawing (too slow with many strokes) or any WebView-based canvas.

- Render committed strokes and the in-progress stroke separately. Re-rendering every committed stroke on each touch move will drop frames
- Capture points on the UI thread via `react-native-gesture-handler`
- Smooth the path. Raw touch points produce visibly jagged lines. Interpolate with quadratic bezier or Catmull-Rom between sampled points
- Decimate points on stroke end using a distance threshold or Ramer-Douglas-Peucker. A long stroke can otherwise capture thousands of near-identical points

### Data model

A drawing is an entry in the note's existing `objects` array:

```
{
  id: string,
  type: "drawing",
  strokes: [
    {
      id: string,
      points: [[x, y], ...],   // normalized 0..1 within the drawing's own bounds
      color: string,
      width: number,           // relative to drawing bounds, not absolute px
      tool: "pen" | "highlighter"
    }
  ],
  aspect_ratio: number,        // width / height of the bounding box at creation
  x: number,                   // normalized 0..1, relative to canvas width
  y: number,
  scale: number,
  rotation: number,
  z: number
}
```

Points are normalized inside the drawing's own bounding box, so scaling the object is a pure transform with no re-computation of stroke data.

Stroke width must also be relative, so lines thicken proportionally when the drawing is scaled up. An absolute pixel width would make a scaled-up drawing look like hairlines.

**No file upload path.** Drawings live in the note document as JSON and sync through the existing note sync. They do not touch file storage. Cap total points per drawing (around 20,000) and split or warn beyond that.

### Bounding box

On exiting draw mode:

1. Compute the bounding box of all strokes in the session
2. Add a small padding margin so strokes are not clipped at the edge
3. Normalize all points relative to that box
4. Store `aspect_ratio` and set the object's initial position and scale so it renders exactly where the user drew it

If a session contains strokes far apart on the canvas, the bounding box will be large and mostly empty. Accept this for v1. Do not implement spatial clustering.

### Tools

Ship exactly these:

- **Pen.** Three widths, six colours. Opaque
- **Highlighter.** Translucent (around 0.4 alpha), wider, rendered beneath pen strokes within the same drawing
- **Eraser.** Stroke eraser only: tapping or dragging over a stroke removes that whole stroke. Do not attempt pixel-level erasing, which does not work with a vector model

Undo and redo are per stroke and are required, not optional. Drawing without undo is unusable.

### Mode management

The editor now has three interaction states: text editing, object manipulation, and drawing. This is the main UX risk in the feature.

- Draw mode is entered from an explicit toolbar control and shows a visible active state
- Entering draw mode dismisses the keyboard and deselects any selected object
- While in draw mode, all canvas touches draw. Objects are not selectable and text is not editable
- Exiting draw mode is a single obvious action (a done button), which commits the session as an object
- If the user exits draw mode with no strokes, create nothing

### Stylus and pressure

- If the pointer type is a stylus, use pressure (`force`) to modulate stroke width where available
- Basic palm rejection: while a stylus is in contact, ignore simultaneous finger touches
- Both are enhancements. Ship the feature working correctly with finger input first

### Constraints

- Do not build shape tools, fill, text-in-drawing, layers, or a colour picker beyond the fixed palette
- Do not rasterize for storage
- Do not add a separate full-screen drawing editor. Drawing happens in place on the note canvas

### Acceptance criteria

- [ ] Drawing feels smooth and responsive on a mid-range Android device, with no visible lag behind the finger
- [ ] Lines are smooth, not visibly segmented
- [ ] A completed drawing can be dragged, rotated and scaled like an image object
- [ ] Scaling a drawing up keeps lines crisp and proportionally thick, with no pixelation
- [ ] Undo removes the last stroke; redo restores it
- [ ] Stroke eraser removes whole strokes and is undoable
- [ ] Highlighter renders translucent and beneath pen strokes
- [ ] Drawings survive app restart and render identically
- [ ] A drawing authored on a phone renders correctly on a tablet
- [ ] Drawing works fully offline with no upload step
- [ ] Note document size stays reasonable after a long drawing session

Write tests for bounding box computation, point normalization, and the point decimation logic.

---

## After implementation

Three follow-ons, same as the image feature:

1. **Export.** Drawings need rasterizing for markdown or PDF export. Skia can snapshot a canvas to an image. JSON export should include the raw stroke data so drawings survive a round trip.

2. **Storage audit.** Drawings add no new file storage, which is a genuine simplification. But they do add content to the note document, so confirm they are covered by note deletion and are excluded from logs.

3. **Enrichment.** Handwriting recognition on drawings is a plausible future feature and a strong one for your user base. Default to off for now. It would be a new model call, a new cost line, and a new privacy disclosure.
