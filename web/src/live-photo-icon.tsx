// Artwork: https://support.apple.com/zh-cn/104966
export function LivePhotoIcon({ size = 24 }: { size?: number }) {
  return (
    <span
      className="live-photo-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
