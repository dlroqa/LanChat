// Downscales a chosen profile picture to a small square data URL.
//
// The avatar is embedded in the identity card that goes out with every discovery
// probe and `hello` frame, so it has to stay tiny. A 96px centre-cropped JPEG
// lands around 4-6 KB, which is cheap to put on the wire and still looks sharp
// on a retina display at the sizes we render.

const SIZE = 96;
const QUALITY = 0.78;

export function downscaleToAvatar(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');

        // Centre-crop to a square so portraits are not squashed.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);

        // JPEG has no alpha; fill first so transparent PNGs don't go black.
        const out = document.createElement('canvas');
        out.width = SIZE;
        out.height = SIZE;
        const octx = out.getContext('2d');
        octx.fillStyle = '#1b1f2a';
        octx.fillRect(0, 0, SIZE, SIZE);
        octx.drawImage(canvas, 0, 0);

        resolve(out.toDataURL('image/jpeg', QUALITY));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('could not read that image'));
    img.src = dataUrl;
  });
}
