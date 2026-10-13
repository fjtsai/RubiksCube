export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

// 影像來源上的正方形取樣範圍（來源像素座標）。
export interface SampleRegion {
  left: number;
  top: number;
  size: number;
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
// 沒有對位資訊時（例如測試照片）預設取畫面中央 64% 的正方形。
const DEFAULT_REGION_RATIO = 0.64;
const CAPTURE_RESOLUTION = 360;

export function defaultSampleRegion(width: number, height: number): SampleRegion {
  const size = Math.min(width, height) * DEFAULT_REGION_RATIO;
  return { left: (width - size) / 2, top: (height - size) / 2, size };
}

// 相機畫面以 object-fit: cover 鋪滿螢幕，畫面上的對位框跟影片實際像素不是同一個座標系。
// 把對位框在螢幕上的位置換算回影片像素，取樣範圍才會跟使用者看到的框線完全一致。
export function videoRegionForElement(video: HTMLVideoElement, frame: Element): SampleRegion {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const videoRect = video.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  if (videoWidth <= 0 || videoHeight <= 0 || videoRect.width <= 0 || videoRect.height <= 0) {
    throw new Error("相機畫面尚未準備好");
  }

  const scale = Math.max(videoRect.width / videoWidth, videoRect.height / videoHeight);
  const offsetX = (videoRect.width - videoWidth * scale) / 2;
  const offsetY = (videoRect.height - videoHeight * scale) / 2;
  const left = (frameRect.left - videoRect.left - offsetX) / scale;
  const top = (frameRect.top - videoRect.top - offsetY) / scale;
  const size = Math.min(frameRect.width, frameRect.height) / scale;
  return clampRegion({ left, top, size }, videoWidth, videoHeight);
}

export function sampleThreeByThreeFromVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  region?: SampleRegion
): RgbColor[] {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("相機畫面尚未準備好");
  }

  return sampleThreeByThreeFromSource(video, width, height, canvas, region);
}

export function sampleThreeByThreeFromImage(image: HTMLImageElement, canvas: HTMLCanvasElement): RgbColor[] {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("測試照片尚未載入完成");
  }

  return sampleThreeByThreeFromSource(image, width, height, canvas);
}

// 先把取樣範圍縮放畫進固定大小的畫布，再一次讀出像素：
// 不管相機解析度多高，每格的取樣像素數都一樣，即時預覽也夠快。
export function sampleThreeByThreeFromSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  region: SampleRegion = defaultSampleRegion(width, height),
  resolution = CAPTURE_RESOLUTION
): RgbColor[] {
  const area = clampRegion(region, width, height);
  canvas.width = resolution;
  canvas.height = resolution;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("無法讀取影像畫面");
  }

  context.drawImage(source, area.left, area.top, area.size, area.size, 0, 0, resolution, resolution);
  const image = context.getImageData(0, 0, resolution, resolution);

  const cellSize = resolution / 3;
  const patchRadius = Math.max(1, Math.round(cellSize * 0.055));
  const samples: RgbColor[] = [];

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const centerX = cellSize * (col + 0.5);
      const centerY = cellSize * (row + 0.5);
      const pixels: RgbColor[] = [];
      for (const [offsetX, offsetY] of CELL_SAMPLE_OFFSETS) {
        collectPatchPixels(
          image,
          Math.round(centerX + offsetX * cellSize),
          Math.round(centerY + offsetY * cellSize),
          patchRadius,
          pixels
        );
      }
      samples.push(robustColor(pixels));
    }
  }

  return samples;
}

function clampRegion(region: SampleRegion, width: number, height: number): SampleRegion {
  const size = Math.max(9, Math.min(region.size, width, height));
  return {
    left: Math.min(Math.max(0, region.left), width - size),
    top: Math.min(Math.max(0, region.top), height - size),
    size,
  };
}

function collectPatchPixels(image: ImageData, centerX: number, centerY: number, radius: number, pixels: RgbColor[]): void {
  const left = Math.max(0, centerX - radius);
  const right = Math.min(image.width - 1, centerX + radius);
  const top = Math.max(0, centerY - radius);
  const bottom = Math.min(image.height - 1, centerY + radius);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = (y * image.width + x) * 4;
      pixels.push({
        r: image.data[index],
        g: image.data[index + 1],
        b: image.data[index + 2],
      });
    }
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
