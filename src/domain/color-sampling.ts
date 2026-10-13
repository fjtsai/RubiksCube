export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

// 每格取 9 個小區塊：中心 1 個加上外圈 8 個。
// 魔方品牌 logo 幾乎都印在貼紙正中央，外圈區塊能保證取到乾淨的貼紙底色；
// 之後用中位數 + 內群平均把 logo、反光、陰影這類離群像素排除。
const CELL_SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.28, 0],
  [-0.28, 0],
  [0, 0.28],
  [0, -0.28],
  [0.2, 0.2],
  [0.2, -0.2],
  [-0.2, 0.2],
  [-0.2, -0.2],
];

const INLIER_DISTANCE = 60;

export function sampleThreeByThreeFromVideo(video: HTMLVideoElement, canvas: HTMLCanvasElement): RgbColor[] {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("相機畫面尚未準備好");
  }

  return sampleThreeByThreeFromSource(video, width, height, canvas);
}

export function sampleThreeByThreeFromImage(image: HTMLImageElement, canvas: HTMLCanvasElement): RgbColor[] {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("測試照片尚未載入完成");
  }

  return sampleThreeByThreeFromSource(image, width, height, canvas);
}

export function sampleThreeByThreeFromSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  canvas: HTMLCanvasElement
): RgbColor[] {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("無法讀取影像畫面");
  }

  context.drawImage(source, 0, 0, width, height);

  const squareSize = Math.min(width, height) * 0.64;
  const left = (width - squareSize) / 2;
  const top = (height - squareSize) / 2;
  const cellSize = squareSize / 3;
  const patchRadius = Math.max(3, Math.round(cellSize * 0.055));
  const samples: RgbColor[] = [];

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const centerX = left + cellSize * (col + 0.5);
      const centerY = top + cellSize * (row + 0.5);
      const pixels: RgbColor[] = [];
      for (const [offsetX, offsetY] of CELL_SAMPLE_OFFSETS) {
        collectPatchPixels(
          context,
          Math.round(centerX + offsetX * cellSize),
          Math.round(centerY + offsetY * cellSize),
          patchRadius,
          width,
          height,
          pixels
        );
      }
      samples.push(robustColor(pixels));
    }
  }

  return samples;
}

function collectPatchPixels(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  width: number,
  height: number,
  pixels: RgbColor[]
): void {
  const left = Math.max(0, centerX - radius);
  const top = Math.max(0, centerY - radius);
  const sampleWidth = Math.min(width - left, radius * 2 + 1);
  const sampleHeight = Math.min(height - top, radius * 2 + 1);
  if (sampleWidth <= 0 || sampleHeight <= 0) return;
  const image = context.getImageData(left, top, sampleWidth, sampleHeight);

  for (let index = 0; index < image.data.length; index += 4) {
    pixels.push({
      r: image.data[index],
      g: image.data[index + 1],
      b: image.data[index + 2],
    });
  }
}

function robustColor(pixels: RgbColor[]): RgbColor {
  if (pixels.length === 0) {
    throw new Error("取樣範圍超出影像");
  }

  const median = {
    r: channelMedian(pixels, "r"),
    g: channelMedian(pixels, "g"),
    b: channelMedian(pixels, "b"),
  };

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const pixel of pixels) {
    if (rgbDistance(pixel, median) > INLIER_DISTANCE) continue;
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
    count += 1;
  }

  if (count === 0) return median;
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function channelMedian(pixels: readonly RgbColor[], channel: keyof RgbColor): number {
  const values = pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
}

function rgbDistance(a: RgbColor, b: RgbColor): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}
