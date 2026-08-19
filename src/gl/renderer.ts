/**
 * Placeholder for task 2.2 (WebGL2 renderer: compositing camera frame +
 * drawn layers). Only the `Surface` type exists so far — `core/document.ts`
 * needs it as a type-only dependency (a Cel holds a Surface), same
 * boundary as Trace: `core/` never imports WebGL execution, only this type.
 *
 * A Surface is a texture + its FBO, sized to the document. `version` bumps
 * on every write — it's what invalidates thumbnail caches once those exist.
 */
export interface Surface {
  width: number;
  height: number;
  texture: WebGLTexture;
  version: number;
}
