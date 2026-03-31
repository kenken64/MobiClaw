export class PngRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._frameCount = 0;
    this._lastFpsTime = performance.now();
    this.clientFps = 0;
  }

  async renderFrame(arrayBuffer) {
    // Skip the 1-byte prefix
    const imageData = arrayBuffer.slice(1);
    const blob = new Blob([imageData], { type: 'image/png' });

    try {
      const bitmap = await createImageBitmap(blob);

      // Resize canvas to match device aspect ratio (only if changed)
      if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
      }

      this.ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // Track client-side FPS
      this._frameCount++;
      const now = performance.now();
      if (now - this._lastFpsTime >= 1000) {
        this.clientFps = this._frameCount;
        this._frameCount = 0;
        this._lastFpsTime = now;
      }
    } catch (e) {
      // Likely corrupt frame, skip
    }
  }
}
