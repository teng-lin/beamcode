import { useState } from "react";

// Only safe raster image types — SVG excluded (can contain embedded scripts)
const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface ImageBlockProps {
  mediaType: string;
  data: string;
}

export function ImageBlock({ mediaType, data }: ImageBlockProps) {
  const [broken, setBroken] = useState(false);

  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return null;

  if (broken) {
    return (
      <div className="rounded-lg border border-bc-border/40 px-3 py-2 text-xs text-bc-text-muted opacity-50 italic">
        [Image could not be displayed]
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-bc-border/40 overflow-hidden">
      <img
        src={`data:${mediaType};base64,${data}`}
        alt="Generated content"
        className="max-w-full block"
        onError={() => setBroken(true)}
      />
    </div>
  );
}
